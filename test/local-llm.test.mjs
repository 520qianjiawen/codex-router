import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "local-llm-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_LOCAL_DOWNLOAD_STATE = path.join(stateDir, "download.json");
process.env.MODEL_ROUTER_LOCAL_BENCHMARKS = path.join(stateDir, "benchmarks.json");
process.env.MODEL_ROUTER_OLLAMA_RUNTIME_STATE = path.join(stateDir, "runtime.json");
process.env.MODEL_ROUTER_OLLAMA_LOG = path.join(stateDir, "ollama.log");

const {
  canonicalLocalModelTag,
  localModelDisplayName,
  normalizeLocalModelTag,
  splitLocalModelTag,
} = await import("../src/local-model-ref.mjs");
const {
  ensureOllamaHeadless,
  localOllamaRuntimeSnapshot,
  ollamaHostForUrl,
  ollamaInstallPlan,
  ollamaUpdatePlan,
  parseOllamaVersion,
  probeOllama,
} = await import("../src/ollama-runtime.mjs");
const { benchmarkLocalModel, readLocalBenchmarks } = await import("../src/local-benchmark.mjs");
const {
  downloadLocalModel,
  readLocalDownload,
  reconcileLocalDownload,
} = await import("../src/local-download.mjs");
const {
  readVisionBridgeSettings,
  setVisionBridgeEnabled,
  setVisionBridgeEngine,
} = await import("../src/vision-bridge-state.mjs");

test("Ollama model URLs normalize to explicit family and variant tags", () => {
  assert.equal(normalizeLocalModelTag("gemma4:12b"), "gemma4:12b");
  assert.equal(normalizeLocalModelTag("https://ollama.com/library/muse-glimmer"), "muse-glimmer:latest");
  assert.equal(
    normalizeLocalModelTag("https://ollama.com/frob/deepseek-v4-flash:284b-a13b-mxfp4"),
    "frob/deepseek-v4-flash:284b-a13b-mxfp4",
  );
  assert.deepEqual(splitLocalModelTag("hf.co/acme/model:Q4_K_M"), {
    tag: "hf.co/acme/model:Q4_K_M",
    name: "hf.co/acme/model",
    model: "model",
    namespace: "hf.co/acme",
    variant: "Q4_K_M",
    family: "hf.co/acme/model",
  });
  assert.equal(localModelDisplayName("gemma4:12b"), "Gemma4 · 12b");
  assert.throws(() => normalizeLocalModelTag("https://example.com/model"), /Ollama model-page/);
  // A family overview page carries no tag, so it must be rejected rather than
  // guessed at. The namespace form is the only two-segment shape that is one.
  assert.throws(
    () => normalizeLocalModelTag("https://ollama.com/library"),
    /does not contain an Ollama model tag/,
  );
  assert.throws(
    () => normalizeLocalModelTag("https://ollama.com/search/gemma"),
    /does not contain an Ollama model tag/,
  );
});

test("tag spellings canonicalize so one model is never two entries", () => {
  assert.equal(canonicalLocalModelTag("devstral"), "devstral:latest");
  assert.equal(canonicalLocalModelTag("devstral:latest"), "devstral:latest");
  assert.equal(canonicalLocalModelTag(" gemma4:12b "), "gemma4:12b");
  assert.equal(
    canonicalLocalModelTag("https://ollama.com/library/muse-glimmer"),
    "muse-glimmer:latest",
  );
  // Unparseable input is inert rather than fatal: this runs over stored state,
  // and one corrupt entry must not break reading the rest of the file.
  assert.equal(canonicalLocalModelTag("--force"), "--force");
  assert.equal(canonicalLocalModelTag(""), "");
  assert.equal(canonicalLocalModelTag(undefined), "");
});

