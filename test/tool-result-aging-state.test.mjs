import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "tool-result-aging-state-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  TOOL_RESULT_AGING_STATE_PATH,
  readToolResultAgingSettings,
  setToolResultAgingEnabled,
  toolResultAgingEnabled,
  toolResultAgingSnapshot,
} = await import("../src/tool-result-aging-state.mjs");

function forgetState() {
  rmSync(TOOL_RESULT_AGING_STATE_PATH, { force: true });
  delete process.env.CODEX_ROUTER_TOOL_RESULT_AGING;
}

test("tool-result aging defaults on before it is configured", () => {
  forgetState();
  assert.deepEqual(readToolResultAgingSettings(), {
    version: 1,
    enabled: true,
    defaulted: true,
  });
  assert.equal(toolResultAgingSnapshot().configured, false);
  assert.equal(toolResultAgingEnabled(), true);
});

test("tool-result aging toggle round-trips through protected state", () => {
  setToolResultAgingEnabled(false);
  assert.deepEqual(readToolResultAgingSettings(), { version: 1, enabled: false });
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(toolResultAgingSnapshot().configured, true);

  setToolResultAgingEnabled(true);
  assert.equal(toolResultAgingEnabled(), true);
  assert.ok(TOOL_RESULT_AGING_STATE_PATH.startsWith(stateDir));
});

test("environment kill switch overrides the saved setting", () => {
  setToolResultAgingEnabled(true);
  process.env.CODEX_ROUTER_TOOL_RESULT_AGING = "0";
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(toolResultAgingSnapshot().environmentOverride, true);
  delete process.env.CODEX_ROUTER_TOOL_RESULT_AGING;
});

test("corrupt explicit state fails closed", () => {
  writeFileSync(TOOL_RESULT_AGING_STATE_PATH, "{not json", "utf8");
  assert.deepEqual(readToolResultAgingSettings(), { version: 1, enabled: false });
  assert.equal(toolResultAgingEnabled(), false);
});
