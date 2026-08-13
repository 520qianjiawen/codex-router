// Codex tool schemas use integer/u64 fields. Some routed models (Grok in
// particular) emit whole numbers as JSON floats (`20000.0`). Serde then
// rejects the call before the tool runs.
//
// JSON.parse cannot see the difference between 20000 and 20000.0, so this
// rewrites number tokens in the raw argument string.

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const PLAIN_INTEGER = /^-?(?:0|[1-9]\d*)$/;

function integerToken(token) {
  const value = Number(token);
  if (!Number.isSafeInteger(value)) return token;
  if (PLAIN_INTEGER.test(token) && !Object.is(value, -0)) return token;
  return Object.is(value, -0) ? "0" : String(value);
}

export function rewriteWholeNumberTokens(raw) {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const match = raw.slice(i).match(JSON_NUMBER);
      if (match) {
        out += integerToken(match[0]);
        i += match[0].length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function coerceWholeNumberJson(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => coerceWholeNumberJson(entry));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return Object.is(value, -0) ? 0 : value;
    }
    return value;
  }
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = coerceWholeNumberJson(entry);
  }
  return next;
}

export function coerceFunctionCallArguments(raw) {
  if (typeof raw !== "string") return raw;
  try {
    JSON.parse(raw);
  } catch {
    return raw;
  }
  const rewritten = rewriteWholeNumberTokens(raw);
  if (rewritten === raw) return raw;
  try {
    JSON.parse(rewritten);
  } catch {
    return raw;
  }
  return rewritten;
}
