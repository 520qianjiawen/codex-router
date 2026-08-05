import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { validCallerSecret } from "./caller-auth.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { grokCliPreflight } from "./grok-cli.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { waitForRouterHealth } from "./router-health.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  PORTS,
  SOURCE_ROOT,
  TARGET,
} from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import { providerSelectionStatus, selectedListedModels } from "./provider-selection.mjs";

if (TARGET !== "opencode") {
  throw new Error("opencode-doctor.mjs requires MODEL_ROUTER_TARGET=opencode.");
}

const checks = [];
const add = (status, name, detail, fix) => checks.push({ status, name, detail, fix });
const jsonOutput = process.argv.includes("--json");

function childJson(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `${script} exited with ${result.status}.`);
  }
  return JSON.parse(result.stdout);
}

function repair() {
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(SOURCE_ROOT, "install.ps1"),
            "-CheckoutInstall",
            "-Target",
            "opencode",
          ],
          { cwd: SOURCE_ROOT, env: process.env, stdio: "inherit" },
        )
      : spawnSync(path.join(SOURCE_ROOT, "bin", "install"), [], {
          cwd: SOURCE_ROOT,
          env: process.env,
          stdio: "inherit",
        });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Repair installer exited with ${result.status}.`);
}

function opencodeAppPath() {
  const configured = process.env.OPENCODE_BIN;
  if (configured && existsSync(configured)) return configured;
  const finder = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = spawnSync(finder, ["opencode"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const found = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
    return found || undefined;
  } catch {
    return undefined;
  }
}

function readableSecret(target) {
  if (!existsSync(target)) return false;
  try {
    return validCallerSecret(readFileSync(target, "utf8").trim());
  } catch {
    return false;
  }
}

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage: model-router opencode doctor [--json] [--fix]

Checks the local opencode OpenAI-compatible gateway without printing
credentials. --fix reinstalls generated files and the service. opencode's own
config is managed for the codex-router provider plus its generated subagents;
all other keys in opencode.json are left untouched.
`);
  process.exit(0);
}

if (process.argv.includes("--fix")) {
  try {
    repair();
    if (!jsonOutput) process.stdout.write("Repair completed; verifying the result.\n\n");
  } catch (error) {
    console.error(`opencode-router repair: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
add(
  major > 22 || (major === 22 && minor >= 19) ? "ok" : "fail",
  "Node.js",
  `${process.version}; 22.19 or newer required`,
  "Install Node.js 24 LTS, then rerun the opencode installer.",
);

const opencode = opencodeAppPath();
add(
  opencode ? "ok" : "warn",
  "opencode",
  opencode || "not found on PATH",
  "Install opencode or set OPENCODE_BIN; the router still runs without it.",
);

let selection = { providers: [] };
let models = [];
try {
  selection = providerSelectionStatus();
  models = selectedListedModels();
  add(
    selection.providers.length && models.length ? "ok" : "fail",
    "Enabled providers",
    selection.providers.length ? selection.providers.join(", ") : "none",
    "Run ./bin/model-router opencode setup --guided.",
  );
} catch (error) {
  add(
    "fail",
    "Enabled providers",
    error instanceof Error ? error.message : String(error),
    "Run opencode setup again to replace the invalid provider selection.",
  );
}

add(
  existsSync(LITELLM_CONFIG_PATH) ? "ok" : "fail",
  "Generated gateway config",
  LITELLM_CONFIG_PATH,
  "Run ./bin/model-router opencode doctor --fix.",
);

for (const [name, target] of [
  ["Internal service key", INTERNAL_SECRET_PATH],
  ["opencode caller key", CALLER_SECRET_PATH],
]) {
  const valid = readableSecret(target);
  const protectedFile = valid && privateFileIsProtected(target);
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
  add(
    protectedFile ? "ok" : "fail",
    name,
    mode === undefined
      ? "missing"
      : !valid
        ? "invalid"
        : process.platform === "win32"
          ? "current-user Windows ACL"
          : `mode ${mode.toString(8)}`,
    "Run ./bin/model-router opencode doctor --fix.",
  );
}

const oauth = kimiOAuthStatus();
add(
  oauth.configured ? "ok" : selection.providers.includes("kimi-oauth") ? "fail" : "warn",
  "Kimi OAuth",
  oauth.configured ? "credential present" : `not configured; ${oauth.setup}`,
  "Run kimi login, then rerun the doctor.",
);
const grokOauth = grokOAuthStatus();
const grokCli = grokCliPreflight();
const grokOauthReady = grokOauth.configured && grokCli.runnable;
add(
  grokOauthReady ? "ok" : selection.providers.includes("grok-oauth") ? "fail" : "warn",
  "Grok OAuth",
  !grokCli.runnable
    ? grokCli.detail
    : grokOauth.configured
      ? grokOauth.source
      : `not configured; ${grokOauth.setup}`,
  !grokCli.runnable ? grokCli.fix : "Run grok login, then rerun the doctor.",
);
for (const provider of PROVIDERS.values()) {
  if (provider.kind !== "openai-compatible") continue;
  const credential = credentialStatus(provider, { persistent: true });
  add(
    credential.configured ? "ok" : selection.providers.includes(provider.id) ? "fail" : "warn",
    `${provider.displayName} key`,
    credential.configured ? credential.source : "not configured",
    `Run ./bin/model-router opencode provider-key ${provider.id} set.`,
  );
}

try {
  const config = childJson("opencode-config-manager.mjs", ["status"]);
  const missing = config.subagents.filter((agent) => !agent.present).map((agent) => agent.name);
  add(
    config.enabled && config.providerPresent ? "ok" : "fail",
    "opencode integration",
    config.enabled && config.providerPresent
      ? `${config.models.length} models at ${config.baseUrl}`
      : `${config.enabled ? "enabled" : "not enabled"}; provider present: ${config.providerPresent}`,
    "Run ./bin/model-router opencode setup --guided.",
  );
  add(
    missing.length ? "fail" : "ok",
    "opencode subagents",
    missing.length
      ? `${missing.length} missing from ${config.configPath}: ${missing.join(", ")}`
      : `${config.subagents.length} current in ${config.configPath}`,
    "Run ./bin/model-router opencode doctor --fix.",
  );
} catch (error) {
  add(
    "fail",
    "opencode integration",
    error instanceof Error ? error.message : String(error),
    "Run ./bin/model-router opencode setup --guided.",
  );
}

let serviceLoaded = false;
try {
  const service = childJson("service.mjs", ["status"]);
  serviceLoaded = Boolean(service.loaded);
  add(
    service.loaded ? "ok" : "fail",
    "opencode router service",
    service.state || "stopped",
    "Run ./bin/model-router opencode enable.",
  );
} catch (error) {
  add(
    "fail",
    "opencode router service",
    error instanceof Error ? error.message : "not available",
    "Run the opencode installer again.",
  );
}

const health = await waitForRouterHealth({ timeoutMs: serviceLoaded ? 30_000 : 2_000 });
add(
  health.ok ? "ok" : "fail",
  "opencode router health",
  health.ok
    ? `version ${health.payload.version}`
    : `not ready on 127.0.0.1:${PORTS.router} after ${serviceLoaded ? 30 : 2} seconds; ${health.error}`,
  "Run ./bin/model-router opencode doctor --fix.",
);

if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), target: "opencode", checks }, null, 2)}\n`,
  );
} else {
  for (const check of checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
    if (check.status === "fail" && check.fix) process.stdout.write(`      Fix: ${check.fix}\n`);
  }
}
if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
