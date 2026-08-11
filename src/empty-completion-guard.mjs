import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { HeaderlessSseDetector } from "./sse-prefix.mjs";

const MAX_PRECONTENT_BYTES = 1024 * 1024;
const MAX_PRECONTENT_MS = 30_000;

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

function partHasContent(part) {
  if (!part || typeof part !== "object") return false;
  return (
    (typeof part.text === "string" && part.text.length > 0) ||
    (typeof part.refusal === "string" && part.refusal.length > 0)
  );
}

function itemHasContent(item) {
  if (!item || typeof item !== "object") return false;
  if (item.type === "function_call" || item.type === "custom_tool_call") return true;
  if (item.type && item.type !== "message") return false;
  if (Array.isArray(item.content)) return item.content.some(partHasContent);
  return partHasContent(item);
}

function outputHasContent(output) {
  if (!Array.isArray(output)) return false;
  return output.some(itemHasContent);
}

// Chat-completions SSE carries no `event:` line at all: the content lives in
// `choices[].delta.content` (or `.message.content` on a non-streamed chunk),
// and tool calls in `choices[].delta.tool_calls`. A gateway that relays that
// shape through the Responses path would otherwise look contentless to every
// check above and turn ordinary turns into empty completions.
function chunkHasChatContent(data) {
  const choices = data?.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    const delta = choice?.delta ?? choice?.message;
    if (!delta || typeof delta !== "object") return false;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
    if (typeof delta.refusal === "string") return delta.refusal.length > 0;
    if (typeof delta.content === "string") return delta.content.length > 0;
    // Some gateways send content as an array of parts, same as Responses.
    if (Array.isArray(delta.content)) return itemHasContent(delta);
    return false;
  });
}

// Content means something the client can act on: output text or a tool call.
// Reasoning deltas are deliberately not content — a turn that streams only
// reasoning and then completes with nothing is exactly the empty completion
// this guard exists to catch.
function isContentEvent(eventType, data) {
  if (typeof eventType === "string") {
    if (/(?:^|\.)output_text\.delta$/.test(eventType)) {
      return typeof data?.delta === "string" && data.delta.length > 0;
    }
    if (/(?:^|\.)output_text\.done$/.test(eventType)) {
      return typeof data?.text === "string" && data.text.length > 0;
    }
    if (/(?:^|\.)refusal\.delta$/.test(eventType)) {
      return typeof data?.delta === "string" && data.delta.length > 0;
    }
    if (/(?:^|\.)refusal\.done$/.test(eventType)) {
      return typeof data?.refusal === "string" && data.refusal.length > 0;
    }
    if (
      /(?:function_call_arguments|custom_tool_call_input)\.(?:delta|done)$/.test(
        eventType,
      )
    ) {
      return true;
    }
    if (
      eventType === "response.content_part.added" ||
      eventType === "response.content_part.done"
    ) {
      return partHasContent(data?.part);
    }
    if (
      eventType === "response.output_item.added" ||
      eventType === "response.output_item.done" ||
      eventType === "message.output_item.done"
    ) {
      return itemHasContent(data?.item);
    }
    // The completed payload carries the full output on some gateways -- the
    // whole turn arrives in one terminal event with no deltas ahead of it. A
    // completed event with output is a real turn; one with an empty output
    // array is the empty completion. This is checked before the terminal
    // branch holds the event, or a turn whose only content rides on
    // `response.completed` would be suppressed and retried as if it were
    // silent.
    if (eventType === "response.completed" || eventType === "message.completed") {
      return outputHasContent(data?.response?.output);
    }
  }
  return chunkHasChatContent(data);
}

// Watches a routed Responses stream for the "empty completion" failure mode:
// the upstream answers 200 and emits `response.completed` but never produced
// output text or a tool call. The client has no code path for "the model said
// nothing", so it silently marks the turn done — the "random stop" the app
// cannot explain. The guard holds the entire pre-content attempt, not merely
// its terminal events: an empty first attempt must contribute no response id,
// sequence number, reasoning, or other prologue bytes to the retry the caller
// ultimately sees.
export class EmptyCompletionGuard extends Transform {
  #eventStream;
  #decoder = new StringDecoder("utf8");
  #parseBuffer = "";
  #chunks = [];
  #bufferedBytes = 0;
  #sawContent = false;
  #sawTerminal = false;
  #empty = false;
  #released = false;
  #releasedForBudget = false;
  #headerlessDetector;
  #maxPreludeBytes;
  #maxPreludeMs;
  #timer;

