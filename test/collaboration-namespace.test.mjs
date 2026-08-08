import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CollaborationToolCallTransform,
  flattenCollaborationHistory,
  flattenCollaborationNamespaceTools,
} from "../src/collaboration-namespace.mjs";

function collect(stream) {
  return new Promise((resolve, reject) => {
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    stream.on("end", () => resolve(output));
    stream.on("error", reject);
  });
}

test("flatten collaboration namespace into plain function tools", () => {
  const { tools, flattened } = flattenCollaborationNamespaceTools([
    { type: "function", name: "exec_command" },
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "wait_agent" },
      ],
    },
  ]);
  assert.equal(flattened, true);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["exec_command", "collaboration__spawn_agent", "collaboration__wait_agent"],
  );
});

test("non-collaboration namespaces stay untouched", () => {
  const namespace = {
    type: "namespace",
    name: "mcp__node_repl",
    tools: [{ type: "function", name: "js" }],
  };
  const { tools, flattened } = flattenCollaborationNamespaceTools([
    namespace,
  ]);
  assert.equal(flattened, false);
  assert.deepEqual(tools, [namespace]);
});

test("collaboration response transform restores namespace function calls", async () => {
  const events = [
    { type: "response.created" },
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_1",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_1",
        arguments: "{}",
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new CollaborationToolCallTransform();
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"spawn_agent"/);
  assert.match(output, /"namespace":"collaboration"/);
  assert.doesNotMatch(output, /collaboration__spawn_agent/);
});

test("stored collaboration calls are renamed to match the flattened tools", () => {
  const input = flattenCollaborationHistory([
    { type: "message", role: "user", content: [] },
    { type: "function_call", name: "exec_command", call_id: "call_0" },
    {
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      call_id: "call_1",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "call_1", output: "{}" },
  ]);
  const call = input[2];
  assert.equal(call.name, "collaboration__spawn_agent");
  assert.equal(call.namespace, undefined);
  assert.equal(call.call_id, "call_1");
  assert.equal(call.arguments, "{}");
  // Unrelated items keep their identity so replay stays byte-comparable.
  assert.equal(input[1].name, "exec_command");
  assert.deepEqual(input[3], { type: "function_call_output", call_id: "call_1", output: "{}" });
});

test("collaboration history rename is idempotent and leaves other namespaces alone", () => {
  const alreadyFlat = {
    type: "function_call",
    name: "collaboration__wait_agent",
    namespace: "collaboration",
    call_id: "call_2",
  };
  const otherNamespace = {
    type: "function_call",
    name: "js",
    namespace: "mcp__node_repl",
    call_id: "call_3",
  };
  const input = flattenCollaborationHistory([alreadyFlat, otherNamespace]);
  assert.equal(input[0].name, "collaboration__wait_agent");
  assert.deepEqual(input[1], otherNamespace);
});

test("collaboration response transform restores namespace on unprefixed calls", async () => {
  const events = [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_plain",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call_plain",
        arguments: "{}",
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new CollaborationToolCallTransform();
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"spawn_agent"/);
  assert.match(output, /"namespace":"collaboration"/);
});

test("collaboration response transform leaves ordinary function calls alone", async () => {
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec",
        arguments: "{}",
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new CollaborationToolCallTransform();
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"exec_command"/);
  assert.doesNotMatch(output, /"namespace":"collaboration"/);
});
