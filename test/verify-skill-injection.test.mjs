import assert from "node:assert/strict";
import test from "node:test";

import { analyzeRollout, PACK_SKILLS } from "../scripts/verify-skill-injection.mjs";

function skillsBlock(packSkills = []) {
  const roots = [
    "r0 = /Users/user/.codex/skills",
    "r1 = /Users/user/.agents/skills",
  ];
  const entries = packSkills.map((skill) => `(file: r0/${skill}/SKILL.md)`);
  return `<skills_instructions>\n${roots.join("\n")}\n${entries.join("\n")}\n</skills_instructions>`;
}

function meta(model) {
  return {
    type: "session_meta",
    payload: { model, cli_version: "0.147.0-alpha.6.5", originator: "Codex Desktop" },
  };
}

function userBlock(text) {
  return {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

function execRead(skill) {
  return {
    type: "response_item",
    payload: {
      type: "function_call",
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_read",
        arguments: JSON.stringify({
          cmd: `cat /Users/user/.codex/skills/${skill}/SKILL.md`,
        }),
      },
    },
  };
}

function createThread(args) {
  return {
    type: "response_item",
    payload: {
      type: "function_call",
      item: {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "call_thread",
        arguments: JSON.stringify(args),
      },
    },
  };
}

function lines(...events) {
  return events.map((event) => JSON.stringify(event));
}

test("a routed session that lists, reads, and calls correctly passes", () => {
  const result = analyzeRollout(
    lines(
      meta("opencode-go/deepseek-v4-flash"),
      userBlock(skillsBlock(["codex-app-threads", "codex-router"])),
      execRead("codex-app-threads"),
      createThread({ prompt: "hi", target: { type: "projectless" }, title: "X" }),
    ),
    { expect: "routed" },
  );
  assert.equal(result.ok, true, JSON.stringify(result.assertions));
  assert.deepEqual(result.listed, ["codex-router", "codex-app-threads"]);
  assert.ok(result.reads.includes("codex-app-threads"));
  assert.equal(result.calls.length, 1);
  assert.ok(result.calls[0].hasPrompt && result.calls[0].hasTarget);
});

test("create_thread without prompt fails assertion (c)", () => {
  const result = analyzeRollout(
    lines(
      meta("opencode-go/deepseek-v4-flash"),
      userBlock(skillsBlock(["codex-app-threads"])),
      execRead("codex-app-threads"),
      createThread({ target: { type: "projectless" } }),
    ),
  );
  const assertion = result.assertions.find((a) => a.name.startsWith("(c)"));
  assert.equal(assertion.pass, false);
  assert.match(assertion.detail, /missing prompt and\/or target/);
});

test("a session that never lists the pack fails assertion (a)", () => {
  const result = analyzeRollout(
    lines(
      meta("opencode-go/deepseek-v4-flash"),
      userBlock("<skills_instructions>\nr0 = /Users/user/.codex/skills\n</skills_instructions>"),
      createThread({ prompt: "hi", target: { type: "projectless" } }),
    ),
  );
  const assertion = result.assertions.find((a) => a.name.startsWith("(a)"));
  assert.equal(assertion.pass, false);
});

test("a native session that reads a pack skill fails assertion (d)", () => {
  const result = analyzeRollout(
    lines(
      meta("gpt-5.6-luna"),
      userBlock(skillsBlock(["codex-app-threads"])),
      execRead("codex-app-threads"),
    ),
    { expect: "native" },
  );
  const assertion = result.assertions.find((a) => a.name.startsWith("(d)"));
  assert.equal(assertion.pass, false);
});

test("a native session that never reads a pack skill passes assertion (d)", () => {
  const result = analyzeRollout(
    lines(meta("gpt-5.6-luna"), userBlock(skillsBlock(["codex-app-threads"]))),
    { expect: "native" },
  );
  const assertion = result.assertions.find((a) => a.name.startsWith("(d)"));
  assert.equal(assertion.pass, true);
});

test("the pack list is the four shipped skills", () => {
  assert.deepEqual([...PACK_SKILLS].sort(), [
    "codex-app-threads",
    "codex-computer-use",
    "codex-in-app-browser",
    "codex-router",
  ]);
});
