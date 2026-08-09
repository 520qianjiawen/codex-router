// Install the codex-router skill pack into the Codex app's user-skill
// directory. The pack teaches custom routed models how to use the app's
// native tools; it never touches official plugins or any other user skill.
//
// Every installed skill directory carries a `.codex-router-managed` marker,
// so uninstall removes exactly what install created and never a user's own
// skill. A target directory that exists without the marker is left
// untouched, with a warning. Install is idempotent: re-running it updates
// only the directories codex-router already owns.
//
// CLI: node src/skills-install.mjs install|uninstall
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = ".codex-router-managed";

// The pack source directory. Overridable for tests via the environment.
function skillsSource() {
  return process.env.CODEX_ROUTER_SKILLS_DIR || path.join(SOURCE_ROOT, "skills");
}

export function codexSkillsDir(codexHome) {
  return path.join(codexHome, "skills");
}

// The pack names this checkout ships: source directories with a SKILL.md,
// excluding hidden directories.
export function packSkillNames() {
  const sourceRoot = skillsSource();
  if (!existsSync(sourceRoot)) return [];
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        existsSync(path.join(sourceRoot, entry.name, "SKILL.md")),
    )
    .map((entry) => entry.name)
    .sort();
}

export function managedSkillNames(codexHome) {
  const dir = codexSkillsDir(codexHome);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, MARKER)))
    .map((entry) => entry.name)
    .sort();
}

// Compare the installed pack against the checkout. Returns the names of
// managed skills whose installed content differs from the source (missing,
// changed, or extra files). The marker file is ignored in the comparison.
export function installedSkillsFresh(codexHome) {
  const sourceRoot = skillsSource();
  if (!existsSync(sourceRoot)) return { fresh: true, stale: [] };
  const stale = [];
  for (const name of packSkillNames()) {
    if (!sameDirContent(path.join(sourceRoot, name), path.join(codexSkillsDir(codexHome), name))) {
      stale.push(name);
    }
  }
  return { fresh: stale.length === 0, stale };
}

function sameDirContent(source, target) {
  if (!existsSync(target)) return false;
  const visible = (entries) =>
    entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  const a = readdirSync(source, { withFileTypes: true });
  const b = readdirSync(target, { withFileTypes: true });
  if (JSON.stringify(visible(a)) !== JSON.stringify(visible(b))) return false;
  for (const entry of a) {
    if (entry.name.startsWith(".")) continue;
    const pa = path.join(source, entry.name);
    const pb = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (!sameDirContent(pa, pb)) return false;
    } else {
      try {
        if (!readFileSync(pa).equals(readFileSync(pb))) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

export function installSkills(codexHome, { quiet = false } = {}) {
  const sourceRoot = skillsSource();
  if (!existsSync(sourceRoot)) {
    if (!quiet) {
      console.error("codex-router: no skills/ directory in this checkout; nothing to install.");
    }
    return { installed: 0, skipped: 0 };
  }
  const target = codexSkillsDir(codexHome);
  mkdirSync(target, { recursive: true });
  const sourceNames = new Set();
  let installed = 0;
  let skipped = 0;
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue; // never copy hidden directories
    const source = path.join(sourceRoot, entry.name);
    if (!existsSync(path.join(source, "SKILL.md"))) {
      if (!quiet) {
        console.error(`codex-router: skipping ${entry.name} (no SKILL.md).`);
      }
      continue;
    }
    sourceNames.add(entry.name);
    const dest = path.join(target, entry.name);
    if (existsSync(dest) && !existsSync(path.join(dest, MARKER))) {
      // Another tool or the user already owns this name. Never clobber it.
      if (!quiet) {
        console.error(
          `codex-router: not overwriting existing skill "${entry.name}" (not managed by codex-router).`,
        );
      }
      skipped += 1;
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(source, dest, { recursive: true });
    writeFileSync(
      path.join(dest, MARKER),
      "Installed by codex-router. Remove this directory to uninstall the skill.\n",
    );
    installed += 1;
  }
  // Prune managed directories the pack no longer ships, so the installed set
  // always matches the checkout. Only marker-owned dirs are removed.
  for (const name of managedSkillNames(codexHome)) {
    if (!sourceNames.has(name)) {
      rmSync(path.join(target, name), { recursive: true, force: true });
      if (!quiet) console.error(`codex-router: removed stale managed skill "${name}".`);
    }
  }
  return { installed, skipped };
}

export function uninstallSkills(codexHome, { quiet = false } = {}) {
  const names = managedSkillNames(codexHome);
  const dir = codexSkillsDir(codexHome);
  for (const name of names) {
    rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  if (!quiet && names.length > 0) {
    console.error(`codex-router: removed managed skill(s): ${names.join(", ")}`);
  }
  return names.length;
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

const [, , command] = process.argv;
if (command === "install" || command === "uninstall") {
  try {
    if (command === "install") {
      const { installed, skipped } = installSkills(codexHome());
      console.error(
        `codex-router: installed ${installed} skill(s) into ${codexSkillsDir(codexHome())}${
          skipped ? `, skipped ${skipped} (name already owned)` : ""
        }.`,
      );
    } else {
      uninstallSkills(codexHome());
      console.error("codex-router: codex-router skills removed.");
    }
  } catch (error) {
    // Best effort: a skill install failure must never roll back the router.
    console.error(`codex-router: skill ${command} failed: ${error.message}`);
  }
  process.exit(0);
}
