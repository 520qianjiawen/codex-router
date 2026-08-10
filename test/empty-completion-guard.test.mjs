import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { EmptyCompletionGuard } from "../src/empty-completion-guard.mjs";

async function runGuard(
  input,
  {
    retried = false,
    suppressPrologue = false,
    contentType = "text/event-stream; charset=utf-8",
    chunkSize = 0,
  } = {},
) {
  const guard = new EmptyCompletionGuard(contentType, { retried, suppressPrologue });
  const chunks = [];
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  // `chunkSize` splits the body at arbitrary offsets so a test can prove the
  // guard's decision does not depend on upstream chunk boundaries.
  const source = [];
  if (chunkSize > 0) {
    for (let at = 0; at < input.length; at += chunkSize) {
      source.push(Buffer.from(input.slice(at, at + chunkSize)));
    }
  } else {
    source.push(Buffer.from(input));
  }
  await pipeline(Readable.from(source), guard, collector);
  return {
    body: Buffer.concat(chunks).toString("utf8"),
    empty: guard.isEmpty(),
    sawPrologue: guard.sawPrologue(),
  };
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

// Some gateways stream no deltas at all and deliver the whole turn inside the
// terminal `response.completed`. The guard has to read that payload before it
// decides to hold the event, or the one event carrying the answer is the one
// event it suppresses -- turning a good turn into a retried, then failed, one.
const COMPLETED_CARRIES_OUTPUT = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r1"}}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "r1",
      output: [{ type: "message", content: [{ type: "output_text", text: "Here is the answer" }] }],
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

test("a turn whose only content rides on response.completed is not empty", async () => {
  const { body, empty } = await runGuard(COMPLETED_CARRIES_OUTPUT);
  assert.equal(empty, false);
  assert.match(body, /Here is the answer/);
  assert.match(body, /\[DONE\]/);
});

test("the completed-only turn survives arbitrary chunk boundaries", async () => {
  const { body, empty } = await runGuard(COMPLETED_CARRIES_OUTPUT, { chunkSize: 17 });
  assert.equal(empty, false);
  assert.match(body, /Here is the answer/);
});

test("chat-completions deltas count as content", async () => {
  const input = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, false);
  assert.match(body, /\[DONE\]/);
});

test("a chat-completions tool call counts as content", async () => {
  const input = [
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "exec_command" } }] } }],
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  assert.equal((await runGuard(input)).empty, false);
});

test("a chat-completions turn with only reasoning is still empty", async () => {
  const input = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { body, empty } = await runGuard(input);
  assert.equal(empty, true);
  assert.doesNotMatch(body, /\[DONE\]/);
});

test("a retry drops its duplicate prologue so one response has one created event", async () => {
  const { body } = await runGuard(CONTENT_TURN, { retried: true, suppressPrologue: true });
  // The first attempt already sent `response.created`; a second one inside the
  // same response would restart ids and sequence numbers mid-stream.
  assert.doesNotMatch(body, /response\.created/);
  assert.match(body, /Hello/);
  assert.match(body, /response\.completed/);
});

test("a retry keeps its prologue when the first attempt never sent one", async () => {
  const { body } = await runGuard(CONTENT_TURN, { retried: true, suppressPrologue: false });
  assert.match(body, /response\.created/);
});

test("the guard reports whether it opened the turn for the client", async () => {
  assert.equal((await runGuard(EMPTY_TURN)).sawPrologue, true);
  const noPrologue = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"hi"}',
    "",
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"r1","output":[]}}',
    "",
  ].join("\n");
  assert.equal((await runGuard(noPrologue)).sawPrologue, false);
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