test("runtime helpers keep Ollama headless and expose safe install plans", () => {
  assert.equal(parseOllamaVersion("ollama version is 0.32.6"), "0.32.6");
  assert.equal(ollamaHostForUrl("http://127.0.0.1:11434/v1"), "127.0.0.1:11434");
  assert.equal(ollamaHostForUrl("http://localhost/v1"), "localhost:11434");
  assert.equal(ollamaHostForUrl("https://example.com/v1"), undefined);

  const fakeSpawn = (command, args) => {
    if (command === "brew" && args[0] === "--version") return { status: 0 };
    if (command === "ollama" && args[0] === "--version") {
      return { status: 0, stdout: "ollama version is 0.32.6", stderr: "" };
    }
    return { status: 1 };
  };
  assert.deepEqual(ollamaInstallPlan({ platform: "darwin", spawn: fakeSpawn }).args, [
    "install",
    "ollama",
  ]);
  assert.equal(
    ollamaInstallPlan({ platform: "linux", spawn: fakeSpawn, interactive: true }).command,
    "sh",
  );
  assert.equal(
    ollamaInstallPlan({ platform: "linux", spawn: fakeSpawn, interactive: false }).command,
    undefined,
  );
  const policyKitSpawn = (command, args) => {
    if (command === "pkexec" && args[0] === "--version") return { status: 0 };
    return fakeSpawn(command, args);
  };
  assert.equal(
    ollamaInstallPlan({ platform: "linux", spawn: policyKitSpawn, interactive: false }).command,
    "pkexec",
  );
  const noPackageManager = () => ({ status: 1 });
  assert.equal(
    ollamaInstallPlan({ platform: "darwin", spawn: noPackageManager, interactive: false }).command,
    "/usr/bin/osascript",
  );
  // Every macOS path that runs the official installer must keep it headless.
  // Without OLLAMA_NO_START the installer launches the Ollama desktop app, and
  // the router would end up talking to a GUI process it does not own.
  for (const interactive of [true, false]) {
    const plan = ollamaInstallPlan({ platform: "darwin", spawn: noPackageManager, interactive });
    assert.ok(
      plan.args.some((argument) => argument.includes("OLLAMA_NO_START=1")),
      `darwin interactive=${interactive} must not start the Ollama app`,
    );
  }
  // Homebrew installs the headless CLI formula, never the desktop cask.
  assert.deepEqual(ollamaInstallPlan({ platform: "darwin", spawn: fakeSpawn }).args, [
    "install",
    "ollama",
  ]);
});

test("runtime updates use Homebrew only when it owns the Ollama formula", () => {
  const officialSpawn = (command, args) => {
    if (command === "ollama" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "list") return { status: 1 };
    return { status: 1 };
  };
  assert.equal(
    ollamaUpdatePlan({
      platform: "darwin",
      spawn: officialSpawn,
      interactive: false,
      resolveCommand: () => "/Applications/Ollama.app/Contents/Resources/ollama",
    }).source,
    "official-app",
  );
  assert.equal(
    ollamaUpdatePlan({
      platform: "darwin",
      spawn: officialSpawn,
      interactive: false,
      resolveCommand: () => "/Applications/Ollama.app/Contents/Resources/ollama",
    }).command,
    "/usr/bin/osascript",
  );
  const homebrewSpawn = (command, args) => {
    if (command === "ollama" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "list") return { status: 0 };
    return { status: 1 };
  };
  assert.equal(
    ollamaUpdatePlan({
      platform: "darwin",
      spawn: homebrewSpawn,
      resolveCommand: () => "/opt/homebrew/Cellar/ollama/0.32.6/bin/ollama",
    }).source,
    "homebrew",
  );
  const caskSpawn = (command, args) => {
    if (command === "ollama" && args[0] === "--version") return { status: 0 };
    if (command === "brew" && args[0] === "--version") return { status: 0 };
    if (
      command === "brew" &&
      args[0] === "list" &&
      args[1] === "--cask" &&
      args[2] === "ollama-app"
    ) {
      return { status: 0 };
    }
    return { status: 1 };
  };
  assert.deepEqual(
    ollamaUpdatePlan({
      platform: "darwin",
      spawn: caskSpawn,
      resolveCommand: () => "/Applications/Ollama.app/Contents/Resources/ollama",
    }),
    {
      command: "brew",
      args: ["upgrade", "--cask", "ollama-app"],
      source: "homebrew-cask",
    },
  );
});

test("noninteractive Linux updates require PolicyKit or an interactive terminal", () => {
  const withoutPolicyKit = (command, args) => {
    if (command === "ollama" && args[0] === "--version") return { status: 0 };
    return { status: 1 };
  };
  assert.throws(
    () => ollamaUpdatePlan({ platform: "linux", spawn: withoutPolicyKit, interactive: false }),
    /administrator permission/,
  );
  assert.equal(
    ollamaUpdatePlan({ platform: "linux", spawn: withoutPolicyKit, interactive: true }).command,
    "sh",
  );
});

test("runtime status verifies the daemon instead of trusting managed state", () => {
  const fakeSpawn = (command, args) => {
    assert.equal(command, "ollama");
    if (args[0] === "--version") {
      return { status: 0, stdout: "ollama version is 0.32.6", stderr: "" };
    }
    assert.deepEqual(args, ["list"]);
    return { status: 1, stdout: "", stderr: "connection refused" };
  };
  const snapshot = localOllamaRuntimeSnapshot({ spawn: fakeSpawn, platform: "linux" });
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.managed, false);
});

