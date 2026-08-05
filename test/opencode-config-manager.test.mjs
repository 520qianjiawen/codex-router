import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, stateDir, configPath) {
  const output = execFileSync(
    process.execPath,
    [path.join(root, "src", "opencode-config-manager.mjs"), command],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: "opencode",
        MODEL_ROUTER_STATE_DIR: stateDir,
        OPENCODE_CONFIG: configPath,
      },
    },
  );
  return JSON.parse(output);
}

function fixture(name) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), `opencode-config-${name}-`));
  // enable() needs a caller secret to put in options.apiKey.
  writeFileSync(path.join(stateDir, "caller-secret"), "test-caller-secret\n", {
    mode: 0o600,
  });
  return { stateDir, configPath: path.join(stateDir, "opencode.json") };
}

test("opencode config manager owns one provider key and preserves the rest of the file", () => {
  const { stateDir, configPath } = fixture("merge");
  try {
    // A config the user already hand-wrote, including their own provider.
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "tokyonight",
        model: "anthropic/claude-sonnet-4",
        provider: {
          ollama: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://localhost:11434/v1" },
          },
        },
      }),
    );

    const enabled = run("enable", stateDir, configPath);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.providerPresent, true);

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    // Our block is present and points at this target's router.
    const ours = written.provider["codex-router"];
    assert.equal(ours.npm, "@ai-sdk/openai-compatible");
    assert.match(ours.options.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(ours.options.apiKey, "test-caller-secret");
    assert.ok(Object.keys(ours.models).length > 0);

    // Everything the user wrote survives untouched.
    assert.equal(written.theme, "tokyonight");
    assert.equal(written.model, "anthropic/claude-sonnet-4");
    assert.deepEqual(written.provider.ollama, {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://localhost:11434/v1" },
    });

    const disabled = run("disable", stateDir, configPath);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.providerPresent, false);

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    // Only our key is gone; theirs and their top-level settings remain.
    assert.equal(after.provider["codex-router"], undefined);
    assert.ok(after.provider.ollama);
    assert.equal(after.theme, "tokyonight");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("opencode config manager drops an empty provider map it created", () => {
  const { stateDir, configPath } = fixture("empty");
  try {
    run("enable", stateDir, configPath);
    run("disable", stateDir, configPath);
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    // No orphan scaffolding left behind for a user who had no providers.
    assert.equal(after.provider, undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("opencode config manager refuses to overwrite a malformed config", () => {
  const { stateDir, configPath } = fixture("bad");
  try {
    writeFileSync(configPath, "{ not json");
    assert.throws(() => run("enable", stateDir, configPath));
    // The user's file is left exactly as it was, never replaced with ours.
    assert.equal(readFileSync(configPath, "utf8"), "{ not json");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("opencode config manager does not create a config file when disabling", () => {
  const { stateDir, configPath } = fixture("absent");
  try {
    const disabled = run("disable", stateDir, configPath);
    assert.equal(disabled.enabled, false);
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
