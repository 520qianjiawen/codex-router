#!/usr/bin/env node
// Verify that the codex-router skill pack actually reaches routed sessions.
//
// Given a Codex session rollout (jsonl), assert:
//   (a) the app's <skills_instructions> block lists a pack skill under an
//       r0 root (the user ~/.codex/skills directory);
//   (b) the model read that SKILL.md before acting;
//   (c) every create_thread call carries prompt and target (the two required
//       fields the pack teaches);
//   (d) on a native GPT session the pack skill is never read (guards the
//       description scoping);
//   (e) reported separately: the browser and computer-use bootstrap one-liners
//       must be exercised against the live app runtime -- a rollout cannot
//       prove they execute, so the script flags them as live-only.
//
// Read-only and deterministic. Exit code is non-zero when any assertion fails.
//
// Usage:
//   node scripts/verify-skill-injection.mjs <rollout.jsonl> [--expect routed|native]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACK_SKILLS = [
  "codex-router",
  "codex-app-threads",
  "codex-in-app-browser",
  "codex-computer-use",
];

function parseRollout(lines) {
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // tolerate a non-JSON line (never in real rollouts)
    }
  }
  return events;
}

// Find every injected text block (user and developer message content) so the
// skills_instructions listing can be located. The app lands the block in a
// user message on some sessions and a developer message on others.
function injectedTexts(events) {
  const texts = [];
  for (const event of events) {
    const payload = event?.payload || {};
    if (!["user", "developer"].includes(payload.role)) continue;
    if (typeof payload.content === "string") {
      texts.push(payload.content);
    }
    if (Array.isArray(payload.content)) {
      for (const part of payload.content) {
        if (part?.type === "input_text" && typeof part.text === "string") {
          texts.push(part.text);
        }
      }
    }
  }
  return texts;
}

function skillsInstructions(texts) {
  const block = texts.find((text) => text.includes("<skills_instructions>"));
  return block || undefined;
}

function listedPackSkills(block) {
  const listed = new Set();
  for (const skill of PACK_SKILLS) {
    if (block.includes(`(file: r0/${skill}/SKILL.md)`)) listed.add(skill);
  }
  return [...listed];
}

function modelReadsPackSkill(events) {
  const reads = new Set();
  for (const event of events) {
    const item = event?.payload?.item || event?.payload || {};
    if (item.type !== "function_call" || item.name !== "exec_command") continue;
    const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {});
    for (const skill of PACK_SKILLS) {
      if (args.includes(`${skill}/SKILL.md`) && reads.size < PACK_SKILLS.length) {
        reads.add(skill);
      }
    }
  }
  return [...reads];
}

function createThreadCalls(events) {
  const calls = [];
  for (const event of events) {
    const item = event?.payload?.item || event?.payload || {};
    if (item.type !== "function_call") continue;
    const flat = item.name === "codex_app__create_thread";
    const native = item.name === "create_thread" && item.namespace === "codex_app";
    if (!flat && !native) continue;
    let args = {};
    try {
      args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments || {};
    } catch {
      args = {};
    }
    calls.push({ flat, native, hasPrompt: Object.hasOwn(args, "prompt"), hasTarget: Object.hasOwn(args, "target"), args });
  }
  return calls;
}

function sessionModel(events) {
  const meta = events.find((event) => event?.type === "session_meta");
  const settings = events
    .map((event) => event?.payload?.thread_settings || event?.payload)
    .find((payload) => payload?.model);
  return meta?.payload?.model || settings?.model || undefined;
}

export function analyzeRollout(lines, { expect = "routed" } = {}) {
  const events = parseRollout(lines);
  const texts = injectedTexts(events);
  const block = skillsInstructions(texts);
  const listed = block ? listedPackSkills(block) : [];
  const reads = modelReadsPackSkill(events);
  const calls = createThreadCalls(events);
  const model = sessionModel(events);
  const malformed = calls.filter((call) => !call.hasPrompt || !call.hasTarget);

  const assertions = [
    {
      name: "(a) skills_instructions lists a pack skill under r0",
      pass: listed.length > 0,
      detail: block
        ? listed.length > 0
          ? `listed: ${listed.join(", ")}`
          : "no pack skill listed in the skills_instructions block"
        : "no <skills_instructions> block found",
    },
    {
      name: "(b) the model read a pack SKILL.md before acting",
      pass: reads.length > 0,
      detail: reads.length > 0 ? `read: ${reads.join(", ")}` : "no pack SKILL.md read found",
    },
    {
      name: "(c) every create_thread call carries prompt and target",
      pass: calls.length > 0 && malformed.length === 0,
      detail:
        calls.length === 0
          ? "no create_thread calls in this rollout"
          : `${calls.length} call(s), ${malformed.length} missing prompt and/or target`,
    },
    {
      name: "(d) native sessions never read a pack skill",
      pass: expect === "native" ? reads.length === 0 : true,
      detail:
        expect === "native"
          ? reads.length === 0
            ? "no pack skill read (scoping holds)"
            : `pack skill(s) read on a native session: ${reads.join(", ")}`
          : `skipped (expect=${expect})`,
    },
    {
      name: "(e) browser and computer-use bootstraps execute (live-only)",
      pass: undefined,
      detail:
        "not provable from a rollout; exercise the bootstrap one-liners in a live routed session",
    },
  ];

  const failed = assertions.filter((assertion) => assertion.pass === false);
  return { model, listed, reads, calls, assertions, failed, ok: failed.length === 0 };
}

function report(result, source) {
  console.log(`verify-skill-injection: ${path.basename(source)} (model ${result.model || "unknown"})`);
  for (const assertion of result.assertions) {
    const verdict =
      assertion.pass === undefined ? "LIVE" : assertion.pass ? "PASS" : "FAIL";
    console.log(`  ${verdict.padEnd(5)} ${assertion.name}: ${assertion.detail}`);
  }
  if (result.failed.length > 0) {
    console.log(`FAILED: ${result.failed.length} assertion(s)`);
  } else {
    console.log("OK: all rollout-checkable assertions passed");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2];
  const expectFlag = process.argv.indexOf("--expect");
  const expect = expectFlag !== -1 ? process.argv[expectFlag + 1] : "routed";
  if (!source) {
    console.error("Usage: verify-skill-injection.mjs <rollout.jsonl> [--expect routed|native]");
    process.exit(2);
  }
  const result = analyzeRollout(readFileSync(source, "utf8").split("\n"), { expect });
  report(result, source);
  process.exit(result.ok ? 0 : 1);
}
