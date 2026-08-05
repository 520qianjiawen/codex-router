import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import {
  CALLER_SECRET_PATH,
  OPENCODE_CONFIG_PATH,
  OPENCODE_CONFIG_STATE_PATH,
  OPENCODE_PROVIDER_ID,
  PORTS,
  TARGET,
  loopback,
} from "./paths.mjs";
import { selectedListedModels } from "./provider-selection.mjs";

// Unlike Cursor, opencode keeps its settings in a plain JSON file that is
// explicitly designed to be merged rather than replaced. So this manager does
// edit it — but it owns exactly one key, provider["codex-router"], and every
// other key in the file is read back and written out untouched. A user who
// hand-edits their opencode.json must never lose that work to an enable or
// disable run.

const STATE_VERSION = 1;
const SCHEMA_URL = "https://opencode.ai/config.json";
const BACKUP_PATH = `${OPENCODE_CONFIG_PATH}.pre-codex-router`;

const command = process.argv[2] || "status";
const allowedCommands = new Set(["enable", "disable", "status"]);

if (TARGET !== "opencode") {
  throw new Error("opencode-config-manager.mjs requires MODEL_ROUTER_TARGET=opencode.");
}
if (!allowedCommands.has(command)) {
  console.error("Usage: opencode-config-manager.mjs enable|disable|status");
  process.exit(2);
}

function readState() {
  if (!existsSync(OPENCODE_CONFIG_STATE_PATH)) {
    return { version: STATE_VERSION, enabled: false };
  }
  let state;
  try {
    state = JSON.parse(readFileSync(OPENCODE_CONFIG_STATE_PATH, "utf8"));
  } catch {
    throw new Error(`Invalid opencode router state at ${OPENCODE_CONFIG_STATE_PATH}.`);
  }
  if (state.version !== STATE_VERSION || typeof state.enabled !== "boolean") {
    throw new Error(`Invalid opencode router state at ${OPENCODE_CONFIG_STATE_PATH}.`);
  }
  return state;
}

function writeState(enabled) {
  mkdirSync(path.dirname(OPENCODE_CONFIG_STATE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${OPENCODE_CONFIG_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: STATE_VERSION, enabled }, null, 2)}\n`,
    { mode: 0o600 },
  );
  protectPrivateFile(temporary);
  renameSync(temporary, OPENCODE_CONFIG_STATE_PATH);
}

// A malformed opencode.json is the user's file, not ours to repair or
// overwrite. Fail loudly instead of replacing it with our own.
function readOpencodeConfig() {
  if (!existsSync(OPENCODE_CONFIG_PATH)) return {};
  const raw = readFileSync(OPENCODE_CONFIG_PATH, "utf8").trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${OPENCODE_CONFIG_PATH} is not valid JSON. Fix or move it, then re-run.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${OPENCODE_CONFIG_PATH} must contain a JSON object.`);
  }
  return parsed;
}

function writeOpencodeConfig(config) {
  mkdirSync(path.dirname(OPENCODE_CONFIG_PATH), { recursive: true });
  const temporary = `${OPENCODE_CONFIG_PATH}.tmp.${process.pid}`;
  // The provider block carries the caller key, so keep the file owner-only.
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  protectPrivateFile(temporary);
  renameSync(temporary, OPENCODE_CONFIG_PATH);
}

function backupOnce() {
  if (!existsSync(OPENCODE_CONFIG_PATH) || existsSync(BACKUP_PATH)) return;
  copyFileSync(OPENCODE_CONFIG_PATH, BACKUP_PATH);
}

function callerKey() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error(
      `No caller secret at ${CALLER_SECRET_PATH}. Run the installer for this target first.`,
    );
  }
  const key = readFileSync(CALLER_SECRET_PATH, "utf8").trim();
  if (!key) throw new Error(`Caller secret at ${CALLER_SECRET_PATH} is empty.`);
  return key;
}

function providerBlock() {
  const models = {};
  for (const model of selectedListedModels()) {
    models[model.gatewayModel] = { name: model.displayName || model.gatewayModel };
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Codex Router (local)",
    options: {
      baseURL: loopback(PORTS.router, "/v1"),
      apiKey: callerKey(),
    },
    models,
  };
}

function enable() {
  backupOnce();
  const config = readOpencodeConfig();
  if (!config.$schema) config.$schema = SCHEMA_URL;
  const provider =
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? config.provider
      : {};
  provider[OPENCODE_PROVIDER_ID] = providerBlock();
  config.provider = provider;
  writeOpencodeConfig(config);
  writeState(true);
}

function disable() {
  const config = readOpencodeConfig();
  const provider = config.provider;
  if (provider && typeof provider === "object" && !Array.isArray(provider)) {
    delete provider[OPENCODE_PROVIDER_ID];
    // Leave no empty scaffolding behind that the user did not ask for.
    if (Object.keys(provider).length === 0) delete config.provider;
  }
  // Only rewrite a file that already exists; disabling must not create one.
  if (existsSync(OPENCODE_CONFIG_PATH)) writeOpencodeConfig(config);
  writeState(false);
}

// The caller key is deliberately absent here so status stays safe to log.
function statusPayload(state) {
  const config = existsSync(OPENCODE_CONFIG_PATH) ? readOpencodeConfig() : {};
  return {
    target: "opencode",
    enabled: state.enabled,
    configPath: OPENCODE_CONFIG_PATH,
    providerId: OPENCODE_PROVIDER_ID,
    providerPresent: Boolean(config.provider?.[OPENCODE_PROVIDER_ID]),
    baseUrl: loopback(PORTS.router, "/v1"),
    models: selectedListedModels().map((model) => model.gatewayModel),
  };
}

if (command === "enable") {
  enable();
} else if (command === "disable") {
  disable();
}

process.stdout.write(`${JSON.stringify(statusPayload(readState()))}\n`);
