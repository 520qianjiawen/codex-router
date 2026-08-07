import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  grokCliFailureMessage,
  grokCliPath,
  grokCliPreflight,
} from "./grok-cli.mjs";
import { cliSessionStatus } from "./cli-session-credential.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { KIMI_CLI_NPM_PACKAGE } from "./kimi-oauth-onboarding.mjs";
import { MODELS, PROVIDERS } from "./model-registry.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import {
  apiProvider,
  credentialStatus,
  removeProviderCredential,
  storesKey,
  writeProviderCredential,
} from "./provider-credentials.mjs";
import { disableProvider } from "./provider-selection.mjs";

const SIGN_IN_CLIS = Object.freeze({
  "kimi-oauth": {
    executable: "kimi",
    npmPackage: KIMI_CLI_NPM_PACKAGE,
    loginArgs: ["login"],
    candidates: [path.join(os.homedir(), ".npm-global", "bin", "kimi")],
  },
  "grok-oauth": {
    executable: "grok",
    npmPackage: "@xai-official/grok",
    loginArgs: ["login", "--oauth"],
  },
  // Command Code ships `cmd`, `cmdc`, `commandcode`, and `command-code` from
  // one package. Only `command-code` is unambiguous everywhere — `cmd` is the
  // Windows shell — so the tray always drives that name.
  "commandcode-oauth": {
    executable: "command-code",
    npmPackage: "command-code",
    loginArgs: ["login"],
    candidates: [path.join(os.homedir(), ".npm-global", "bin", "command-code")],
  },
});

// Resolved at most once per process: the tray refreshes its provider snapshot
// on a timer, and an npm spawn per unconfigured provider per refresh would be
// felt. `undefined` is a real answer here, so the miss is cached too.
let npmGlobalBinDir;
function npmGlobalBinary(executable) {
  if (npmGlobalBinDir === undefined) {
    npmGlobalBinDir = readNpmGlobalBinDir() ?? "";
  }
  if (!npmGlobalBinDir) return undefined;
  const candidate = path.join(npmGlobalBinDir, executable);
  return existsSync(candidate) ? candidate : undefined;
}

