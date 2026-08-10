import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const SSE_FIELD_LINE = /^(?:event|data|id|retry):/;
const SSE_SNIFF_BYTES = 256;

// A terminal SSE event for a Responses turn. `response.completed` is the
// protocol's end-of-response marker; `response.done` is the stream terminator
// that follows it; `data: [DONE]` is the chat-completions sentinel some
// gateways emit instead. All three close the response, so the guard holds
// them until it knows the turn actually produced something.
function isTerminalEvent(eventType, dataText) {
  return (
    dataText === "[DONE]" ||
    eventType === "response.completed" ||
    eventType === "response.done"
  );
}

function itemHasText(item) {
  if (!item || typeof item !== "object") return false;
  if (Array.isArray(item.content)) {
    return item.content.some(
      (part) =>
        part &&
        typeof part === "object" &&
        typeof part.text === "string" &&
        part.text.length > 0,
    );
  }
  return typeof item.text === "string" && item.text.length > 0;
}

function outputHasContent(output) {
  if (!Array.isArray(output)) return false;
  return output.some((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.type === "function_call") return true;
    return item.type === "message" && itemHasText(item);
  });
}

// Content means something the client can act on: output text or a tool call.
// Reasoning deltas are deliberately not content — a turn that streams only
// reasoning and then completes with nothing is exactly the empty completion
// this guard exists to catch.
function isContentEvent(eventType, data) {
  if (typeof eventType === "string") {
    if (/(?:^|\.)output_text\.(?:delta|done)$/.test(eventType)) return true;
    if (/function_call_arguments\.(?:delta|done)$/.test(eventType)) return true;
    if (
      eventType === "response.output_item.added" ||
      eventType === "response.output_item.done" ||
      eventType === "message.output_item.done"
    ) {
      const item = data?.item;
      if (item?.type === "function_call") return true;
      return item?.type === "message" && itemHasText(item);
    }
    // The completed payload carries the full output on some gateways; a
    // completed event with output is a real turn, one with an empty output
    // array is the empty completion.
    if (eventType === "response.completed" || eventType === "message.completed") {
      return outputHasContent(data?.response?.output);
    }
  }
  return false;
}

// The error frame mirrors `endStreamedResponse` in http-utils.mjs so the app
// renders it the same way: a stated failure instead of a silent empty success.
const EMPTY_COMPLETION_ERROR = {
  type: "error",
  code: "empty_completion",
  message:
    "The model returned an empty completion. The router retried once and the completion was empty again.",
  param: null,
};

// Watches a routed Responses stream for the "empty completion" failure mode:
// the upstream answers 200 and emits `response.completed` but never produced
// output text or a tool call. The client has no code path for "the model said
// nothing", so it silently marks the turn done — the "random stop" the app
// cannot explain. The guard detects that state and, on the first attempt,
// suppresses the terminal events so the caller can retry the identical request
// without the client ever seeing a completed-but-empty response.
export class EmptyCompletionGuard extends Transform {
  #eventStream;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #sawContent = false;
  #held = [];
  #empty = false;
  #retried;
  #undeclared;

  constructor(contentType = "", { retried = false } = {}) {
    super();
    this.#retried = retried;
    const declared = String(contentType).toLowerCase();
    this.#eventStream = declared.includes("text/event-stream");
    this.#undeclared = !this.#eventStream && !declared.includes("json");
  }

  isEmpty() {
    return this.#empty;
  }

  _transform(chunk, _encoding, callback) {
    if (this.#undeclared && chunk.length) {
      this.#undeclared = false;
      this.#eventStream = SSE_FIELD_LINE.test(
        chunk.subarray(0, SSE_SNIFF_BYTES).toString("utf8"),
      );
    }
    if (!this.#eventStream) {
      // Non-streaming bodies pass through untouched; only streamed turns
      // exhibit the empty-completion failure.
      this.push(chunk);
      callback();
      return;
    }
    this.#buffer += this.#decoder.write(chunk);
    this.#consumeBlocks();
    callback();
  }

  _flush(callback) {
    if (!this.#eventStream) {
      this.push(this.#decoder.end());
      callback();
      return;
    }
    this.#buffer += this.#decoder.end();
    if (this.#buffer) {
      // The final block may lack its trailing blank line; it is still a
      // complete SSE block for our purposes.
      this.#consumeBlock(this.#buffer, "");
      this.#buffer = "";
    }
    this.#settle();
    callback();
  }

  #consumeBlocks() {
    const blocks = this.#buffer.split(/\r?\n\r?\n/);
    this.#buffer = blocks.pop() || "";
    for (const block of blocks) {
      this.#consumeBlock(block, "\n\n");
    }
  }

  #consumeBlock(block, separator) {
    if (this.#sawContent) {
      this.push(Buffer.from(block + separator));
      return;
    }
    const { eventType, dataText } = this.#fields(block);
    if (isTerminalEvent(eventType, dataText)) {
      // Terminal events are the last thing the upstream emits, so holding
      // them changes nothing the client has already seen.
      this.#held.push(block + separator);
      return;
    }
    if (this.#contentOf(block, dataText)) {
      this.#sawContent = true;
      // A content event after a held terminal cannot happen in practice
      // (terminal events close the response), but ordering must survive it.
      for (const held of this.#held) this.push(Buffer.from(held));
      this.#held = [];
      this.push(Buffer.from(block + separator));
      return;
    }
    this.push(Buffer.from(block + separator));
  }

  #settle() {
    if (!this.#sawContent && this.#held.length) {
      this.#empty = true;
      if (this.#retried) {
        // The retry was also empty: the client must see a stated failure, not
        // a second silent success.
        this.push(
          Buffer.from(`\n\nevent: error\ndata: ${JSON.stringify(EMPTY_COMPLETION_ERROR)}\n\n`),
        );
      }
      // On the first attempt the held terminal is dropped instead: the caller
      // retries the turn, and the client must never see a completed event for
      // a turn that produced nothing.
      return;
    }
    for (const held of this.#held) this.push(Buffer.from(held));
    this.#held = [];
  }

  #fields(block) {
    let eventType = undefined;
    let dataText = undefined;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataText = line.slice(5).trimStart();
    }
    return { eventType, dataText };
  }

  #contentOf(block, dataText) {
    if (!dataText || dataText === "[DONE]") return false;
    try {
      const data = JSON.parse(dataText);
      return isContentEvent(this.#fields(block).eventType ?? data?.type, data);
    } catch {
      return false;
    }
  }
}
