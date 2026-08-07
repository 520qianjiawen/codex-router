import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = path.join(root, "src", "setup.mjs");

// The installers update the managed checkout before running setup and restore
// it on failure. Exit 2 is the contract that tells them the checkout is fine
// and only configuration is unfinished, so the update survives a declined
// prompt or a bad invocation. Asserting it here keeps that contract from
// drifting away from install.sh and install.ps1, which read the number.
const SETUP_INCOMPLETE_EXIT = 2;

function runSetup(args) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "setup-exit-"));
  try {
    return spawnSync(process.execPath, [SETUP, ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_STATE_DIR: stateDir,
        CODEX_HOME: stateDir,
      },
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test("an unknown option leaves the checkout update in place", () => {
  const result = runSetup(["--not-a-real-flag"]);
  assert.equal(result.status, SETUP_INCOMPLETE_EXIT);
  assert.match(result.stderr, /Unknown setup option/);
});

test("--providers without a value leaves the checkout update in place", () => {
  const result = runSetup(["--providers"]);
  assert.equal(result.status, SETUP_INCOMPLETE_EXIT);
  assert.match(result.stderr, /--providers requires a comma-separated value/);
});

test("an unknown provider id leaves the checkout update in place", () => {
  const result = runSetup(["--providers", "definitely-not-a-provider"]);
  assert.equal(result.status, SETUP_INCOMPLETE_EXIT);
});

// Deliberately absent: a "no configured provider" case driven through
// `--providers configured`. Credentials for OAuth providers are discovered
// from each CLI's own state, not from MODEL_ROUTER_STATE_DIR, so on a machine
// that is signed in anywhere the run does NOT fail -- it proceeds through the
// real installer and rewrites the developer's launch agent and Codex config.
// Anything that can reach `main()` past provider selection installs for real;
// keep the cases in this file to argument and selection errors, which exit
// before that point.

test("--help still succeeds", () => {
  const result = runSetup(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: setup/);
});
