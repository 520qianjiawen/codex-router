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

export const MULTI_AGENT_ALL_PATH =
  process.env.MODEL_ROUTER_MULTI_AGENT_ALL ||
  path.join(STATE_DIR, "multi-agent-all.json");

// Local opt-in that exposes every selected model as a native v2 spawn-agent
// override. The checked-in registry stays conservative; this state only
// changes how the merged catalog for this machine is rendered.
export function readAllMultiAgent() {
  if (!existsSync(MULTI_AGENT_ALL_PATH)) return false;
  try {
    const parsed = JSON.parse(readFileSync(MULTI_AGENT_ALL_PATH, "utf8"));
    return parsed?.version === 1 && parsed.enabled === true;
  } catch {
    return false;
  }
}

export function writeAllMultiAgent(enabled) {
  const stateDir = path.dirname(MULTI_AGENT_ALL_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${MULTI_AGENT_ALL_PATH}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: 1, enabled: Boolean(enabled) }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  protectPrivateFile(temporary);
  renameSync(temporary, MULTI_AGENT_ALL_PATH);
  protectPrivateFile(MULTI_AGENT_ALL_PATH);
  return Boolean(enabled);
}
