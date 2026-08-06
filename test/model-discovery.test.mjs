import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("model discovery compares fixtures without needing or exposing a key", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v5-preview" }] }),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "deepseek", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, DEEPSEEK_API_KEY: "" } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["deepseek-v5-preview"]);
    assert.ok(result.unavailable.includes("deepseek-v4-flash"));
    assert.doesNotMatch(output, /Bearer|api[_-]?key/i);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Command Code discovery parses the Provider API model list", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-commandcode-discovery-"));
  const fixture = path.join(testRoot, "models.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      object: "list",
      data: [{ id: "deepseek/deepseek-v4-flash" }, { id: "claude-sonnet-4-6" }],
    }),
  );
  try {
    const output = execFileSync(
      process.execPath,
      ["src/model-discovery.mjs", "commandcode", "--fixture", fixture, "--json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, COMMAND_CODE_API_KEY: "" } },
    );
    const result = JSON.parse(output);
    assert.deepEqual(result.unregistered, ["claude-sonnet-4-6"]);
    assert.ok(result.unavailable.includes("deepseek/deepseek-v4-pro"));
    assert.doesNotMatch(output, /Bearer|api[_-]?key/i);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
