import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { NATIVE_CATALOG_PATH, OPENCODE_CONFIG_STATE_PATH, SOURCE_ROOT, TARGET } from "./paths.mjs";

function run(script, args = []) {
  execFileSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export function targetCli(command) {
  return TARGET === "codex"
    ? `./bin/${command}`
    : `./bin/model-router ${TARGET} ${command}`;
}

const PICKER_NAMES = {
  codex: "Codex",
  cursor: "Cursor",
  opencode: "opencode",
};

export function targetPickerName() {
  return PICKER_NAMES[TARGET] || TARGET;
}

export function refreshTargetPickerIfInstalled() {
  if (TARGET === "opencode") {
    // opencode reads its model list from opencode.json, so an enabled install
    // must be rewritten when the selected providers change.
    if (!existsSync(OPENCODE_CONFIG_STATE_PATH)) return false;
    run("opencode-config-manager.mjs", ["enable"]);
    return true;
  }
  // Only Codex has a native model picker fed by our catalog; Cursor reads its
  // model list straight from its own config.
  if (TARGET !== "codex") return false;
  if (!existsSync(NATIVE_CATALOG_PATH)) return false;
  run("catalog.mjs");
  return true;
}
