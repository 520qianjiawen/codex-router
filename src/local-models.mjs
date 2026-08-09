import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import {
  disableProvider,
  enableProvider,
  readProviderSelection,
} from "./provider-selection.mjs";
import { STATE_DIR } from "./paths.mjs";
import { readUserModels, userModelEntry, writeUserModels } from "./user-models.mjs";


// Local models are the operator's own software running on their own machine, so
// the router only ever reads and reports what Ollama already has. Installing and
// removing are explicit operator actions, never side effects of a refresh.

export const LOCAL_MODELS_STATE_PATH =
  process.env.MODEL_ROUTER_LOCAL_MODELS_STATE ||
  path.join(STATE_DIR, "local-models.json");

function defaultSelection() {
  return { version: 1, enabled: [] };
}

// The checked set: which installed models the operator wants the router to
// treat as usable. Kept separate from "installed" so unchecking a model never
// deletes gigabytes, and separate from the vision engine pin so a model can be
// available without being the image reader.
export function readLocalModelSelection() {
  if (!existsSync(LOCAL_MODELS_STATE_PATH)) return defaultSelection();
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_MODELS_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.enabled)) {
      return { version: 1, enabled: parsed.enabled.filter((tag) => typeof tag === "string") };
    }
  } catch {
    // Corrupt selection falls back to "nothing checked", which is the state
    // every install starts in.
  }
  return defaultSelection();
}