test("stale or dead local download workers become retryable errors", () => {
  const alive = reconcileLocalDownload(
    {
      version: 1,
      tag: "gemma4:12b",
      status: "downloading",
      startedAt: 1_000,
      updatedAt: 1_900,
      workerPid: 42,
    },
    { now: 2_000, kill: () => {}, persist: false },
  );
  assert.equal(alive.status, "downloading");

  const dead = reconcileLocalDownload(
    {
      version: 1,
      tag: "gemma4:12b",
      status: "downloading",
      startedAt: 1_000,
      updatedAt: 1_900,
      workerPid: 42,
    },
    {
      now: 2_000,
      kill: () => {
        const error = new Error("missing");
        error.code = "ESRCH";
        throw error;
      },
      persist: false,
    },
  );
  assert.equal(dead.status, "error");
  assert.equal(dead.detail, "interrupted");
  assert.match(dead.error, /Retry the install/);

  const stale = reconcileLocalDownload(
    {
      version: 1,
      tag: "gemma4:12b",
      status: "downloading",
      startedAt: 1_000,
      updatedAt: 1_000,
      workerPid: 42,
    },
    { now: 1_000_000, kill: () => {}, timeoutMs: 10_000, persist: false },
  );
  assert.equal(stale.status, "error");

  const legacyStale = reconcileLocalDownload(
    {
      version: 1,
      tag: "gemma4:12b",
      status: "downloading",
      startedAt: 1_000,
      updatedAt: 1_000,
    },
    { now: 1_000_000, timeoutMs: 10_000, persist: false },
  );
  assert.equal(legacyStale.status, "error");
});

test("runtime probe and headless reuse never open the Ollama GUI", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return new Response(JSON.stringify({ models: [{ name: "gemma4:12b" }] }), { status: 200 });
  };
  const spawnSync = (command, args) => {
    assert.equal(command, "ollama");
    assert.deepEqual(args, ["--version"]);
    return { status: 0, stdout: "ollama version is 0.32.6", stderr: "" };
  };
  assert.deepEqual(await probeOllama({ fetchImpl }), {
    reachable: true,
    models: ["gemma4:12b"],
  });
  const result = await ensureOllamaHeadless({ fetchImpl, spawnSyncImpl: spawnSync });
  assert.equal(result.running, true);
  assert.equal(result.managed, false);
  assert.equal(result.version, "0.32.6");
  assert.deepEqual(requests, ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/api/tags"]);
});

