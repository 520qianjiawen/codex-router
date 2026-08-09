import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  installSkills,
  managedSkillNames,
  uninstallSkills,
} from "../src/skills-install.mjs";

// The repo's skill pack, installed into a throwaway codex home.
const PACK = [
  "codex-router",
  "codex-app-threads",
  "codex-in-app-browser",
  "codex-computer-use",
];

function tempCodexHome() {
  return mkdtempSync(path.join(os.tmpdir(), "codex-skills-"));
}

test("install copies every pack skill with its SKILL.md and the marker", () => {
  const home = tempCodexHome();
  try {
    const { installed, skipped } = installSkills(home, { quiet: true });
    assert.equal(skipped, 0);
    assert.equal(installed, PACK.length);
    for (const name of PACK) {
      const dir = path.join(home, "skills", name);
      assert.ok(existsSync(path.join(dir, "SKILL.md")), `${name}/SKILL.md installed`);
      assert.ok(existsSync(path.join(dir, ".codex-router-managed")), `${name} marker present`);
    }
    assert.deepEqual(managedSkillNames(home).sort(), [...PACK].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install is idempotent and refreshes managed skills", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const first = readdirSync(path.join(home, "skills")).sort();
    const { installed } = installSkills(home, { quiet: true });
    assert.equal(installed, PACK.length);
    assert.deepEqual(readdirSync(path.join(home, "skills")).sort(), first);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install never clobbers a skill the user owns", () => {
  const home = tempCodexHome();
  try {
    mkdirSync(path.join(home, "skills", "codex-app-threads"), { recursive: true });
    writeFileSync(
      path.join(home, "skills", "codex-app-threads", "SKILL.md"),
      "# user's own skill\n",
    );
    const { installed, skipped } = installSkills(home, { quiet: true });
    assert.equal(skipped, 1);
    assert.equal(installed, PACK.length - 1);
    // The user's file is untouched; no marker was added.
    assert.equal(
      readFileSync(path.join(home, "skills", "codex-app-threads", "SKILL.md"), "utf8"),
      "# user's own skill\n",
    );
    assert.ok(
      !existsSync(path.join(home, "skills", "codex-app-threads", ".codex-router-managed")),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall removes exactly the managed skills, never user skills", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    // A decoy user skill that happens to share the pack's naming space.
    mkdirSync(path.join(home, "skills", "user-custom-skill"), { recursive: true });
    writeFileSync(path.join(home, "skills", "user-custom-skill", "SKILL.md"), "# mine\n");
    const removed = uninstallSkills(home, { quiet: true });
    assert.equal(removed, PACK.length);
    assert.ok(!existsSync(path.join(home, "skills", "codex-router")));
    assert.ok(!existsSync(path.join(home, "skills", "codex-app-threads")));
    // The user's skill survives.
    assert.ok(existsSync(path.join(home, "skills", "user-custom-skill")));
    assert.deepEqual(managedSkillNames(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall on a clean home is a no-op", () => {
  const home = tempCodexHome();
  try {
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    assert.equal(installSkills(home, { quiet: true }).installed, PACK.length);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install prunes stale managed dirs the pack no longer ships", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    // Simulate a pack skill being removed in a later revision: plant a
    // managed dir that no longer exists in the source.
    const stale = path.join(home, "skills", "codex-obsolete");
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, "SKILL.md"), "# obsolete\n");
    writeFileSync(path.join(stale, ".codex-router-managed"), "x\n");
    installSkills(home, { quiet: true });
    assert.ok(!existsSync(stale), "stale managed dir removed");
    assert.ok(existsSync(path.join(home, "skills", "codex-router")), "current skills kept");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install skips hidden directories and dirs without SKILL.md", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    // A hidden dir and a non-skill dir in the source must never be copied.
    mkdirSync(path.join(fakeSource, ".hidden"), { recursive: true });
    mkdirSync(path.join(fakeSource, "no-skill-dir"), { recursive: true });
    for (const name of PACK) {
      mkdirSync(path.join(fakeSource, name), { recursive: true });
      writeFileSync(path.join(fakeSource, name, "SKILL.md"), `# ${name}\n`);
    }
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    try {
      const { installed } = installSkills(home, { quiet: true });
      assert.equal(installed, PACK.length);
      const installedNames = readdirSync(path.join(home, "skills")).sort();
      assert.ok(!installedNames.includes(".hidden"), "hidden dir not copied");
      assert.ok(!installedNames.includes("no-skill-dir"), "no-SKILL.md dir not copied");
    } finally {
      delete process.env.CODEX_ROUTER_SKILLS_DIR;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("every pack skill has valid frontmatter, a trigger description, and stays short", () => {
  const skillsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "skills",
  );
  const names = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(skillsRoot, e.name, "SKILL.md")))
    .map((e) => e.name);
  assert.ok(names.length >= 4, `pack has at least the 4 core skills, got ${names.length}`);
  for (const name of names) {
    const text = readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
    // Frontmatter parses: name matches the directory, description present.
    const match = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
    assert.ok(match, `${name}: valid frontmatter`);
    assert.equal(match[1], name, `${name}: frontmatter name matches directory`);
    // The description is what the model matches on; it must carry triggers.
    assert.match(match[2], /Use when/, `${name}: description has "Use when" triggers`);
    // Every description is scoped to custom routed models so a native GPT
    // session never triggers a skill that teaches flattened names it lacks.
    assert.match(
      match[2],
      /custom \(non-OpenAI\) model/,
      `${name}: description scoped to custom models`,
    );
    assert.ok(match[2].length <= 1024, `${name}: description within 1024 chars`);
    // Keep the pack cheap to load: short file, no emoji, no time-sensitive data.
    assert.ok(text.split("\n").length <= 100, `${name}: SKILL.md under 100 lines`);
    assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${name}: no emoji`);
    assert.doesNotMatch(text, /20\d\d-\d\d-\d\d/, `${name}: no hardcoded dates`);
  }
});
