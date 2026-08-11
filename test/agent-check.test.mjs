import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import { checkAgentCapability } from "../src/agent-check.mjs";

test("agent capability checks override user config with an ephemeral read-only sandbox", () => {
  let invocation;
  const slug = "local/test-model";
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    const marker = readdirSync(options.cwd).find((entry) => entry.startsWith("agentcheck-"));
    return { status: 0, stdout: `${marker}\n`, stderr: "" };
  };

  const result = checkAgentCapability(slug, {
    attempts: 1,
    codex: "/opt/codex",
    spawn,
    catalogSlugs: new Set([slug]),
  });

  assert.equal(result.verdict, "agent");
  assert.deepEqual(invocation.args.slice(0, 5), [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--model",
  ]);
  assert.equal(invocation.args[5], slug);
  assert.ok(invocation.args.includes("--skip-git-repo-check"));
});
