import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";
import { toResponsesRequest } from "../src/grok-oauth-forwarder.mjs";
import { hasObjectRoot, objectRootToolSchema } from "../src/tool-schema-root.mjs";

test("object-rooted schemas are returned untouched", () => {
  const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  assert.equal(objectRootToolSchema(schema), schema);
});

test("a schema with properties but no type counts as object-rooted", () => {
  const schema = { properties: { path: { type: "string" } } };
  assert.equal(objectRootToolSchema(schema), schema);
});

// The shape the live Codex client actually sends: an object root that also
// carries a root-level union. xAI rejects it on the union alone, so declaring
// `type: "object"` must not buy a pass.
test("an object root carrying a root union is still rewritten", () => {
  const flattened = objectRootToolSchema({
    type: "object",
    properties: { mode: { type: "string" } },
    required: ["mode"],
    oneOf: [
      { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    ],
  });
  assert.equal(flattened.oneOf, undefined, "the root union is gone");
  assert.deepEqual(Object.keys(flattened.properties).sort(), ["id", "mode", "name"]);
  // "mode" binds every branch; "id" and "name" are alternatives.
  assert.deepEqual(flattened.required, ["mode"]);
  assert.equal(hasObjectRoot(flattened), true);
});

test("union roots flatten into one object with every branch property", () => {
  const flattened = objectRootToolSchema({
    oneOf: [
      { type: "object", properties: { mode: { const: "view" }, id: { type: "string" } }, required: ["mode", "id"] },
      { type: "object", properties: { mode: { const: "delete" }, force: { type: "boolean" } }, required: ["mode"] },
    ],
  });
  assert.equal(flattened.type, "object");
  assert.deepEqual(Object.keys(flattened.properties).sort(), ["force", "id", "mode"]);
  // "mode" is required by both branches, "id" only by the first.
  assert.deepEqual(flattened.required, ["mode"]);
  assert.equal(flattened.additionalProperties, true);
});

test("branches behind local $refs are resolved", () => {
  const flattened = objectRootToolSchema({
    $defs: {
      create: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    anyOf: [{ $ref: "#/$defs/create" }, { type: "null" }],
  });
  assert.deepEqual(Object.keys(flattened.properties), ["name"]);
  // The null branch is unreachable once the root must be an object, so the
  // surviving branch's own requirement stands.
  assert.deepEqual(flattened.required, ["name"]);
  assert.ok(flattened.$defs, "keeps $defs so nested refs still resolve");
});

test("self-referential $refs terminate", () => {
  const flattened = objectRootToolSchema({
    $defs: { loop: { anyOf: [{ $ref: "#/$defs/loop" }] } },
    oneOf: [{ $ref: "#/$defs/loop" }],
  });
  assert.equal(flattened.type, "object");
  assert.deepEqual(flattened.properties, {});
});

test("a union with no object branch still yields a permissive object", () => {
  const flattened = objectRootToolSchema({ anyOf: [{ type: "string" }, { type: "number" }] });
  assert.equal(flattened.type, "object");
  assert.equal(flattened.additionalProperties, true);
});

test("non-schema input yields an empty object schema", () => {
  assert.deepEqual(objectRootToolSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(objectRootToolSchema("nonsense"), { type: "object", properties: {} });
});

// The regression this exists for: xAI answers
// "[invalid_client_tool_schema] codex_app__automation_update: tool parameter
// root must be an object type" and fails the entire request, so a Grok session
// could not complete a single turn while the Codex app toolset was attached.
test("every Codex app tool reaches xAI with an object root", () => {
  const appTools = CODEX_APP_TOOLS.flatMap((entry) =>
    entry.type === "namespace" ? entry.tools : [entry],
  );
  const unionRooted = appTools.filter((tool) => !hasObjectRoot(tool.inputSchema));
  assert.ok(
    unionRooted.length > 0,
    "expected at least one union-rooted app tool, or this test proves nothing",
  );

  const request = toResponsesRequest({
    model: "grok-4.6",
    messages: [{ role: "user", content: "hi" }],
    tools: appTools.map((tool) => ({
      type: "function",
      function: { name: `codex_app__${tool.name}`, parameters: tool.inputSchema },
    })),
  });
  for (const tool of request.tools.filter((entry) => entry.type === "function")) {
    assert.ok(
      hasObjectRoot(tool.parameters),
      `${tool.name} would be rejected by xAI: root is not an object`,
    );
  }
});

test("automation_update keeps its branch fields after flattening", () => {
  const automationUpdate = CODEX_APP_TOOLS.flatMap((entry) =>
    entry.type === "namespace" ? entry.tools : [entry],
  ).find((tool) => tool.name === "automation_update");
  assert.ok(automationUpdate, "automation_update is still part of the app toolset");

  const flattened = objectRootToolSchema(automationUpdate.inputSchema);
  assert.equal(flattened.type, "object");
  assert.ok(
    Object.keys(flattened.properties).includes("mode"),
    "the discriminating field survives the merge",
  );
});
