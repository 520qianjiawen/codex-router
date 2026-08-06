import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "multi-agent-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  MULTI_AGENT_ALL_PATH,
  readAllMultiAgent,
  writeAllMultiAgent,
} = await import("../src/multi-agent-state.mjs");

test("all-models multi-agent state defaults to off when absent or invalid", () => {
  assert.equal(readAllMultiAgent(), false);
});

test("all-models multi-agent state round-trips through protected state", () => {
  writeAllMultiAgent(true);
  assert.equal(readAllMultiAgent(), true);
  writeAllMultiAgent(false);
  assert.equal(readAllMultiAgent(), false);
  assert.ok(MULTI_AGENT_ALL_PATH.startsWith(stateDir));
});
