import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { EmptyCompletionGuard } from "../src/empty-completion-guard.mjs";

async function runGuard(input, { retried = false, contentType = "text/event-stream; charset=utf-8" } = {}) {
  const guard = new EmptyCompletionGuard(contentType, { retried });
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(Readable.from([Buffer.from(input)]), guard, collector);
  return { body: Buffer.concat(chunks).toString("utf8"), empty: guard.isEmpty() };
}

const CONTENT_TURN = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"Hello"}',
  "",
  'event: response.output_text.done',
  'data: {"type":"response.output_text.done","text":"Hello"}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"r1","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","response":{"id":"r1"}}',
  "",
].join("\n");

const EMPTY_TURN = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  'event: response.reasoning_text.delta',
  'data: {"type":"response.reasoning_text.delta","delta":"thinking..."}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"r1","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","response":{"id":"r1"}}',
  "",
].join("\n");

const TOOL_CALL_TURN = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"exec_command"}}',
  "",
  'event: response.function_call_arguments.delta',
  'data: {"type":"response.function_call_arguments.delta","delta":"ls -la"}',
  "",
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"exec_command","arguments":"ls -la"}}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"r1","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","response":{"id":"r1"}}',
  "",
].join("\n");

test("a turn with output text passes through untouched and is not empty", async () => {
  const { body, empty } = await runGuard(CONTENT_TURN);
  assert.equal(empty, false);
  assert.match(body, /Hello/);
  assert.match(body, /response\.completed/);
  assert.match(body, /response\.done/);
});

test("a reasoning-only turn is flagged empty and its terminal events are suppressed", async () => {
  const { body, empty } = await runGuard(EMPTY_TURN);
  assert.equal(empty, true);
  // Live events (created, reasoning) still stream; the terminal events that
  // would let the client record a silent success do not.
  assert.match(body, /response\.created/);
  assert.match(body, /reasoning_text\.delta/);
  assert.doesNotMatch(body, /response\.completed/);
  assert.doesNotMatch(body, /response\.done/);
});

test("in retried mode an empty turn emits a stated error instead of silence", async () => {
  const { body, empty } = await runGuard(EMPTY_TURN, { retried: true });
  assert.equal(empty, true);
  assert.match(body, /event: error/);
  assert.match(body, /empty_completion/);
  assert.doesNotMatch(body, /response\.completed/);
});

test("a tool-call turn is not empty and its terminal events survive", async () => {
  const { body, empty } = await runGuard(TOOL_CALL_TURN);
  assert.equal(empty, false);
  assert.match(body, /function_call_arguments\.delta/);
  assert.match(body, /response\.completed/);
});

test("a stream that ends with only [DONE] is empty", async () => {
  const input = [
    'event: response.created',
    'data: {"type":"response.created"}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, true);
  assert.doesNotMatch(body, /\[DONE\]/);
});

test("non-SSE bodies pass through byte for byte and are never empty", async () => {
  const json = JSON.stringify({
    id: "resp_1",
    output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
  });
  const { body, empty } = await runGuard(json, { contentType: "application/json" });
  assert.equal(empty, false);
  assert.equal(body, json);
});
