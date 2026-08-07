import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const COLLABORATION_NAMESPACE = "collaboration";
export const COLLABORATION_TOOL_DELIMITER = "__";

function flattenToolName(namespace, name) {
  return `${namespace}${COLLABORATION_TOOL_DELIMITER}${name}`;
}

function splitFlatToolName(name) {
  if (typeof name !== "string") return undefined;
  const prefix = `${COLLABORATION_NAMESPACE}${COLLABORATION_TOOL_DELIMITER}`;
  if (!name.startsWith(prefix)) return undefined;
  const toolName = name.slice(prefix.length);
  return toolName ? { namespace: COLLABORATION_NAMESPACE, name: toolName } : undefined;
}

// LiteLLM's Responses -> Chat Completions bridge drops `type: "namespace"`
// tools, which is how Codex sends the collaboration toolset. Flatten only the
// collaboration namespace into plain functions; other namespaces are handled
// by the bridge (dropped when unsupported) or passed through on Responses
// providers.
export function flattenCollaborationNamespaceTools(tools) {
  if (!Array.isArray(tools)) return { tools, flattened: false };
  const flattened = [];
  let changed = false;
  for (const tool of tools) {
    if (tool?.type === "namespace" && tool.name === COLLABORATION_NAMESPACE) {
      for (const fn of Array.isArray(tool.tools) ? tool.tools : []) {
        flattened.push({
          ...fn,
          name: flattenToolName(COLLABORATION_NAMESPACE, fn.name),
        });
      }
      changed = true;
      continue;
    }
    flattened.push(tool);
  }
  return { tools: flattened, flattened: changed };
}

// Flattening only the tool list leaves the model reading two different names
// for the same tool: `collaboration__spawn_agent` in its tools, but a bare
// `spawn_agent` in its own call history, because LiteLLM's bridge drops the
// `namespace` field when it converts stored function calls to Chat Completions
// tool calls. The model imitates the history, emits the bare name, nothing
// rewrites it, and Codex answers `unsupported call: spawn_agent` — permanently,
// since every failure adds another bare example. Rename the history to match
// the flattened tool list so both surfaces agree.
export function flattenCollaborationHistory(input) {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (item?.type !== "function_call") return item;
    if (item.namespace !== COLLABORATION_NAMESPACE) return item;
    if (typeof item.name !== "string" || splitFlatToolName(item.name)) return item;
    const { namespace, ...rest } = item;
    return { ...rest, name: flattenToolName(COLLABORATION_NAMESPACE, item.name) };
  });
}

function rewriteCollaborationFunctionCall(event) {
  const item = event?.item;
  if (!item || item.type !== "function_call") return undefined;
  const parsed = splitFlatToolName(item.name);
  if (!parsed) return undefined;
  return {
    ...event,
    item: {
      ...item,
      name: parsed.name,
      namespace: parsed.namespace,
    },
  };
}

// Rewrites LiteLLM's flattened `collaboration__*` function calls back to the
// namespace + name shape Codex dispatches through its collaboration runtime.
export class CollaborationToolCallTransform extends Transform {
  #decoder = new StringDecoder("utf8");
  #buffer = "";

  _transform(chunk, _encoding, callback) {
    this.#buffer += this.#decoder.write(chunk);
    this.#emitCompleteEvents();
    callback();
  }

  _flush(callback) {
    this.#buffer += this.#decoder.end();
    this.#emitCompleteEvents(true);
    callback();
  }

  #emitCompleteEvents(flush = false) {
    const blocks = this.#buffer.split(/\r?\n\r?\n/);
    this.#buffer = flush ? "" : blocks.pop() || "";
    for (const block of blocks) {
      this.push(Buffer.from(this.#rewriteBlock(block)));
      this.push(Buffer.from("\n\n"));
    }
  }

  #rewriteBlock(block) {
    const lines = block.split(/\r?\n/);
    const rewritten = [];
    let changed = false;
    for (const line of lines) {
      if (!line.startsWith("data:")) {
        rewritten.push(line);
        continue;
      }
      const data = line.slice(5).trimStart();
      if (!data || data === "[DONE]") {
        rewritten.push(line);
        continue;
      }
      try {
        const event = JSON.parse(data);
        const next = rewriteCollaborationFunctionCall(event);
        if (!next) {
          rewritten.push(line);
          continue;
        }
        rewritten.push(`data: ${JSON.stringify(next)}`);
        changed = true;
      } catch {
        rewritten.push(line);
      }
    }
    return changed ? `${rewritten.join("\r\n")}\r\n` : block;
  }
}
