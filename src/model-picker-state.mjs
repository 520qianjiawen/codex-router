import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const MODEL_PICKER_STATE_PATH =
  process.env.MODEL_ROUTER_MODEL_PICKER_STATE ||
  path.join(STATE_DIR, "model-picker.json");

// Per-model visibility overrides for the Codex picker. Hiding a model only
// changes the merged catalog for this machine; the registry stays untouched.
export function readHiddenModels() {
  if (!existsSync(MODEL_PICKER_STATE_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(MODEL_PICKER_STATE_PATH, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.hidden)) return new Set();
    return new Set(parsed.hidden.map((slug) => String(slug)).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function modelPickerSnapshot() {
  return {
    hidden: [...readHiddenModels()].sort(),
    path: MODEL_PICKER_STATE_PATH,
  };
}

export function setModelVisible(slug, visible) {
  const value = String(slug || "").trim();
  if (!value) throw new Error("A model slug is required.");
  const hidden = readHiddenModels();
  if (visible) hidden.delete(value);
  else hidden.add(value);

  const stateDir = path.dirname(MODEL_PICKER_STATE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${MODEL_PICKER_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: 1, hidden: [...hidden].sort() }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  protectPrivateFile(temporary);
  renameSync(temporary, MODEL_PICKER_STATE_PATH);
  protectPrivateFile(MODEL_PICKER_STATE_PATH);
  return modelPickerSnapshot();
}

export function setAllModelsVisible(slugs, visible) {
  const known = [...new Set(slugs.map((slug) => String(slug).trim()).filter(Boolean))];
  const hidden = visible ? new Set() : new Set(known);
  const stateDir = path.dirname(MODEL_PICKER_STATE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${MODEL_PICKER_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: 1, hidden: [...hidden].sort() }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  protectPrivateFile(temporary);
  renameSync(temporary, MODEL_PICKER_STATE_PATH);
  protectPrivateFile(MODEL_PICKER_STATE_PATH);
  return modelPickerSnapshot();
}
