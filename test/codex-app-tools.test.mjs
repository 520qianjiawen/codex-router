import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CODEX_APP_TOOL_NAMES,
  CodexAppToolCallTransform,
  CODEX_APP_TOOLS,
  flattenCodexAppHistory,
  flattenCodexAppNamespaceTools,
  mergeCodexAppTools,
  rewriteCodexAppFunctionCall,
  splitFlatCodexAppName,
} from "../src/codex-app-tools.mjs";
import { flattenCollaborationNamespaceTools } from "../src/collaboration-namespace.mjs";

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

// The reduced codex_app namespace the client actually sends on routed requests
// (captured live: load_workspace_dependencies, navigate_to_codex_page,
// read_thread_terminal).
function clientRoutedTools() {
  return [
    { type: "function", name: "exec_command" },
    { type: "function", name: "view_image" },
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "wait_agent" },
      ],
    },
    {
      type: "namespace",
      name: "codex_app",
      tools: [
        { type: "function", name: "load_workspace_dependencies" },
        { type: "function", name: "navigate_to_codex_page" },
        { type: "function", name: "read_thread_terminal" },
      ],
    },
  ];
}

function fullAppToolNames(namespace) {
  const names = [];
  for (const entry of CODEX_APP_TOOLS) {
    if (namespace && entry.name !== namespace) continue;
    for (const fn of entry.tools || []) names.push(fn.name);
  }
  return names;
}

test("snapshot covers the full native app toolset (threads, automations, navigation)", () => {
  for (const name of [
    "create_thread",
    "list_threads",
    "read_thread",
    "fork_thread",
    "set_thread_title",
    "set_thread_archived",
    "set_thread_pinned",
    "send_message_to_thread",
    "handoff_thread",
    "wait_threads",
    "get_handoff_status",
    "automation_update",
    "list_projects",
    "open_in_codex",
    "navigate_to_codex_page",
    "read_thread_terminal",
    "load_workspace_dependencies",
  ]) {
    assert.ok(
      CODEX_APP_TOOL_NAMES.has(name),
      `snapshot must carry the app tool ${name}`,
    );
  }
});

test("merge fills the deferred app tools into the reduced client namespace", () => {
  const { tools, merged } = mergeCodexAppTools(clientRoutedTools());
  assert.equal(merged, true);
  const codexApp = tools.find((tool) => tool?.type === "namespace" && tool.name === "codex_app");
  assert.ok(codexApp, "codex_app namespace present after merge");
  const names = codexApp.tools.map((fn) => fn.name);
  for (const name of fullAppToolNames("codex_app")) {
    assert.ok(names.includes(name), `merged codex_app must include ${name}`);
  }
  // Nothing the client sent is dropped.
  assert.ok(names.includes("load_workspace_dependencies"));
  assert.ok(names.includes("navigate_to_codex_page"));
  assert.ok(names.includes("read_thread_terminal"));
  // The plugin_management namespace is appended with its own tool.
  const pluginMgmt = tools.find(
    (tool) => tool?.type === "namespace" && tool.name === "plugin_management",
  );
  assert.ok(pluginMgmt, "plugin_management namespace present after merge");
  assert.ok(pluginMgmt.tools.some((fn) => fn.name === "uninstall_plugin"));
  // Non-app tools are untouched.
  assert.ok(tools.some((tool) => tool.name === "exec_command"));
  assert.ok(
    tools.some(
      (tool) =>
        tool?.type === "namespace" &&
        tool.name === "collaboration" &&
        tool.tools.some((fn) => fn.name === "spawn_agent"),
    ),
  );
});

test("merge appends the full app namespaces when the client omits them", () => {
  const { tools, merged } = mergeCodexAppTools([
    { type: "function", name: "exec_command" },
  ]);
  assert.equal(merged, true);
  const codexApp = tools.find((tool) => tool?.type === "namespace" && tool.name === "codex_app");
  assert.ok(codexApp, "codex_app appended when absent");
  for (const name of fullAppToolNames("codex_app")) {
    assert.ok(
      codexApp.tools.some((fn) => fn.name === name),
      `appended codex_app must include ${name}`,
    );
  }
  assert.ok(
    tools.some(
      (tool) =>
        tool?.type === "namespace" &&
        tool.name === "plugin_management" &&
        tool.tools.some((fn) => fn.name === "uninstall_plugin"),
    ),
    "plugin_management appended when absent",
  );
});

test("flatten codex_app namespace into plain function tools (LiteLLM bridge drops namespaces)", () => {
  const { tools, flattened } = flattenCodexAppNamespaceTools(clientRoutedTools());
  assert.equal(flattened, true);
  const names = tools.map((tool) => tool.name);
  // The tools the client sent are flattened.
  assert.ok(names.includes("codex_app__load_workspace_dependencies"));
  assert.ok(names.includes("codex_app__navigate_to_codex_page"));
  assert.ok(names.includes("codex_app__read_thread_terminal"));
  // The collaboration namespace is not this function's job.
  assert.ok(tools.some((tool) => tool?.type === "namespace" && tool.name === "collaboration"));
});