function writeSelection(selection) {
  const dir = path.dirname(LOCAL_MODELS_STATE_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${LOCAL_MODELS_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, LOCAL_MODELS_STATE_PATH);
  protectPrivateFile(LOCAL_MODELS_STATE_PATH);
  return selection;
}

export const LOCAL_PROVIDER_ID = "local";

// Local models sort after every cloud model in the picker: they are slower and
// smaller, so they should not displace a paid flagship at the top of the list.
const LOCAL_MODEL_PRIORITY = 900;

// The overlay's default is 128K, which is wrong for a model running on the
// operator's own laptop: the KV cache for that window costs ~15 GB on a 3B
// model, overflows a 16 GB machine, and pushes half the work onto the CPU --
// measured here as 17 GB and 43% CPU versus 3.1 GB and 100% GPU at 8K, a six
// fold difference in wall clock. Codex sizes its prompts to the number
// advertised here, so advertising 128K asks a small local model for exactly
// the context that makes it unusable.
//
// This caps what Codex sends. It does not change what Ollama reserves: the
// OpenAI-compatible endpoint ignores `num_ctx`, so the allocation is set by
// Ollama's own OLLAMA_CONTEXT_LENGTH.
const LOCAL_CONTEXT_WINDOW = 32768;
const LOCAL_AUTO_COMPACT = 28000;

// Checking a model publishes it: it joins the user-model overlay, which the
// registry, gateway config, and Codex catalog already consume, so a local
// model reaches the picker through exactly the same path as any curated cloud
// model. Unchecking withdraws it again without touching the download.
export function setLocalModelEnabled(tag, enabled, { capabilitiesFor } = {}) {
  const value = String(tag || "").trim();
  if (!value) throw new Error("A model tag is required.");
  const current = new Set(readLocalModelSelection().enabled);
  if (enabled) current.add(value);
  else current.delete(value);
  const selection = writeSelection({ version: 1, enabled: [...current].sort() });
  syncLocalUserModels({ enabled: selection.enabled, ...(capabilitiesFor ? { capabilitiesFor } : {}) });
  // Checking a model is the operator saying they want it available, so the
  // provider follows the models rather than being a second switch to find:
  // it turns on with the first check and off when the last one clears.
  syncLocalProviderSelection(selection.enabled.length > 0);
  return selection;
}

// Deliberately failure-tolerant. The selection file is shared state that other
// commands also write; if it cannot be updated the models are still published
// and the operator can enable the provider by hand, which beats failing the
// checkbox.
export function syncLocalProviderSelection(shouldEnable) {
  try {
    const enabled = readProviderSelection().includes(LOCAL_PROVIDER_ID);
    if (shouldEnable && !enabled) enableProvider(LOCAL_PROVIDER_ID);
    if (!shouldEnable && enabled) disableProvider(LOCAL_PROVIDER_ID);
    return shouldEnable;
  } catch {
    return undefined;
  }
}

// Rebuilds the overlay's local entries from the checked set, leaving every
// other curated model untouched. Declarative on purpose: the checked list is
// the source of truth, so a half-applied toggle cannot leave a stale entry
// advertising a model that is no longer selected.
export function syncLocalUserModels({
  enabled = readLocalModelSelection().enabled,
  capabilitiesFor = (tag) => localModelCapabilities(tag),
} = {}) {
  const others = readUserModels().filter((model) => model.provider !== LOCAL_PROVIDER_ID);
  // Codex drives every turn through tool calls. A model without them is not a
  // weaker chat model, it is a broken one: the first request comes back "does
  // not support tools". Such a model stays installed and stays usable as a
  // vision reader, but it is never published into the picker.
  const publishable = enabled.filter((tag) => capabilitiesFor(tag).includes("tools"));
  const entries = publishable.map((tag, index) => {
    const capabilities = capabilitiesFor(tag);
    return {
      ...userModelEntry({
        providerId: LOCAL_PROVIDER_ID,
        upstreamId: tag,
        priority: LOCAL_MODEL_PRIORITY + index,
        metadata: {
          // Reported by Ollama, so the entry claims image input only when the
          // model genuinely has it -- the same standard the checked-in
          // registry is held to.
          inputModalities: capabilities.includes("vision") ? ["text", "image"] : ["text"],
          contextWindow: LOCAL_CONTEXT_WINDOW,
          autoCompact: LOCAL_AUTO_COMPACT,
          description: `${tag} running locally through Ollama on this machine.`,
        },
      }),
      // Marked experimental in the picker itself. Vision is proven -- a local
      // model transcribes an image accurately every time -- but driving a
      // Codex turn is not: a model can pass this check and fail the same one
      // minutes later, and the label has to say so where the choice is made,
      // not only in a doc nobody opens mid-task.
      displayName: `${tag} (local, experimental)`,
      // Codex's apply_patch is a freeform custom tool, which has no
      // representation in Ollama's tool schema: it arrives mangled or not at
      // all, and the model is left guessing at a toolset it cannot see. Opting
      // out keeps every tool a plain function, which Ollama does support.
      // Observed without this: llama3.2:3b inventing a `create_goal` call and
      // emitting it as prose.
      supportsApplyPatchTool: false,
      // Driving subagents is a harder job than answering a turn, and no local
      // model has been shown to do it here. Claiming v2 would offer them as
      // spawn targets on that untested basis.
      multiAgentVersion: "v1",
    };
  });
  writeUserModels([...others, ...entries]);
  return entries;
}

const REGISTRY_BASE =
  process.env.MODEL_ROUTER_OLLAMA_REGISTRY || "https://registry.ollama.ai";

// Tool support before the download, so nobody spends gigabytes on a model
// Codex can never drive. Ollama bakes tool calling into the chat template, and
// the registry serves that template as its own layer -- so fetching a few
// kilobytes answers what would otherwise cost a multi-gigabyte pull.
//
// A template mentioning `.Tools` is necessary but not sufficient: qwen2.5-coder
// has it and still emits tool calls as plain text. So this reports "the model
// claims tools", and only a real request proves it.
export async function fetchRegistryCapabilities(tag, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const [name, version = "latest"] = String(tag).split(":");
  if (!name) return undefined;
  const base = `${REGISTRY_BASE}/v2/library/${encodeURIComponent(name)}`;
  try {
    const manifest = await fetchImpl(
      `${base}/manifests/${encodeURIComponent(version)}`,
      {
        headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!manifest.ok) return undefined;
    const parsed = await manifest.json();
    const layers = Array.isArray(parsed?.layers) ? parsed.layers : [];
    const template = layers.find((layer) => layer?.mediaType?.endsWith(".template"));
    const bytes = layers.reduce((sum, layer) => sum + (layer?.size || 0), 0);
    // One tenth of a gigabyte on every path: the two early returns used to
    // hand back the raw quotient, so a model whose template could not be read
    // reported "18.556700222 GB" in the tray while its neighbours read "18.6".
    const sizeGb = Math.round((bytes / 1e9) * 10) / 10;
    if (!template?.digest) return { tag, tools: false, sizeGb };
    // Blob URLs redirect to a CDN, so the fetch has to follow them.
    const blob = await fetchImpl(`${base}/blobs/${template.digest}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!blob.ok) return { tag, tools: false, sizeGb };
    const text = await blob.text();
    return {
      tag,
      tools: /\{\{[^}]*\.Tools/i.test(text),
      sizeGb,
    };
  } catch {
    // Offline or an unknown tag: the install proceeds unannotated rather than
    // being blocked by a lookup that is only advisory.
    return undefined;
  }
}

export const AGENT_CHECK_PATH =
  process.env.MODEL_ROUTER_AGENT_CHECKS ||
  path.join(STATE_DIR, "local-agent-checks.json");

export function readAgentChecks() {
  try {
    const parsed = JSON.parse(readFileSync(AGENT_CHECK_PATH, "utf8"));
    return parsed?.version === 1 && parsed.results ? parsed.results : {};
  } catch {
    return {};
  }
}

export function saveAgentCheck(tag, result) {
  const results = { ...readAgentChecks(), [tag]: result };
  mkdirSync(path.dirname(AGENT_CHECK_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${AGENT_CHECK_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, results })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, AGENT_CHECK_PATH);
  return results;
}

export const CAPABILITY_CACHE_PATH =
  process.env.MODEL_ROUTER_LOCAL_CAPABILITY_CACHE ||
  path.join(STATE_DIR, "local-model-capabilities.json");

// Ollama reports what a model can actually do, which beats inferring it from
// the name: most small vision models cannot call tools, and a name says
// nothing about it. Codex is an agent -- it needs tool calls to edit files and
// run commands -- so publishing a toolless model gives the operator a picker
// entry that 400s on the first turn.
export function parseOllamaCapabilities(stdout) {
  const text = String(stdout || "");
  const section = text.split(/Capabilities/i)[1];
  if (!section) return [];
  const capabilities = [];
  for (const raw of section.split("\n").slice(1)) {
    const line = raw.trim();
    if (!line) break; // the capability block ends at the first blank line
    if (/^[A-Z]/.test(line)) break; // ...or at the next section heading
    capabilities.push(line.split(/\s+/)[0].toLowerCase());
  }
  return capabilities;
}

function readCapabilityCache() {
  try {
    const parsed = JSON.parse(readFileSync(CAPABILITY_CACHE_PATH, "utf8"));
    return parsed?.version === 1 && parsed.models ? parsed.models : {};
  } catch {
    return {};
  }
}

function writeCapabilityCache(models) {
  mkdirSync(path.dirname(CAPABILITY_CACHE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CAPABILITY_CACHE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, models })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, CAPABILITY_CACHE_PATH);
}

// Keyed by the model's content id, so a retagged or rebuilt model is re-read
// while an unchanged one costs no subprocess at all -- the tray polls this.
export function localModelCapabilities(tag, id, { spawn = spawnSync, cache } = {}) {
  const store = cache || readCapabilityCache();
  const key = id || tag;
  if (store[key]) return store[key];
  try {
    const result = spawn("ollama", ["show", tag], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    const capabilities = parseOllamaCapabilities(result.stdout);
    store[key] = capabilities;
    if (!cache) writeCapabilityCache(store);
    return capabilities;
  } catch {
    return [];
  }
}

// `ollama list` is a fixed-width table; the columns are name, id, size, and a
// human "modified" phrase that runs to the end of the line.
export function parseOllamaList(stdout) {
  return String(stdout || "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s{2,}/).filter(Boolean);
      const [tag, id, size, modified] = parts;
      if (!tag || !tag.includes(":")) return undefined;
      const gb = Number.parseFloat(String(size || "").replace(/[^\d.]/g, ""));
      return {
        tag,
        id: id || "",
        sizeGb: Number.isFinite(gb) ? gb : 0,
        modified: modified || "",
      };
    })
    .filter(Boolean);
}

export function localModelInventory({ spawn = spawnSync } = {}) {
  try {
    const result = spawn("ollama", ["list"], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return parseOllamaList(result.stdout);
  } catch {
    return [];
  }
}

// Which models Ollama currently holds in memory. Purely informational, but it
// is the difference between "installed" and "warm", and a cold model's first
// request pays a load penalty the operator should be able to see coming.
export function runningLocalModels({ spawn = spawnSync } = {}) {
  try {
    const result = spawn("ollama", ["ps"], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return parseOllamaList(result.stdout).map((entry) => entry.tag);
  } catch {
    return [];
  }
}

// Deleting reclaims gigabytes and cannot be undone without downloading again,
// so the caller must pass explicit consent rather than this inferring it.
export function removeLocalModel(tag, { spawn = spawnSync, confirmed = false, capabilitiesFor } = {}) {
  const value = String(tag || "").trim();
  if (!value) throw new Error("A model tag is required.");
  if (!confirmed) {
    throw new Error(`Removing ${value} deletes it from disk. Pass --yes to confirm.`);
  }
  const result = spawn("ollama", ["rm", value], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim();
    throw new Error(`\`ollama rm ${value}\` failed${detail ? `: ${detail}` : "."}`);
  }
  // A deleted model cannot stay checked, or the picker would offer something
  // that is no longer on disk.
  setLocalModelEnabled(value, false, capabilitiesFor ? { capabilitiesFor } : undefined);
  return value;
}

// One view the tray can render directly: what is installed, what is checked,
// what is loaded, and which ones can read images.
export function localModelsSnapshot({
  inventory = localModelInventory(),
  running = runningLocalModels(),
  selection = readLocalModelSelection(),
  benchmarks = {},
  capabilities,
  agentChecks = readAgentChecks(),
} = {}) {
  const enabled = new Set(selection.enabled);
  const runningSet = new Set(running);
  const cache = capabilities;
  const models = inventory.map((entry) => {
    const caps = cache
      ? cache[entry.tag] || []
      : localModelCapabilities(entry.tag, entry.id);
    return {
      ...entry,
      capabilities: caps,
      enabled: enabled.has(entry.tag),
      running: runningSet.has(entry.tag),
      // Reported by Ollama, not guessed from the name.
      vision: caps.includes("vision"),
      // Codex drives models through tool calls, so a model without them can
      // never be a chat model here -- only a vision reader for the bridge.
      tools: caps.includes("tools"),
      accuracy: benchmarks[entry.tag]?.tier,
      measured: benchmarks[entry.tag],
      // Whether the real Codex client could actually drive it. Unmeasured
      // stays unmeasured: a guess here is what sends someone into a task with
      // a model that invents tools.
      agent: agentChecks[entry.tag]?.verdict,
      agentCapable: agentChecks[entry.tag]?.agentCapable,
    };
  });
  // Without this the only way to install a model was to already know its tag,
  // which is no help to anyone who has never installed one. Rated for this
  // machine so the list cannot suggest something that will not run here.
  const available = suggestedLocalModels({ installed: models });
  return {
    path: LOCAL_MODELS_STATE_PATH,
    installed: models.length,
    enabled: models.filter((model) => model.enabled).length,
    usableAsChat: models.filter((model) => model.tools).length,
    totalGb: Math.round(models.reduce((sum, model) => sum + model.sizeGb, 0) * 10) / 10,
    models,
    available,
    machine: describeMachine(detectMachine()),
  };
}

// --- machine fit -----------------------------------------------------------

// Weights are not the whole cost: the KV cache, context, and runtime overhead
// need room beside them. A fifth on top is the common working estimate and is
// deliberately conservative, so a model reported as fitting actually runs.
const OVERHEAD_FACTOR = 1.2;

// Leave the operating system its own working set rather than pretending every
// byte of RAM is available to one process.
const SYSTEM_HEADROOM = 0.8;

// macOS lets the GPU wire roughly three quarters of unified memory.
const UNIFIED_GPU_SHARE = 0.75;

// Without a GPU the whole model sits in system memory beside everything else
// the machine is doing, so only the smaller part of the budget is comfortable.
const COMFORTABLE_CPU_SHARE = 0.6;

function nvidiaMemoryBytes() {
  try {
    const output = spawnSync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 3_000 },
    );
    if (output.status !== 0 || !output.stdout) return undefined;
    // Multi-GPU hosts report one line each; a model runs on one card.
    const largest = output.stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => right - left)[0];
    return largest ? largest * 1_048_576 : undefined;
  } catch {
    return undefined;
  }
}