test("local speed benchmark records Ollama eval tokens per second", async () => {
  const result = await benchmarkLocalModel("gemma4:12b", {
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:11434/api/chat");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "gemma4:12b");
      assert.equal(body.stream, false);
      return new Response(
        JSON.stringify({
          total_duration: 3_000_000_000,
          load_duration: 1_000_000_000,
          prompt_eval_count: 20,
          prompt_eval_duration: 500_000_000,
          eval_count: 64,
          eval_duration: 2_000_000_000,
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(result.tokensPerSecond, 32);
  assert.equal(result.promptTokensPerSecond, 40);
  assert.equal(readLocalBenchmarks()["gemma4:12b"].speedStatus, "measured");
});

test("a completed local pull checks tool-capable models on automatically", async () => {
  const enabled = [];
  const restarts = [];
  const result = await downloadLocalModel("https://ollama.com/library/gemma4:12b", {
    ensureRuntime: async () => ({ running: true, managed: true }),
    pull: async (tag, { onProgress }) => {
      assert.equal(tag, "gemma4:12b");
      onProgress({ detail: "success", percent: 100 });
    },
    capabilitiesFor: () => ["completion", "tools"],
    enable: async (tag) => enabled.push(tag),
    restartService: async () => {
      restarts.push("restart");
      return true;
    },
    refreshCatalog: false,
  });
  assert.equal(result.status, "done");
  assert.deepEqual(enabled, ["gemma4:12b"]);
  // The running router only loads user models at startup, so a newly checked
  // local model must also restart the router or its first request falls
  // through to the native backend.
  assert.deepEqual(restarts, ["restart"]);
  assert.equal(readLocalDownload().detail, "ready");
});

test("control persists a visible terminal error when install preflight fails", () => {
  const childState = mkdtempSync(path.join(os.tmpdir(), "local-llm-control-"));
  const result = spawnSync(
    process.execPath,
    [path.resolve("src/control.mjs"), "local-models", "install", "status-probe:latest", "--yes"],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_ROUTER_STATE_DIR: childState,
        MODEL_ROUTER_LOCAL_DOWNLOAD_STATE: path.join(childState, "download.json"),
        MODEL_ROUTER_OLLAMA_RUNTIME_STATE: path.join(childState, "runtime.json"),
        MODEL_ROUTER_OLLAMA_LOG: path.join(childState, "ollama.log"),
        MODEL_ROUTER_LOCAL_BASE_URL: "https://example.com",
        MODEL_ROUTER_OLLAMA_REGISTRY: "http://127.0.0.1:9",
      },
    },
  );
  assert.notEqual(result.status, 0);
  const state = JSON.parse(readFileSync(path.join(childState, "download.json"), "utf8"));
  assert.equal(state.status, "error");
  assert.equal(state.detail, "failed");
  assert.match(state.error, /not loopback/);
});

// Runs `control local-models ...` against a throwaway state directory whose
// local endpoint is deliberately not loopback, so the command fails at a known
// point after argument parsing.
function runLocalModels(...args) {
  const childState = mkdtempSync(path.join(os.tmpdir(), "local-llm-args-"));
  const result = spawnSync(process.execPath, [path.resolve("src/control.mjs"), "local-models", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_ROUTER_STATE_DIR: childState,
      MODEL_ROUTER_LOCAL_DOWNLOAD_STATE: path.join(childState, "download.json"),
      MODEL_ROUTER_OLLAMA_RUNTIME_STATE: path.join(childState, "runtime.json"),
      MODEL_ROUTER_OLLAMA_LOG: path.join(childState, "ollama.log"),
      MODEL_ROUTER_LOCAL_BASE_URL: "https://example.com",
      MODEL_ROUTER_OLLAMA_REGISTRY: "http://127.0.0.1:9",
    },
  });
  return { ...result, childState, output: `${result.stdout || ""}${result.stderr || ""}` };
}

test("install accepts --yes and --force together, in either order", () => {
  // A single flag slot made these mutually exclusive, yet they answer different
  // questions: --yes consents to installing Ollama itself, --force to a model
  // this machine is rated too small for. Installing an oversized model on a
  // machine without Ollama needs both at once.
  for (const flags of [["--yes", "--force"], ["--force", "--yes"]]) {
    const result = runLocalModels("install", "flag-probe:latest", ...flags);
    assert.notEqual(result.status, 0);
    const state = JSON.parse(readFileSync(path.join(result.childState, "download.json"), "utf8"));
    // Reaching the loopback check proves both were read as flags rather than
    // mistaken for the tag, and that --yes was still honored beside --force.
    assert.match(state.error, /not loopback/, flags.join(" "));
  }
});

test("a missing Ollama is named as installable rather than reported as absent", () => {
  // Without --yes the command must say what to do next, not just that Ollama is
  // missing: one flag installs the runtime headlessly and then the model.
  const result = runLocalModels("install", "flag-probe:latest");
  assert.notEqual(result.status, 0);
  // On a machine that already has Ollama this reaches the loopback guard
  // instead; either way it must never claim the model started downloading.
  assert.match(result.output, /Re-run with --yes|not loopback/);
});

test("the usage text names both consent flags", () => {
  const result = runLocalModels("no-such-action");
  assert.notEqual(result.status, 0);
  assert.match(result.output, /--force/);
  assert.match(result.output, /--yes/);
  assert.match(result.output, /install <tag-or-url>/);
});

test("a configured-off vision bridge is never re-enabled by a local pull", async () => {
  setVisionBridgeEnabled(false);
  const result = await downloadLocalModel("qwen2.5vl:3b", {
    ensureRuntime: async () => ({ running: true, managed: true }),
    pull: async () => {},
    capabilitiesFor: () => ["completion", "vision"],
    refreshCatalog: false,
  });
  assert.equal(result.adoptedVision, false);
  assert.equal(readVisionBridgeSettings().enabled, false);
});

test("a vision-only local pull is adopted as the first image reader, not a Codex chat route", async () => {
  setVisionBridgeEnabled(true);
  setVisionBridgeEngine(null);
  const result = await downloadLocalModel("qwen2.5vl:3b", {
    ensureRuntime: async () => ({ running: true, managed: true }),
    pull: async () => {},
    capabilitiesFor: () => ["completion", "vision"],
    enable: async () => assert.fail("vision-only model must not be published as chat"),
    refreshCatalog: false,
  });
  assert.equal(result.canChat, false);
  assert.equal(result.adoptedVision, true);
  assert.equal(readLocalDownload().detail, "ready for images");
});
