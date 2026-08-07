import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  INITIAL_PROBE_DELAY_MS,
  MAX_PROBE_DELAY_MS,
  probeDelayMs,
} from "../src/health-backoff.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the first probes stay fast so a healthy service is seen immediately", () => {
  // Backing off must not make normal startup feel slower; the common case is
  // a service that is ready within a second.
  assert.equal(probeDelayMs(0), INITIAL_PROBE_DELAY_MS);
  assert.ok(probeDelayMs(1) < 500);
});

test("the delay grows and then holds at the cap", () => {
  assert.ok(probeDelayMs(2) > probeDelayMs(1));
  assert.ok(probeDelayMs(5) > probeDelayMs(3));
  assert.equal(probeDelayMs(50), MAX_PROBE_DELAY_MS);
  // Unbounded growth would overshoot the caller's timeout with one long sleep.
  assert.equal(probeDelayMs(1000), MAX_PROBE_DELAY_MS);
});

test("a nonsense attempt falls back to the initial delay", () => {
  // Never return NaN or a negative into setTimeout, which would busy-loop.
  assert.equal(probeDelayMs(Number.NaN), INITIAL_PROBE_DELAY_MS);
  assert.equal(probeDelayMs(-1), INITIAL_PROBE_DELAY_MS);
  assert.equal(probeDelayMs(Number.POSITIVE_INFINITY), MAX_PROBE_DELAY_MS);
});

test("a slow gateway boot costs far fewer probes than a flat interval", () => {
  // The gateway is allowed 300 seconds to cold start, and each probe is a
  // gateway access-log line. This is the whole reason for the change.
  const budgetMs = 300_000;
  let elapsed = 0;
  let probes = 0;
  while (elapsed < budgetMs) {
    elapsed += probeDelayMs(probes);
    probes += 1;
  }
  const flat = Math.ceil(budgetMs / INITIAL_PROBE_DELAY_MS);
  assert.ok(probes < flat / 5, `${probes} probes should be far below the flat ${flat}`);
});

test("startup polling uses the backoff rather than a fixed sleep", () => {
  const start = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.match(start, /probeDelayMs\(attempt\)/);
  // A leftover constant sleep in the same loop would silently restore the
  // flat-interval flood.
  assert.doesNotMatch(start, /setTimeout\(resolve, 200\)/);
});
