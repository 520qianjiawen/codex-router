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
  commandcode: {
    executable: "command-code",
    npmPackage: "command-code",
    loginArgs: ["login"],
    candidates: [path.join(os.homedir(), ".npm-global", "bin", "command-code")],
  },
});

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
  return (cli.candidates || []).find((candidate) => existsSync(candidate));
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
      if (provider.kind === "oauth") {
        const cliPath = oauthCliPath(provider.id);
        const cli = provider.id === "grok-oauth"
          ? grokCliPreflight({ executable: cliPath })
          : { installed: Boolean(cliPath), runnable: Boolean(cliPath) };
        const cliInstalled = cli.installed;
        const configured = oauthConfigured(provider.id);
        return {
          id: provider.id,
          displayName: provider.displayName,
          kind: "oauth",
          configured,
          cliInstalled,
          cliRunnable: cli.runnable,
          action: !cliInstalled
            ? "install"
            : !cli.runnable
              ? "blocked"
              : configured
                ? "ready"
                : "login",
        };
      }
      const configured = credentialStatus(provider, { persistent: true }).configured;
      const entry = {
        id: provider.id,
        displayName: provider.displayName,
        kind: "api",
        configured,
        action: configured ? "ready" : "add-key",
      };
      // A provider whose CLI mints its key through a browser sign-in keeps the
      // key field (people with a Studio key still paste it) and gains a second
      // route. The tray needs both states to label the row honestly: whether
      // the CLI is present, and whether the key in play came from the session.
      const session = cliSessionStatus(provider);
      if (!session.supported || !hasSignInCli(provider.id)) return entry;
      const cliInstalled = Boolean(oauthCliPath(provider.id));
      return {
        ...entry,
        signIn: true,
        signedIn: session.configured,
        cliInstalled,
        signInAction: !cliInstalled ? "install" : session.configured ? "ready" : "login",
      };
    }),
  };
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
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not install the official ${cli.executable} CLI.`);
  }
  if (providerId === "grok-oauth") {
    const preflight = grokCliPreflight();
    if (!preflight.runnable) throw new Error(grokCliFailureMessage(preflight));
  } else if (!oauthCliPath(providerId)) {
    throw new Error(`The official ${cli.executable} CLI was installed but could not be located.`);
  }
}

export function loginOauthProvider(providerId) {
  const executable = oauthCliPath(providerId);
  if (!executable) throw new Error("Install the provider CLI before signing in.");
  if (providerId === "grok-oauth") {
    const preflight = grokCliPreflight({ executable });
    if (!preflight.runnable) throw new Error(grokCliFailureMessage(preflight));
  }
  const result = spawnSync(executable, oauthLoginArgs(providerId), {
    encoding: "utf8",
    env: process.env,
  });
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
