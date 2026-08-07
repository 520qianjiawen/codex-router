import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import { PROVIDER_SELECTION_PATH, STATE_DIR, TARGET } from "./paths.mjs";
import { LISTED_MODELS, PROVIDERS } from "./model-registry.mjs";
import { targetCli } from "./target-integration.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { credentialStatus } from "./provider-credentials.mjs";

const RETIRED_PROVIDER_ALIASES = new Map([["chatgpt-oauth", "grok-oauth"]]);

function providerIds() {
  return [...PROVIDERS.keys()];
}

// Protocol variants (registry `variantOf`) share their parent's credential and
// must never be selectable apart from it: the selection file stores only
// canonical parent ids, and every read expands a parent back into its family.
// That way a selection written before a variant existed still exposes it.
export function canonicalProviderId(id) {
  return PROVIDERS.get(id)?.variantOf || id;
}

function expandProviderIds(ids) {
  const selected = new Set(ids);
  for (const provider of PROVIDERS.values()) {
    if (provider.variantOf && selected.has(provider.variantOf)) {
      selected.add(provider.id);
    }
  }
  return [...selected];
}

export function validateProviderIds(values) {
  const named = values
    .map((value) => String(value).trim())
    .filter(Boolean)
    .map((value) => RETIRED_PROVIDER_ALIASES.get(value) || value);
  for (const id of named) {
    if (!PROVIDERS.has(id)) throw new Error(`Unknown provider: ${id}`);
  }
  return [...new Set(named.map((id) => canonicalProviderId(id)))];
}

export function configuredProviderIds() {
  const configured = [];
  for (const provider of PROVIDERS.values()) {
    if (provider.kind === "oauth") {
      if (provider.id === "kimi-oauth" && kimiOAuthStatus().configured) {
        configured.push(provider.id);
      } else if (provider.id === "grok-oauth" && grokOAuthStatus().configured) {
        configured.push(provider.id);
      }
    } else if (credentialStatus(provider, { persistent: true }).configured) {
      configured.push(provider.id);
    }
  }
  return configured;
}

export function readProviderSelection() {
  if (
    process.env.MODEL_ROUTER_SHOW_ALL_MODELS === "1" ||
    (TARGET === "codex" && process.env.CODEX_ROUTER_SHOW_ALL_MODELS === "1")
  ) {
    return providerIds();
  }
  if (!existsSync(PROVIDER_SELECTION_PATH)) return providerIds();
  try {
    const parsed = JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.providers)) {
      throw new Error("version/providers are invalid");
    }
    return expandProviderIds(validateProviderIds(parsed.providers));
  } catch (error) {
    throw new Error(
      `Invalid provider selection ${PROVIDER_SELECTION_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// The last line of defence for the one-route rule: whoever assembled the list
// (the tray, `providers enable`, an installer flag, ensure-configured), a
// selection that reaches disk never names two routes into the same account.
// The stored-key route wins a tie because it is the one an operator had to set
// up deliberately.
function singleRoutePerAccount(ids) {
  const winnerByFamily = new Map();
  for (const id of ids) {
    const family = PROVIDERS.get(id)?.authVariantOf ?? id;
    const winner = winnerByFamily.get(family);
    // The source id equals its own family key, so it takes the slot whenever
    // it appears; otherwise the first auth variant named wins.
    if (winner === undefined || id === family) winnerByFamily.set(family, id);
  }
  const kept = new Set(winnerByFamily.values());
  return ids.filter((id) => kept.has(id));
}

export function writeProviderSelection(values) {
  const providers = singleRoutePerAccount(validateProviderIds(values));
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  const temporary = `${PROVIDER_SELECTION_PATH}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: 1, providers }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  protectPrivateFile(temporary);
  renameSync(temporary, PROVIDER_SELECTION_PATH);
  protectPrivateFile(PROVIDER_SELECTION_PATH);
  return providers;
}

// Enable/disable act on the whole variant family: toggling opencode-go (or any
// of its protocol variants) shows or hides every model that key can serve.
// Auth variants are the same account and the same catalog reached with a
// different credential, so showing both would list every model twice in the
// picker with no way to tell the copies apart. Enabling one route retires the
// other rather than leaving that to the operator to notice.
function competingAuthRoutes(providerId) {
  const target = canonicalProviderId(providerId);
  const provider = PROVIDERS.get(target);
  if (!provider) return [];
  const family = provider.authVariantOf || target;
  return [...PROVIDERS.values()]
    .filter((candidate) => candidate.variantOf === undefined)
    .map((candidate) => candidate.id)
    .filter((id) => id !== target)
    .filter((id) => id === family || PROVIDERS.get(id)?.authVariantOf === family);
}

export function enableProvider(providerId) {
  const current = existsSync(PROVIDER_SELECTION_PATH)
    ? readProviderSelection()
    : configuredProviderIds();
  const retired = new Set(competingAuthRoutes(providerId));
  return writeProviderSelection([
    ...current.filter((id) => !retired.has(canonicalProviderId(id))),
    providerId,
  ]);
}

// Names the routes enableProvider would retire, so the CLI and the tray can
// say what happened instead of silently changing a second row.
export function displacedAuthRoutes(providerId) {
  const current = existsSync(PROVIDER_SELECTION_PATH)
    ? readProviderSelection()
    : configuredProviderIds();
  const selected = new Set(current.map((id) => canonicalProviderId(id)));
  return competingAuthRoutes(providerId).filter((id) => selected.has(id));
}

export function disableProvider(providerId) {
  const target = canonicalProviderId(providerId);
  const current = existsSync(PROVIDER_SELECTION_PATH)
    ? readProviderSelection()
    : configuredProviderIds();
  return writeProviderSelection(
    current.filter((id) => canonicalProviderId(id) !== target),
  );
}

export function selectedListedModels() {
  const selected = new Set(readProviderSelection());
  return LISTED_MODELS.filter((model) => selected.has(model.provider));
}

export function selectedConfiguredListedModels() {
  const selected = new Set(readProviderSelection());
  const configured = new Set(configuredProviderIds());
  return LISTED_MODELS.filter(
    (model) => selected.has(model.provider) && configured.has(model.provider),
  );
}

export function providerSelectionStatus() {
  return {
    path: PROVIDER_SELECTION_PATH,
    explicit: existsSync(PROVIDER_SELECTION_PATH),
    providers: readProviderSelection(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] || "status";
    if (command === "status") {
      process.stdout.write(`${JSON.stringify(providerSelectionStatus(), null, 2)}\n`);
    } else if (command === "set") {
      const values = process.argv.slice(3).flatMap((value) => value.split(","));
      process.stdout.write(
        `${JSON.stringify({ providers: writeProviderSelection(values) }, null, 2)}\n`,
      );
    } else if (command === "ensure-configured") {
      const providers = existsSync(PROVIDER_SELECTION_PATH)
        ? readProviderSelection()
        : writeProviderSelection(configuredProviderIds());
      if (providers.length === 0) {
        throw new Error(
          `No provider credential is configured. Run ${
            targetCli("setup --guided")
          } before installing.`,
        );
      }
      const configured = new Set(configuredProviderIds());
      const missing = providers.filter((provider) => !configured.has(provider));
      if (missing.length) {
        throw new Error(
          `Selected providers need persistent authentication: ${missing.join(", ")}. Run ${
            targetCli("setup --guided")
          }.`,
        );
      }
      process.stdout.write(`${JSON.stringify({ providers }, null, 2)}\n`);
    } else {
      console.error(
        "Usage: provider-selection.mjs status|set [provider,...]|ensure-configured",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