function readNpmGlobalBinDir() {
  const npm = npmPath();
  if (!npm) return undefined;
  try {
    const prefix = execFileSync(npm, ["prefix", "-g"], {
      encoding: "utf8",
      env: spawnEnvironment(),
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!prefix) return undefined;
    // npm drops binaries straight into the prefix on Windows and into
    // prefix/bin everywhere else.
    return process.platform === "win32" ? prefix : path.join(prefix, "bin");
  } catch {
    return undefined;
  }
}

function commandPath(name) {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  try {
    return execFileSync(finder, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

// A registry entry can declare a CLI session before anyone teaches this module
// how to install and run that CLI. Callers check first so the missing half
// degrades to "key only" instead of throwing mid-install.
export function hasSignInCli(providerId) {
  return Object.hasOwn(SIGN_IN_CLIS, providerId);
}

export function oauthCliPath(providerId) {
  const cli = SIGN_IN_CLIS[providerId];
  if (!cli) throw new Error(`Unknown OAuth provider: ${providerId}`);
  if (providerId === "grok-oauth") return grokCliPath();
  const discovered = commandPath(cli.executable);
  if (discovered) return discovered;
  const candidate = (cli.candidates || []).find((path) => existsSync(path));
  if (candidate) return candidate;
  // Last resort, because it costs an npm spawn: ask npm where it actually
  // installs global binaries. A custom prefix is invisible to both PATH (the
  // tray's is the bare system one) and to any list of guessed directories.
  return npmGlobalBinary(cli.executable);
}

export function oauthLoginArgs(providerId) {
  const cli = SIGN_IN_CLIS[providerId];
  if (!cli) throw new Error(`Unknown OAuth provider: ${providerId}`);
  return [...cli.loginArgs];
}

function oauthConfigured(providerId) {
  if (providerId === "kimi-oauth") return kimiOAuthStatus().configured;
  if (providerId === "grok-oauth") return grokOAuthStatus().configured;
  const provider = PROVIDERS.get(providerId);
  return provider ? cliSessionStatus(provider).configured : false;
}

export function providerOnboardingSnapshot() {
  // Protocol variants share their parent's key and selection, so onboarding
  // surfaces (tray, guided setup) offer one entry per family.
  const selectable = [...PROVIDERS.values()].filter((provider) => !provider.variantOf);
  return {
    providers: selectable.map((provider) => {
      // A provider the router can only reach through its CLI's sign-in is an
      // OAuth row to everyone downstream, even though the router still speaks
      // plain HTTP to it: there is no key to paste, so the tray must offer the
      // sign-in and nothing else.
      if (provider.kind === "oauth" || !storesKey(provider)) {
        const cliPath = oauthCliPath(provider.id);
        const cli = provider.id === "grok-oauth"
          ? grokCliPreflight({ executable: cliPath })
          : { installed: Boolean(cliPath), runnable: Boolean(cliPath) };
        const cliInstalled = cli.installed;
        const configured = oauthConfigured(provider.id);
        // A CLI-session provider routes from the file its CLI wrote, so a
        // signed-in machine is ready whether or not that CLI is still on PATH.
        // The token-refreshing CLIs (Kimi, Grok) do have to be present, so they
        // keep reporting the install first.
        const sessionOnly = provider.kind !== "oauth";
        return {
          id: provider.id,
          displayName: provider.displayName,
          kind: "oauth",
          configured,
          cliInstalled,
          cliRunnable: cli.runnable,
          action: sessionOnly && configured
            ? "ready"
            : !cliInstalled
              ? "install"
              : !cli.runnable
                ? "blocked"
                : configured
                  ? "ready"
                  : "login",
        };
      }
      const configured = credentialStatus(provider, { persistent: true }).configured;
      return {
        id: provider.id,
        displayName: provider.displayName,
        kind: "api",
        configured,
        action: configured ? "ready" : "add-key",
      };
    }),
  };
}

// npm and every CLI it installs globally start with `#!/usr/bin/env node`, so
// they die instantly unless node is on PATH. The tray is launched by launchd
// with the bare system PATH, which has no node on it — the failure there was
// `env: node: No such file or directory` behind a generic "could not install".
// Whatever node is running this file is by definition a working one, so put
// its directory in front for the child.
function spawnEnvironment() {
  const nodeDir = path.dirname(process.execPath);
  const existing = process.env.PATH || "";
  if (existing.split(path.delimiter).includes(nodeDir)) return process.env;
  return { ...process.env, PATH: existing ? `${nodeDir}${path.delimiter}${existing}` : nodeDir };
}

function npmPath() {
  const discovered = commandPath("npm");
  if (discovered) return discovered;
  const candidates = [
    path.join(os.homedir(), ".npm-global", "bin", "npm"),
    path.join(os.homedir(), ".local", "bin", "npm"),
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

// npm prints its diagnosis over several lines and ends with log-file paths
// that mean nothing in a tray dialog; the last real line is the useful one.
function installFailureDetail(result) {
  if (result.error) return result.error.message;
  const lines = `${result.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.replace(/^npm (error|ERR!)\s*/i, "").trim())
    .filter((line) => line && !/^[A-Za-z]?:?[\\/].*\.log$/.test(line));
  const detail = lines[lines.length - 1];
  return detail ? `npm said: ${detail}` : `npm exited with status ${result.status}.`;
}

export function installOauthCli(providerId) {
  const cli = SIGN_IN_CLIS[providerId];
  if (!cli) throw new Error(`Unknown OAuth provider: ${providerId}`);
  if (providerId === "grok-oauth") {
    const preflight = grokCliPreflight();
    if (preflight.installed) {
      if (!preflight.runnable) throw new Error(grokCliFailureMessage(preflight));
      return;
    }
  } else if (oauthCliPath(providerId)) {
    return;
  }
  const npm = npmPath();
  if (!npm) throw new Error("Node.js and npm are required to install this provider CLI.");
  const result = spawnSync(npm, ["install", "-g", cli.npmPackage], {
    encoding: "utf8",
    env: spawnEnvironment(),
  });
  if (result.error || result.status !== 0) {
    // The reason matters more than the fact: "EACCES on /usr/local/lib" and
    // "network unreachable" need opposite fixes, and a bare "could not
    // install" sent the last one of these into a debugging session.
    throw new Error(
      `Could not install the official ${cli.executable} CLI. ${installFailureDetail(result)}`.trim(),
    );
  }
  if (providerId === "grok-oauth") {
    const preflight = grokCliPreflight();
    if (!preflight.runnable) throw new Error(grokCliFailureMessage(preflight));
  } else if (!oauthCliPath(providerId)) {
    // The install reported success, so the binary exists somewhere npm knows
    // about and this router does not. Name the search so it is fixable.
    throw new Error(
      `npm installed ${cli.npmPackage}, but no \`${cli.executable}\` was found on PATH or in npm's global bin directory.`,
    );
  }
}

// A browser sign-in is slow by nature — the operator has to switch apps, log
// in, and authorize — but it must not be able to wedge the tray forever if the
// CLI waits on a terminal it will never get.
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export function loginOauthProvider(providerId) {
  const executable = oauthCliPath(providerId);
  if (!executable) throw new Error("Install the provider CLI before signing in.");
  if (providerId === "grok-oauth") {
    const preflight = grokCliPreflight({ executable });
    if (!preflight.runnable) throw new Error(grokCliFailureMessage(preflight));
  }
  // The CLI itself is another `#!/usr/bin/env node` script, so signing in needs
  // the same PATH repair the install did.
  const result = spawnSync(executable, oauthLoginArgs(providerId), {
    encoding: "utf8",
    env: spawnEnvironment(),
    timeout: LOGIN_TIMEOUT_MS,
  });
  // A sign-in the operator never finished and one the CLI could not run look
  // the same from here, so say both are possible rather than blaming them.
  if (result.signal === "SIGTERM") {
    throw new Error(
      `${executable} did not finish signing in within 10 minutes. Run it in a terminal to see what it is waiting for.`,
    );
  }
  if (result.error || result.status !== 0) {
    throw new Error("Provider sign-in was cancelled or did not complete.");
  }
  if (!oauthConfigured(providerId)) {
    throw new Error("Sign-in finished without a usable OAuth session. Please try again.");
  }
}

export function saveApiCredential(providerId, value) {
  writeProviderCredential(providerId, value);
}

// Deleting the managed key files cannot reach a key that also lives in the
// macOS Keychain or the environment, so report what still resolves afterwards
// instead of claiming the provider is disconnected.
export function removeApiCredential(providerId) {
  const provider = apiProvider(providerId);
  const removedFiles = removeProviderCredential(provider);
  if (removedFiles) disableProvider(provider.id);
  const remaining = credentialStatus(provider, { persistent: true });
  return {
    provider: provider.id,
    displayName: provider.displayName,
    removedFiles,
    stillConfigured: remaining.configured === true,
    remainingSource: remaining.configured ? remaining.source : undefined,
  };
}

// Catalog-only providers (gemini-api, openrouter, groq, ...) ship no
// preselected models, so a stored key still leaves the picker empty. Callers
// use this to name the curation step instead of reporting a provider that
// looks enabled but shows nothing.
export function providerNeedsCuration(providerId, models = MODELS) {
  return !models.some((model) => model.provider === providerId);
}
