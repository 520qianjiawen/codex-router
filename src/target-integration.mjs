import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { NATIVE_CATALOG_PATH, SOURCE_ROOT, TARGET } from "./paths.mjs";

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
  // Only Codex has a native model picker fed by our catalog; the others read
  // their model list straight from their own config.
  if (TARGET !== "codex") return false;
  if (!existsSync(NATIVE_CATALOG_PATH)) return false;
  run("catalog.mjs");
  return true;
}
