import assert from "node:assert/strict";
import test from "node:test";

import {
  coerceFunctionCallArguments,
  coerceWholeNumberJson,
} from "../src/tool-arguments.mjs";

test("coerceWholeNumberJson turns whole floats into integers", () => {
  assert.deepEqual(coerceWholeNumberJson({ timeout_ms: 20000.0, workdir: "C:\\tmp" }), {
    timeout_ms: 20000,
    workdir: "C:\\tmp",
  });
  assert.equal(Object.is(coerceWholeNumberJson({ n: -0 }).n, 0), true);
  assert.equal(Number.isInteger(coerceWholeNumberJson({ n: 20000.0 }).n), true);
});

test("coerceWholeNumberJson leaves genuine fractions and non-numbers alone", () => {
  const input = {
    ratio: 3.14,
    label: "20000.0",
    flag: true,
    empty: null,
    nested: [{ wait: 1.5 }, { wait: 2.0 }],
  };
  const out = coerceWholeNumberJson(input);
  assert.equal(out.ratio, 3.14);
  assert.equal(out.label, "20000.0");
  assert.equal(out.flag, true);
  assert.equal(out.empty, null);
  assert.equal(out.nested[0].wait, 1.5);
  assert.equal(out.nested[1].wait, 2);
  assert.equal(Number.isInteger(out.nested[1].wait), true);
});

test("coerceWholeNumberJson does not invent integers past MAX_SAFE_INTEGER", () => {
  const huge = Number.MAX_SAFE_INTEGER + 2;
  assert.equal(coerceWholeNumberJson({ n: huge }).n, huge);
});

test("coerceFunctionCallArguments rewrites a complete JSON string only when needed", () => {
  const original = '{"command":"git status","timeout_ms":20000.0}';
  const rewritten = coerceFunctionCallArguments(original);
  assert.equal(rewritten, '{"command":"git status","timeout_ms":20000}');
  assert.ok(!rewritten.includes("20000.0"));
  assert.deepEqual(JSON.parse(rewritten), { command: "git status", timeout_ms: 20000 });
  assert.equal(Number.isInteger(JSON.parse(rewritten).timeout_ms), true);

  const alreadyInt = '{"timeout_ms":20000}';
  assert.equal(coerceFunctionCallArguments(alreadyInt), alreadyInt);

  const invalid = "{not json";
  assert.equal(coerceFunctionCallArguments(invalid), invalid);

  const fraction = '{"x":3.14}';
  assert.equal(coerceFunctionCallArguments(fraction), fraction);

  const quoted = '{"label":"20000.0","timeout_ms":2.0e4}';
  assert.equal(coerceFunctionCallArguments(quoted), '{"label":"20000.0","timeout_ms":20000}');
});

test("coerceFunctionCallArguments ignores non-strings", () => {
  assert.equal(coerceFunctionCallArguments(undefined), undefined);
  assert.deepEqual(coerceFunctionCallArguments({ timeout_ms: 1.0 }), { timeout_ms: 1.0 });
});
