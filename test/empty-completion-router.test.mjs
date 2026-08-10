import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

const EMPTY_SSE = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r-empty"}}',
  "",
  'event: response.reasoning_text.delta',
  'data: {"type":"response.reasoning_text.delta","delta":"thinking..."}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"r-empty","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","response":{"id":"r-empty"}}',
  "",
].join("\n");

const CONTENT_SSE = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r-content"}}',
  "",
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"Recovered"}',
  "",
  'event: response.output_text.done',
  'data: {"type":"response.output_text.done","text":"Recovered"}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"r-content","output":[]}}',
  "",
  'event: response.done',
  'data: {"type":"response.done","response":{"id":"r-content"}}',
  "",
].join("\n");

// The same two turns with the provider's own token counts attached, so a test
// can check what a retried turn reports as spend.
const EMPTY_SSE_METERED = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r-empty"}}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "r-empty",
      output: [],
      usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

const CONTENT_SSE_METERED = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"r-content"}}',
  "",
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"Recovered"}',
  "",
  "event: response.completed",
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "r-content",
      output: [],
      usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
    },
  })}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function run(env) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "empty-completion-router-state-"));
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      CODEX_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  child.stateDir = stateDir;
  return child;
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForUsageEvents(stateDir, count, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} usage events: ${child.testErrors()}`);
}

async function waitFor(url, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function readRouted(port, body) {
  const base = new URL(`${callerBaseUrl(port, CALLER_KEY)}/responses`);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: base.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer codex-caller-auth",
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        const done = () =>
          resolve({ status: response.statusCode, body: text, complete: response.complete });
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

function gateway(handler) {
  return mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    handler(request, response);
  });
}

function routerEnv(gatewayPort, routerPort) {
  return {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
  };
}

const TURN_BODY = {
  model: "deepseek/deepseek-v4-pro",
  input: "hello",
  stream: true,
};

// An empty completion used to reach the client as a clean 200 the app
// recorded as a successful turn with no content. The router must retry the
// identical request once and only surface the retry's completion.
test("an empty completion is retried once and the retry's content reaches the client", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write(posts === 1 ? EMPTY_SSE : CONTENT_SSE);
    response.end();
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    // The retry's content reached the client...
    assert.match(result.body, /Recovered/);
    // ...and exactly one completed event did: the first attempt's terminal
    // events were suppressed.
    assert.equal((result.body.match(/event: response\.completed/g) || []).length, 1);
    assert.equal((result.body.match(/event: response\.done/g) || []).length, 1);
    // ...and so did exactly one prologue: the retry's duplicate
    // `response.created`, with its new id and restarted sequence numbers, must
    // not appear inside the response the client already opened.
    assert.equal((result.body.match(/event: response\.created/g) || []).length, 1);
    assert.equal(posts, 2, "the empty first attempt must be retried");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletionRetried, true);
    assert.equal(event.emptyCompletion, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// If the retry is also empty, the client must see a stated error instead of a
// second silent success, and the meter must call it a failure.
test("a double-empty completion surfaces an error and meters 502", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write(EMPTY_SSE);
    response.end();
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.match(result.body, /event: error/);
    assert.match(result.body, /empty_completion/);
    assert.doesNotMatch(result.body, /event: response\.completed/);
    assert.equal(posts, 2, "the empty first attempt must be retried exactly once");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 502);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionRetried, true);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// The retry can fail outright. Its status and headers cannot reach the client
// -- the 200 went out with the first attempt -- so relaying its error body into
// the SSE stream would append unparseable bytes and end the turn silently,
// which is the exact failure this guard exists to remove.
test("a retry that fails upstream states the failure instead of relaying its body", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    if (posts === 1) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.end(EMPTY_SSE);
      return;
    }
    const body = JSON.stringify({ error: { message: "upstream exploded", type: "server_error" } });
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(body);
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.match(result.body, /event: error/);
    assert.match(result.body, /empty_completion_retry_failed/);
    // The upstream's own error body never reaches the stream.
    assert.doesNotMatch(result.body, /upstream exploded/);
    assert.doesNotMatch(result.body, /event: response\.completed/);
    assert.equal(posts, 2);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 500);
    assert.equal(event.emptyCompletion, true);
    assert.equal(event.emptyCompletionRetried, true);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// Both attempts were sent and both were billed. A meter that reports only the
// retry understates a retried turn by an entire prompt.
test("a retried turn meters the tokens of both attempts", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.end(posts === 1 ? EMPTY_SSE_METERED : CONTENT_SSE_METERED);
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /Recovered/);

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.emptyCompletionRetried, true);
    assert.equal(event.inputTokens, 200, "both prompts were sent, so both are reported");
    assert.equal(event.outputTokens, 5);
    assert.equal(event.totalTokens, 205);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// The retry re-sends the whole prompt. An operator who would rather pay once
// can turn the guard off, and the router must then behave exactly as it did
// before it existed: one attempt, terminal events relayed, no markers.
test("the guard can be turned off and the turn relays exactly as before", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.end(EMPTY_SSE);
  });
  const routerPort = await openPort();
  const router = run({
    ...routerEnv(gw.port, routerPort),
    CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "0",
  });

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.match(result.body, /event: response\.completed/);
    assert.match(result.body, /event: response\.done/);
    assert.doesNotMatch(result.body, /event: error/);
    assert.equal(posts, 1, "the guard is off, so nothing is retried");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});

// A normal turn must be untouched: one upstream attempt, no retry, no markers.
test("a content turn is not retried and carries no empty-completion markers", async () => {
  let posts = 0;
  const gw = await gateway((_request, response) => {
    posts += 1;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    response.write(CONTENT_SSE);
    response.end();
  });
  const routerPort = await openPort();
  const router = run(routerEnv(gw.port, routerPort));

  try {
    await waitFor(`${callerBaseUrl(routerPort, CALLER_KEY)}/models`, router);

    const result = await readRouted(routerPort, TURN_BODY);

    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.match(result.body, /Recovered/);
    assert.equal(posts, 1, "a content turn must not be retried");

    const [event] = await waitForUsageEvents(router.stateDir, 1, router);
    assert.equal(event.status, 200);
    assert.equal(event.emptyCompletion, undefined);
    assert.equal(event.emptyCompletionRetried, undefined);
  } finally {
    await stopChild(router);
    await closeServer(gw.server);
  }
});