  constructor(
    contentType = "",
    { maxPreludeBytes = MAX_PRECONTENT_BYTES, maxPreludeMs = MAX_PRECONTENT_MS } = {},
  ) {
    super();
    const declared = String(contentType).toLowerCase();
    this.#eventStream = declared.includes("text/event-stream");
    this.#headerlessDetector =
      !this.#eventStream && !declared.includes("json")
        ? new HeaderlessSseDetector()
        : undefined;
    this.#maxPreludeBytes =
      Number.isFinite(maxPreludeBytes) && maxPreludeBytes >= 0
        ? Math.floor(maxPreludeBytes)
        : MAX_PRECONTENT_BYTES;
    this.#maxPreludeMs =
      Number.isFinite(maxPreludeMs) && maxPreludeMs >= 0
        ? maxPreludeMs
        : MAX_PRECONTENT_MS;
    if (this.#eventStream) this.#startTimer();
  }

  isEmpty() {
    return this.#empty;
  }

  hasContent() {
    return this.#sawContent;
  }

  // True when the stream was released by the hold budget (byte cap or timer)
  // rather than by a content or terminal verdict. The turn is then relayed
  // unchanged and never classified empty — the conservative choice — but the
  // caller can tell "released because we could not afford to hold it" apart
  // from "released because it produced something", which is the difference
  // between "may have been an empty completion we chose not to retry" and a
  // healthy turn in the meter.
  releasedForBudget() {
    return this.#releasedForBudget;
  }

  _transform(chunk, _encoding, callback) {
    if (this.#headerlessDetector) {
      const detected = this.#headerlessDetector.write(chunk);
      if (detected.decision === "pending") {
        callback();
        return;
      }
      this.#headerlessDetector = undefined;
      this.#eventStream = detected.decision === "event-stream";
      if (this.#eventStream) this.#startTimer();
      for (const buffered of detected.chunks) this.#transformChunk(buffered);
      callback();
      return;
    }
    this.#transformChunk(chunk);
    callback();
  }

  #transformChunk(chunk) {
    if (!this.#eventStream) {
      // Non-streaming bodies pass through untouched; only streamed turns
      // exhibit the empty-completion failure.
      this.push(chunk);
      return;
    }
    if (this.#released) {
      this.push(chunk);
      return;
    }
    const bytes = Buffer.from(chunk);
    this.#chunks.push(bytes);
    this.#bufferedBytes += bytes.length;
    this.#parseBuffer += this.#decoder.write(bytes);
    this.#consumeBlocks();
    if (!this.#released && this.#bufferedBytes > this.#maxPreludeBytes) {
      this.#release({ budget: true });
    }
  }

  _flush(callback) {
    if (this.#headerlessDetector) {
      const detected = this.#headerlessDetector.end();
      this.#headerlessDetector = undefined;
      this.#eventStream = detected.decision === "event-stream";
      if (this.#eventStream) this.#startTimer();
      for (const buffered of detected.chunks) this.#transformChunk(buffered);
    }
    this.#clearTimer();
    if (!this.#eventStream) {
      this.push(this.#decoder.end());
      callback();
      return;
    }
    if (this.#released) {
      callback();
      return;
    }
    this.#parseBuffer += this.#decoder.end();
    if (this.#parseBuffer) {
      // The final block may lack its trailing blank line; it is still a
      // complete SSE block for our purposes.
      this.#classifyBlock(this.#parseBuffer);
      this.#parseBuffer = "";
    }
    if (!this.#sawContent && this.#sawTerminal) {
      this.#empty = true;
      this.#chunks = [];
      this.#bufferedBytes = 0;
    } else {
      // A clean EOF without a protocol terminal is not proof of an empty
      // completion. Preserve it and let ordinary stream handling decide.
      this.#release();
    }
    callback();
  }

  _destroy(error, callback) {
    this.#clearTimer();
    callback(error);
  }

  #consumeBlocks() {
    const blocks = this.#parseBuffer.split(/\r?\n\r?\n/);
    this.#parseBuffer = blocks.pop() || "";
    for (const block of blocks) {
      this.#classifyBlock(block);
      if (this.#released) return;
    }
  }

  #classifyBlock(block) {
    const { eventType, dataText } = this.#fields(block);
    // Content is decided before the terminal check: a gateway that puts the
    // whole turn in `response.completed` emits a terminal event that is also
    // the only content event in the stream.
    const content = this.#contentOf(eventType, dataText);
    if (content === true) {
      this.#sawContent = true;
      this.#release();
      return;
    }
    if (isTerminalEvent(eventType, dataText)) {
      // A terminal event whose payload cannot be parsed is not evidence of an
      // empty completion — the very event that would carry the output is the
      // one we could not read. Release the stream (indeterminate) rather than
      // declaring the turn empty and forcing a retry of a possibly valid one.
      if (content === undefined) {
        this.#release();
        return;
      }
      this.#sawTerminal = true;
    }
  }

  #release({ budget = false } = {}) {
    if (this.#released) return;
    this.#released = true;
    if (budget) this.#releasedForBudget = true;
    this.#clearTimer();
    for (const chunk of this.#chunks) this.push(chunk);
    this.#chunks = [];
    this.#bufferedBytes = 0;
    this.#parseBuffer = "";
  }

  #clearTimer() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #startTimer() {
    if (this.#timer || this.#released) return;
    this.#timer = setTimeout(() => this.#release({ budget: true }), this.#maxPreludeMs);
    this.#timer.unref?.();
  }

  #fields(block) {
    let eventType = undefined;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const value = line.slice(5);
        dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
      }
    }
    return {
      eventType,
      // The SSE algorithm joins repeated data fields with a line feed before
      // dispatch. Overwriting them truncates valid multiline JSON and can turn
      // a content event into a false empty completion.
      dataText: dataLines.length ? dataLines.join("\n") : undefined,
    };
  }

  #contentOf(eventType, dataText) {
    if (!dataText || dataText === "[DONE]") return false;
    try {
      const data = JSON.parse(dataText);
      return isContentEvent(eventType ?? data?.type, data);
    } catch {
      // Indeterminate, not "no content": the payload could not be parsed, so
      // the absence of recognized content says nothing about whether the turn
      // produced output. Callers must not treat this as evidence of an empty
      // completion.
      return undefined;
    }
  }
}