// Pure, so ratings can be tested against machines this one is not.
export function machineCapacity({
  totalMemoryBytes,
  gpuMemoryBytes,
  unifiedMemory = false,
  platform = process.platform,
} = {}) {
  const total = Number(totalMemoryBytes) || 0;
  const systemBudget = Math.floor(total * SYSTEM_HEADROOM);
  const gpuBudget = unifiedMemory
    ? Math.floor(total * UNIFIED_GPU_SHARE)
    : Number(gpuMemoryBytes) || undefined;
  return {
    platform,
    totalMemoryBytes: total,
    unifiedMemory,
    gpuBudgetBytes: gpuBudget,
    // What runs at full speed, and what runs at all. With no GPU to fall back
    // from, "comfortable" is a fraction of RAM rather than all of it, or every
    // model reads as either fine or impossible and a 7B that will swap the
    // machine to a crawl is reported as a clean fit.
    fastBudgetBytes: gpuBudget || Math.floor(systemBudget * COMFORTABLE_CPU_SHARE),
    ceilingBytes: Math.max(gpuBudget || 0, systemBudget),
  };
}

export function detectMachine() {
  const unifiedMemory = process.platform === "darwin" && process.arch === "arm64";
  return machineCapacity({
    totalMemoryBytes: os.totalmem(),
    gpuMemoryBytes: unifiedMemory ? undefined : nvidiaMemoryBytes(),
    unifiedMemory,
  });
}

