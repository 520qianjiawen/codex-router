import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const NATIVE_REDIRECT_PATH =
  process.env.MODEL_ROUTER_NATIVE_REDIRECT_STATE ||
  path.join(STATE_DIR, "native-redirect.json");

// Codex runs background agent sessions -- memory extraction, review passes,
// and similar utility work -- on a hardcoded native GPT model, regardless of
// the model the user picked. When the OpenAI quota is exhausted those turns
// all fail, and the features they power silently stop working. This optional
// redirect sends every native turn that reaches the router to a routed model
// instead, so the background machinery keeps running on the user's paid
// provider. It is deliberately all-or-nothing: the native turns carry no
// reliable marker separating background work from a deliberately picked GPT
// model, and the users who opt in are the ones with no native quota to spend.
export function readNativeRedirect() {
  if (!existsSync(NATIVE_REDIRECT_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(NATIVE_REDIRECT_PATH, "utf8"));
    if (parsed?.version !== 1) return undefined;
    const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    return model || undefined;
  } catch {
    return undefined;
  }
}

export function nativeRedirectSnapshot() {
  return { model: readNativeRedirect() ?? null, path: NATIVE_REDIRECT_PATH };
}

export function setNativeRedirect(slug) {
  const value = String(slug || "").trim();
  if (!value) throw new Error("A routed model slug is required.");

  const stateDir = path.dirname(NATIVE_REDIRECT_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${NATIVE_REDIRECT_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, model: value }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, NATIVE_REDIRECT_PATH);
  protectPrivateFile(NATIVE_REDIRECT_PATH);
  return nativeRedirectSnapshot();
}

export function clearNativeRedirect() {
  if (existsSync(NATIVE_REDIRECT_PATH)) unlinkSync(NATIVE_REDIRECT_PATH);
  return nativeRedirectSnapshot();
}
