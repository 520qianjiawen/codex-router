import assert from "node:assert/strict";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "multi-agent-state-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  MULTI_AGENT_ALL_PATH,
  MULTI_AGENT_STATE_PATH,
  applyMultiAgentSettings,
  readAllMultiAgent,
  readMultiAgentSettings,
  setMultiAgentMode,
  setMultiAgentModel,
  subagentSettingsSnapshot,
} = await import("../src/multi-agent-state.mjs");

test("subagent settings default to conservative proven mode", () => {
  assert.equal(readAllMultiAgent(), false);
  assert.equal(readMultiAgentSettings().mode, "proven");
});

test("subagent mode round-trips through protected state", () => {
  setMultiAgentMode("all");
  assert.equal(readAllMultiAgent(), true);
  assert.equal(subagentSettingsSnapshot().all, true);
  setMultiAgentMode("proven");
  assert.equal(readAllMultiAgent(), false);
  assert.ok(MULTI_AGENT_STATE_PATH.startsWith(stateDir));
});

test("per-model subagent toggles promote selected mode and remember exclusions", () => {
  setMultiAgentMode("proven");
  setMultiAgentModel("opencode-go/deepseek-v4-flash", true);
  const selected = subagentSettingsSnapshot();
  assert.equal(selected.mode, "selected");
  assert.deepEqual(selected.enabled, ["opencode-go/deepseek-v4-flash"]);

  setMultiAgentMode("all");
  setMultiAgentModel("qwen-plan/qwen3.8-max", false);
  const all = subagentSettingsSnapshot();
  assert.equal(all.mode, "all");
  assert.deepEqual(all.disabled, ["qwen-plan/qwen3.8-max"]);
});

test("all mode promotes every model except explicit exclusions", () => {
  const models = [
    { slug: "opencode-go/deepseek-v4-flash" },
    { slug: "qwen-plan/qwen3.8-max", multiAgentVersion: "v1" },
    { slug: "kimi-oauth/k3", multiAgentVersion: "v2" },
  ];
  const promoted = applyMultiAgentSettings(models, {
    version: 2,
    mode: "all",
    enabled: [],
    disabled: ["qwen-plan/qwen3.8-max"],
  });
  assert.deepEqual(
    promoted.map((model) => [model.slug, model.multiAgentVersion]),
    [
      ["opencode-go/deepseek-v4-flash", "v2"],
      ["qwen-plan/qwen3.8-max", "v1"],
      ["kimi-oauth/k3", "v2"],
    ],
  );
});

test("selected mode only promotes the chosen plus registry-proven models", () => {
  const models = [
    { slug: "opencode-go/deepseek-v4-flash" },
    { slug: "qwen-plan/qwen3.8-max" },
    { slug: "kimi-oauth/k3", multiAgentVersion: "v2" },
  ];
  const selected = applyMultiAgentSettings(models, {
    version: 2,
    mode: "selected",
    enabled: ["opencode-go/deepseek-v4-flash"],
    disabled: [],
  });
  assert.deepEqual(
    selected.map((model) => [model.slug, model.multiAgentVersion]),
    [
      ["opencode-go/deepseek-v4-flash", "v2"],
      ["qwen-plan/qwen3.8-max", undefined],
      ["kimi-oauth/k3", "v2"],
    ],
  );
});

test("legacy all-on switch still enables all-models mode", () => {
  if (existsSync(MULTI_AGENT_STATE_PATH)) unlinkSync(MULTI_AGENT_STATE_PATH);
  writeFileSync(MULTI_AGENT_ALL_PATH, '{"version":1,"enabled":true}\n', {
    mode: 0o600,
  });
  assert.equal(readAllMultiAgent(), true);
});