export function describeMachine(capacity) {
  const memory = capacity.unifiedMemory
    ? `${(capacity.totalMemoryBytes / 1e9).toFixed(1)} GB unified memory`
    : `${(capacity.totalMemoryBytes / 1e9).toFixed(1)} GB RAM`;
  const gpu = capacity.unifiedMemory
    ? `GPU budget ~${(capacity.gpuBudgetBytes / 1e9).toFixed(1)} GB`
    : capacity.gpuBudgetBytes
      ? `${(capacity.gpuBudgetBytes / 1e9).toFixed(1)} GB GPU memory`
      : "no GPU memory detected; models run on the CPU";
  return `${memory} · ${gpu}`;
}

// "fits" runs at full speed, "tight" runs but spills to the CPU, "too-large"
// cannot run here at all. Sizes come from the registry manifest, so this works
// for any tag rather than a list someone has to keep current.
export function rateModelFit(sizeGb, capacity = detectMachine()) {
  const bytes = Number(sizeGb) * 1e9;
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  const needed = bytes * OVERHEAD_FACTOR;
  if (needed <= capacity.fastBudgetBytes) return "fits";
  if (needed <= capacity.ceilingBytes) return "tight";
  return "too-large";
}

export function fitAdvisory(tag, sizeGb, capacity = detectMachine()) {
  const fit = rateModelFit(sizeGb, capacity);
  if (fit === "tight") {
    return `${tag} (${sizeGb} GB) is close to this machine's limit (${describeMachine(capacity)}); expect it to spill onto the CPU and run slowly.`;
  }
  if (fit === "too-large") {
    return `${tag} needs about ${Math.ceil(sizeGb * OVERHEAD_FACTOR)} GB to run and this machine has ${describeMachine(capacity)}.`;
  }
  return undefined;
}

