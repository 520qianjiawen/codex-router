import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CollaborationToolCallTransform,
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
