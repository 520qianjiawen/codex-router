import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_KEY = "TEST_COMMANDCODE_SESSION_KEY";

// The signed-in session lives in the provider CLI's own directory, so every
// case runs against a throwaway home rather than the developer's real one.
function sessionRoot(apiKey) {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "cli-session-credential-"));
  const sessionDirectory = path.join(testRoot, ".commandcode");
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  if (apiKey !== undefined) {
    writeFileSync(
      path.join(sessionDirectory, "auth.json"),
      typeof apiKey === "string"
        ? JSON.stringify({ apiKey, userName: "Test Account", userId: "u_test" })
        : apiKey.raw,
      { mode: 0o600 },
    );
  }
  return { testRoot, sessionDirectory };
}

function environment(testRoot, sessionDirectory, overrides = {}) {
  return {
    ...process.env,
    HOME: testRoot,
    USERPROFILE: testRoot,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    COMMANDCODE_CLI_HOME: sessionDirectory,
    // Onboarding asks npm where global binaries live, so a developer machine
    // with the real command-code CLI installed must not leak into these runs.
    npm_config_prefix: path.join(testRoot, "npm-global"),
    COMMAND_CODE_API_KEY: "",
    COMMANDCODE_API_KEY: "",
    ...overrides,
  };
}

// Runs inside a child process because the registry and credential modules read
// their environment once at import time.
function inspect(environmentValues, source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    encoding: "utf8",
    env: environmentValues,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const REPORT_SOURCE = `
  const { PROVIDERS } = await import("./src/model-registry.mjs");
  const { credentialStatus, resolveProviderCredential } =
    await import("./src/provider-credentials.mjs");
  const report = {};
  for (const id of ["commandcode", "commandcode-oauth", "commandcode-oauth-messages"]) {
    const provider = PROVIDERS.get(id);
    report[id] = {
      ...credentialStatus(provider, { persistent: true }),
      value: resolveProviderCredential(provider)?.value,
    };
  }
  process.stdout.write(JSON.stringify(report));
`;

test("a Command Code sign-in authenticates the OAuth route and its Messages variant", () => {
  const { testRoot, sessionDirectory } = sessionRoot(SESSION_KEY);
  try {
    const report = inspect(environment(testRoot, sessionDirectory), REPORT_SOURCE);
    for (const id of ["commandcode-oauth", "commandcode-oauth-messages"]) {
      assert.equal(report[id].configured, true);
      assert.equal(report[id].source, "Command Code CLI sign-in");
      assert.equal(report[id].persistent, true);
      assert.equal(report[id].value, SESSION_KEY);
    }
    // The stored-key route is a separate provider: a session never configures it.
    assert.equal(report.commandcode.configured, false);
    assert.equal(report.commandcode.setup, "Run ./bin/provider-key commandcode set");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the sign-in route refuses to store a key of its own", () => {
  const { testRoot, sessionDirectory } = sessionRoot();
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "commandcode-oauth"],
      {
        cwd: root,
        encoding: "utf8",
        env: environment(testRoot, sessionDirectory),
        input: "TEST_SHOULD_NOT_BE_STORED\n",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not store a key here; run `command-code login`/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("an unusable session file leaves the route unconfigured instead of failing", () => {
  for (const contents of [{ raw: "{ not json" }, { raw: "{}" }, { raw: '{"apiKey":"  "}' }]) {
    const { testRoot, sessionDirectory } = sessionRoot(contents);
    try {
      const report = inspect(environment(testRoot, sessionDirectory), REPORT_SOURCE);
      assert.equal(report["commandcode-oauth"].configured, false);
      assert.equal(report["commandcode-oauth"].setup, "Run `command-code login`");
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  }
});

test("the sign-in route is an OAuth row in onboarding, with no key field", () => {
  const source = `
    const { providerOnboardingSnapshot } = await import("./src/provider-onboarding.mjs");
    const rows = providerOnboardingSnapshot().providers
      .filter((provider) => provider.id.startsWith("commandcode"));
    process.stdout.write(JSON.stringify(rows));
  `;
  const isolatedPath = process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32")
    : "/usr/bin:/bin";

  const { testRoot, sessionDirectory } = sessionRoot(SESSION_KEY);
  try {
    const rows = inspect(
      environment(testRoot, sessionDirectory, { PATH: isolatedPath }),
      source,
    );
    // Protocol variants stay folded into their route, so there are exactly two.
    assert.deepEqual(rows.map((row) => row.id), ["commandcode", "commandcode-oauth"]);
    const [key, signIn] = rows;
    assert.equal(key.kind, "api");
    assert.equal(key.configured, false);
    assert.equal(key.action, "add-key");
    assert.equal(signIn.kind, "oauth");
    assert.equal(signIn.configured, true);
    assert.equal(signIn.action, "ready");
    assert.equal("signIn" in signIn, false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("enabling one Command Code route hides the other", () => {
  const { testRoot, sessionDirectory } = sessionRoot(SESSION_KEY);
  const environmentValues = environment(testRoot, sessionDirectory);
  try {
    const stored = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "commandcode"],
      { cwd: root, encoding: "utf8", env: environmentValues, input: "TEST_COMMANDCODE_KEY\n" },
    );
    assert.equal(stored.status, 0, stored.stderr);

    const selection = (providerId) => {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "src", "providers.mjs"), "enable", providerId],
        { cwd: root, encoding: "utf8", env: environmentValues },
      );
      assert.equal(result.status, 0, result.stderr);
      return { stdout: result.stdout, providers: readSelection() };
    };
    const readSelection = () =>
      JSON.parse(
        spawnSync(
          process.execPath,
          [path.join(root, "src", "provider-selection.mjs"), "status"],
          { cwd: root, encoding: "utf8", env: environmentValues },
        ).stdout,
      ).providers;

    const afterKey = selection("commandcode");
    assert.ok(afterKey.providers.includes("commandcode"));
    assert.ok(!afterKey.providers.includes("commandcode-oauth"));

    const afterSignIn = selection("commandcode-oauth");
    assert.ok(afterSignIn.providers.includes("commandcode-oauth"));
    assert.ok(!afterSignIn.providers.includes("commandcode"));
    // The displaced row is named rather than left to be noticed in the picker.
    assert.match(afterSignIn.stdout, /Command Code API reaches the same account/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a selection may never name two routes into the same account", () => {
  const { testRoot, sessionDirectory } = sessionRoot(SESSION_KEY);
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "src", "provider-selection.mjs"),
        "set",
        "commandcode-oauth,commandcode,deepseek",
      ],
      { cwd: root, encoding: "utf8", env: environment(testRoot, sessionDirectory) },
    );
    assert.equal(result.status, 0, result.stderr);
    // The stored-key route wins the tie because setting it up was deliberate.
    assert.deepEqual(JSON.parse(result.stdout).providers, ["commandcode", "deepseek"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a support bundle redacts a key that came from the CLI sign-in", () => {
  const { testRoot, sessionDirectory } = sessionRoot(SESSION_KEY);
  try {
    // Plant the session key somewhere the bundle genuinely copies from, so the
    // assertion proves redaction rather than mere absence. Bare, so the generic
    // log scrubber cannot catch it: only knowing the session key removes it.
    const stateDirectory = path.join(testRoot, "state");
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(stateDirectory, "router.log"),
      `upstream rejected the credential ${SESSION_KEY} for commandcode\n`,
      { mode: 0o600 },
    );
    const source = `
      const { createSupportBundle } = await import("./src/support-bundle.mjs");
      const { readFileSync } = await import("node:fs");
      createSupportBundle({ output: process.env.BUNDLE_PATH, includeLogs: true });
      const contents = readFileSync(process.env.BUNDLE_PATH, "utf8");
      process.stdout.write(JSON.stringify({
        leaked: contents.includes(${JSON.stringify(SESSION_KEY)}),
        redacted: contents.includes("[REDACTED]"),
        source: JSON.parse(contents).credentialSources?.["commandcode-oauth"]?.source,
      }));
    `;
    const report = inspect(
      environment(testRoot, sessionDirectory, {
        BUNDLE_PATH: path.join(testRoot, "bundle.json"),
      }),
      source,
    );
    assert.equal(report.leaked, false);
    assert.equal(report.redacted, true);
    assert.equal(report.source, "Command Code CLI sign-in");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the sign-in route mirrors the stored-key catalog exactly", () => {
  const source = `
    const { MODELS } = await import("./src/model-registry.mjs");
    const shape = (provider) => MODELS
      .filter((model) => model.provider === provider)
      .map((model) => [model.slug.slice(provider.length + 1), model.displayName, model.priority]);
    process.stdout.write(JSON.stringify({
      key: shape("commandcode"),
      signIn: shape("commandcode-oauth"),
      keyMessages: shape("commandcode-messages"),
      signInMessages: shape("commandcode-oauth-messages"),
      gateways: MODELS.filter((m) => m.provider === "commandcode-oauth").map((m) => m.gatewayModel),
    }));
  `;
  const catalog = inspect(process.env, source);
  assert.ok(catalog.key.length > 0);
  assert.deepEqual(catalog.signIn, catalog.key);
  assert.deepEqual(catalog.signInMessages, catalog.keyMessages);
  // Distinct gateway ids keep the two routes addressable apart on the wire.
  assert.ok(catalog.gateways.every((id) => id.startsWith("commandcode-oauth-")));
});

test("a CLI session descriptor may not escape its own home directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cli-session-registry-"));
  try {
    const registry = JSON.parse(
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { readRegistryDocument } = await import("./src/model-registry.mjs");
           process.stdout.write(JSON.stringify(readRegistryDocument("config")));`,
        ],
        { cwd: root, encoding: "utf8", env: process.env },
      ).stdout,
    );
    registry.providers = registry.providers.map((provider) =>
      provider.id === "commandcode-oauth"
        ? {
            ...provider,
            credential: {
              cliSession: { ...provider.credential.cliSession, directory: "../secrets" },
            },
          }
        : provider,
    );
    const registryPath = path.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cliSession directory must be a single path segment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an auth variant may not declare its own models", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "auth-variant-registry-"));
  try {
    const registry = JSON.parse(
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { readRegistryDocument } = await import("./src/model-registry.mjs");
           process.stdout.write(JSON.stringify(readRegistryDocument("config")));`,
        ],
        { cwd: root, encoding: "utf8", env: process.env },
      ).stdout,
    );
    const donor = registry.models.find((model) => model.provider === "commandcode");
    registry.models = [
      ...registry.models,
      {
        ...donor,
        provider: "commandcode-oauth",
        slug: "commandcode-oauth/hand-written",
        gatewayModel: "commandcode-oauth-hand-written",
      },
    ];
    const registryPath = path.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not declare models; they are cloned from commandcode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
