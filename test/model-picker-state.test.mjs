import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-picker-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  MODEL_PICKER_STATE_PATH,
  modelPickerSnapshot,
  readHiddenModels,
  setModelVisible,
} = await import("../src/model-picker-state.mjs");

test("picker visibility defaults to no hidden models", () => {
  assert.deepEqual([...readHiddenModels()], []);
  assert.deepEqual(modelPickerSnapshot().hidden, []);
});

test("picker visibility round-trips through protected state", () => {
  setModelVisible("opencode-go/deepseek-v4-flash", false);
  assert.deepEqual([...readHiddenModels()], ["opencode-go/deepseek-v4-flash"]);
  assert.deepEqual(modelPickerSnapshot().hidden, ["opencode-go/deepseek-v4-flash"]);

  setModelVisible("opencode-go/deepseek-v4-flash", true);
  assert.deepEqual([...readHiddenModels()], []);
  assert.ok(MODEL_PICKER_STATE_PATH.startsWith(stateDir));
});