test("full inventory survives merge + flatten with nothing dropped", () => {
  // Representative full inventory: standard + collaboration + app + plugin
  // + MCP namespaces, the shape the criterion-1 check cares about.
  const inventory = [
    { type: "function", name: "exec_command" },
    { type: "function", name: "write_stdin" },
    { type: "function", name: "update_plan" },
    { type: "function", name: "request_user_input" },
    { type: "function", name: "apply_patch" },
    { type: "function", name: "view_image" },
    { type: "function", name: "web_search" },
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        { type: "function", name: "followup_task" },
        { type: "function", name: "interrupt_agent" },
        { type: "function", name: "list_agents" },
        { type: "function", name: "send_message" },
        { type: "function", name: "spawn_agent" },
        { type: "function", name: "wait_agent" },
      ],
    },
    {
      type: "namespace",
      name: "codex_app",
      tools: [
        { type: "function", name: "load_workspace_dependencies" },
        { type: "function", name: "navigate_to_codex_page" },
        { type: "function", name: "read_thread_terminal" },
      ],
    },
    { type: "namespace", name: "mcp__node_repl", tools: [{ type: "function", name: "js" }] },
  ];
  const merged = mergeCodexAppTools(inventory);
  assert.equal(merged.merged, true);
  // The routed pipeline flattens the collaboration namespace and the app
  // namespaces for chat-completions providers (LiteLLM drops namespaces).
  const collaborationFlattened = flattenCollaborationNamespaceTools(merged.tools);
  assert.equal(collaborationFlattened.flattened, true);
  const flattened = flattenCodexAppNamespaceTools(collaborationFlattened.tools);
  assert.equal(flattened.flattened, true);
  const names = flattened.tools.map((tool) => tool.name);
  const flatNs = (ns) =>
    flattened.tools
      .filter((tool) => tool?.type === "namespace" && tool.name === ns)
      .flatMap((tool) => tool.tools.map((fn) => fn.name));
  // Nothing standard dropped.
  for (const name of ["exec_command", "write_stdin", "update_plan", "apply_patch", "view_image", "web_search"]) {
    assert.ok(names.includes(name), `${name} must survive`);
  }
  // Agent tools present (flattened).
  for (const name of ["collaboration__spawn_agent", "collaboration__wait_agent", "collaboration__list_agents"]) {
    assert.ok(names.includes(name), `${name} must survive`);
  }
  // Thread + computer-use + app tools present (flattened).
  for (const name of ["codex_app__create_thread", "codex_app__list_threads", "codex_app__automation_update", "codex_app__read_thread"]) {
    assert.ok(names.includes(name), `${name} must survive`);
  }
  // MCP namespace untouched.
  assert.deepEqual(flatNs("mcp__node_repl"), ["js"]);
});

test("stored app calls are renamed to match the flattened tools", () => {
  const input = flattenCodexAppHistory([
    { type: "message", role: "user", content: [] },
    { type: "function_call", name: "exec_command", call_id: "call_0" },
    {
      type: "function_call",
      name: "create_thread",
      namespace: "codex_app",
      call_id: "call_1",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "call_1", output: "{}" },
  ]);
  const call = input[2];
  assert.equal(call.name, "codex_app__create_thread");
  assert.equal(call.namespace, undefined);
  assert.equal(call.call_id, "call_1");
  // Unrelated items keep their identity.
  assert.equal(input[1].name, "exec_command");
  assert.deepEqual(input[3], { type: "function_call_output", call_id: "call_1", output: "{}" });
});

test("app history rename is idempotent and leaves other namespaces alone", () => {
  const alreadyFlat = {
    type: "function_call",
    name: "codex_app__list_threads",
    namespace: "codex_app",
    call_id: "call_2",
  };
  const otherNamespace = {
    type: "function_call",
    name: "js",
    namespace: "mcp__node_repl",
    call_id: "call_3",
  };
  const input = flattenCodexAppHistory([alreadyFlat, otherNamespace]);
  assert.equal(input[0].name, "codex_app__list_threads");
  assert.deepEqual(input[1], otherNamespace);
});

test("splitFlatCodexAppName parses flattened names only", () => {
  assert.deepEqual(splitFlatCodexAppName("codex_app__create_thread"), {
    namespace: "codex_app",
    name: "create_thread",
  });
  assert.equal(splitFlatCodexAppName("exec_command"), undefined);
  assert.equal(splitFlatCodexAppName("codex_app__"), undefined);
});

test("app response transform restores namespace function calls", async () => {
  const events = [
    { type: "response.created" },
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_1",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_1",
        arguments: "{}",
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new CodexAppToolCallTransform();
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"create_thread"/);
  assert.match(output, /"namespace":"codex_app"/);
  assert.doesNotMatch(output, /codex_app__create_thread/);
});

test("app response transform restores namespace on unprefixed calls", async () => {
  const events = [
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "create_thread",
        call_id: "call_plain",
        arguments: "{}",
      },
    },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const transform = new CodexAppToolCallTransform();
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"create_thread"/);
  assert.match(output, /"namespace":"codex_app"/);
});

test("app response transform leaves ordinary function calls alone", async () => {
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
  const transform = new CodexAppToolCallTransform();
  const output = await collect(Readable.from(events).pipe(transform));
  assert.match(output, /"name":"exec_command"/);
  assert.doesNotMatch(output, /"namespace":"codex_app"/);
});

test("rewriteCodexAppFunctionCall rejects non-call events", () => {
  assert.equal(rewriteCodexAppFunctionCall({ item: { type: "message" } }), undefined);
  assert.equal(rewriteCodexAppFunctionCall(undefined), undefined);
});