// --- what is worth downloading ---------------------------------------------

// Nothing in the tray or the CLI answered "which models exist?", so the only
// way to install one was to already know its tag. This is a starting list, not
// a catalog: `tools` and `sizeGb` below were read from the registry manifests
// on 2026-08-09 with fetchRegistryCapabilities, and the live lookup still runs
// at install time, so a republished tag corrects itself there rather than
// silently disagreeing here.
//
// `tools` decides everything. Codex drives every turn through tool calls, so a
// model without them can only ever be a vision reader — and several popular
// coding models turn out not to have them.
export const SUGGESTED_LOCAL_MODELS = Object.freeze(
  [
    {
      tag: "qwen2.5-coder:1.5b",
      sizeGb: 1,
      tools: true,
      note: "Smallest coder; for machines with little to spare",
    },
    {
      tag: "llama3.2:3b",
      sizeGb: 2,
      tools: true,
      note: "Verified making a real tool call through the router",
    },
    {
      tag: "qwen2.5-coder:3b",
      sizeGb: 1.9,
      tools: true,
      note: "Small coder",
    },
    {
      tag: "gemma3:4b",
      sizeGb: 3.3,
      tools: false,
      note: "No tools — vision reader only",
    },
    {
      tag: "mistral:7b",
      sizeGb: 4.4,
      tools: true,
      note: "General purpose",
    },
    {
      tag: "qwen2.5-coder:7b",
      sizeGb: 4.7,
      tools: true,
      note: "Advertises tools but has returned them as plain text",
    },
    {
      tag: "llama3.1:8b",
      sizeGb: 4.9,
      tools: true,
      note: "General purpose baseline",
    },
    {
      tag: "qwen2.5-coder:14b",
      sizeGb: 9,
      tools: true,
      note: "Stronger coder",
    },
    {
      tag: "gpt-oss:20b",
      sizeGb: 13.8,
      tools: true,
      note: "Open thinking model",
    },
    {
      tag: "devstral",
      sizeGb: 14.3,
      tools: true,
      note: "Built for agentic coding",
    },
  ].map((entry) => Object.freeze(entry)),
);

// Rated for this machine and filtered against what is already downloaded, so
// the list only ever offers something the operator does not have and can run.
export function suggestedLocalModels({
  capacity = detectMachine(),
  installed = [],
  includeUnusable = false,
} = {}) {
  const have = new Set(installed.map((entry) => String(entry?.tag ?? entry)));
  return SUGGESTED_LOCAL_MODELS
    .map((entry) => ({ ...entry, fit: rateModelFit(entry.sizeGb, capacity) }))
    .filter((entry) => !have.has(entry.tag) && !have.has(`${entry.tag}:latest`))
    .filter((entry) => includeUnusable || entry.fit !== "too-large")
    .sort((left, right) => left.sizeGb - right.sizeGb);
}
