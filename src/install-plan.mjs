// Every update runs the whole installer, so the expensive dependency steps are
// gated on a fingerprint of the inputs they consume. A code-only update then
// costs a service restart instead of a full `npm ci` plus a fresh PyPI
// resolution of the LiteLLM proxy tree.
//
// Each stamp lives next to the artifact it describes (`node_modules/`,
// `.venv/`), so deleting the artifact invalidates the stamp automatically and
// no state directory has to stay in sync with the checkout.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trayBundleDir } from "./tray-install.mjs";

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// litellm 1.95.0 needs fastapi<0.140 (get_flat_dependant was removed); re-test
// before lifting either pin. bin/install and install.ps1 repeat these literals
// so both scripts stay readable; `installerRequirementDrift` fails the test
// suite if a copy is edited alone.
export const PYTHON_REQUIREMENTS = ["litellm[proxy]==1.95.0", "fastapi==0.139.2"];

const STAMP_NAME = ".codex-router-install.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readFile(target) {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

export function requirementParts(requirement) {
  const [specifier, version] = String(requirement).split("==");
  return { name: specifier.replace(/\[[^\]]*\]$/, "").trim(), version: (version || "").trim() };
}

function sitePackages(root, platform) {
  if (platform === "win32") return [path.join(root, ".venv", "Lib", "site-packages")];
  const libraries = path.join(root, ".venv", "lib");
  try {
    return readdirSync(libraries)
      .filter((entry) => entry.startsWith("python"))
      .map((entry) => path.join(libraries, entry, "site-packages"));
  } catch {
    return [];
  }
}

// Distribution directories normalize the project name, so `litellm[proxy]`
// installs as `litellm-1.95.0.dist-info`.
export function installedDistributionVersion(name, { root = SOURCE_ROOT, platform = process.platform } = {}) {
  const normalized = name.toLowerCase().replace(/[-_.]+/g, "_");
  for (const directory of sitePackages(root, platform)) {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".dist-info")) continue;
      const base = entry.slice(0, -".dist-info".length);
      const separator = base.lastIndexOf("-");
      if (separator <= 0) continue;
      if (base.slice(0, separator).toLowerCase().replace(/[-_.]+/g, "_") === normalized) {
        return base.slice(separator + 1);
      }
    }
  }
  return undefined;
}

function venvPython(root, platform) {
  return platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
}

// uv writes `version_info`, the stdlib venv module writes `version`.
function venvPythonVersion(root) {
  const config = readFile(path.join(root, ".venv", "pyvenv.cfg")) || "";
  const match = config.match(/^\s*version(?:_info)?\s*=\s*(\d+\.\d+)/m);
  return match ? match[1] : "unknown";
}

// The companion is one bundle per user, not one per checkout: a `dist/` target
// inside the repository produces a separate tray for every clone and leaves
// launchd pointing at whichever one installed last.
function sourceFilesIn(dir, extensions) {
  try {
    return readdirSync(dir)
      .sort()
      .filter((entry) => extensions.some((extension) => entry.endsWith(extension)))
      .map((entry) => path.join(dir, entry));
  } catch {
    // A checkout without that companion still answers "no sources".
    return [];
  }
}

// trayDecision offers the companion on macOS *and* Linux, so both need a
// staleness answer here. Covering only macOS would leave Linux users with the
// exact drift this gating exists to stop: a companion built once and never
// rebuilt, running against router code it no longer matches.
const TRAY_PLATFORMS = {
  darwin: {
    sources: (root) => {
      const base = path.join(root, "apps", "macos", "ModelRouterTray");
      return [
        path.join(base, "Package.swift"),
        path.join(base, "Resources", "Info.plist"),
        ...sourceFilesIn(path.join(base, "Sources"), [".swift"]),
      ];
    },
    artifact: (root, home) =>
      path.join(trayBundleDir("darwin", home), "Contents", "MacOS", "ModelRouterTray"),
    stamp: (root, home) => path.join(trayBundleDir("darwin", home), "Contents", STAMP_NAME),
    // Companions built before the per-user move live inside the checkout.
    legacy: (root) =>
      path.join(root, "dist", "Model Router.app", "Contents", "MacOS", "ModelRouterTray"),
  },
  linux: {
    sources: (root) => {
      const base = path.join(root, "apps", "desktop");
      return [
        path.join(base, "package.json"),
        path.join(base, "src-tauri", "Cargo.toml"),
        path.join(base, "src-tauri", "tauri.conf.json"),
        path.join(base, "src-tauri", "build.rs"),
        ...sourceFilesIn(path.join(base, "src-tauri", "src"), [".rs"]),
        ...sourceFilesIn(path.join(base, "ui"), [".html", ".css", ".js", ".mjs"]),
      ];
    },
    // Tauri builds in place; the binary is the installed artifact and the
    // stamp sits beside it, so deleting the build tree invalidates both.
    artifact: (root) =>
      path.join(root, "apps", "desktop", "src-tauri", "target", "release", "codex-router-desktop"),
    stamp: (root) =>
      path.join(root, "apps", "desktop", "src-tauri", "target", "release", STAMP_NAME),
  },
};

export function traySourceFingerprint(root = SOURCE_ROOT, platform = process.platform) {
  const definition = TRAY_PLATFORMS[platform];
  if (!definition) return "";
  return sha256(
    definition
      .sources(root)
      .map((file) => `${path.relative(root, file)}\0${readFile(file) ?? ""}`)
      .join("\0"),
  );
}

export const STEPS = {
  "node-deps": {
    stamp: (root) => path.join(root, "node_modules", STAMP_NAME),
    fingerprint: (root) =>
      sha256(
        [
          `node:${process.versions.node.split(".")[0]}`,
          readFile(path.join(root, "package-lock.json")) ?? "",
        ].join("\0"),
      ),
    // npm writes this tree summary on every successful install; a partially
    // deleted `node_modules` therefore reads as "not installed".
    installed: (root) => existsSync(path.join(root, "node_modules", ".package-lock.json")),
    skipMessage: "Node dependencies already match package-lock.json; skipping npm ci.",
  },
  "python-deps": {
    stamp: (root) => path.join(root, ".venv", STAMP_NAME),
    fingerprint: (root) =>
      sha256([`python:${venvPythonVersion(root)}`, ...PYTHON_REQUIREMENTS].join("\0")),
    installed: (root, platform) => {
      if (!existsSync(venvPython(root, platform))) return false;
      return PYTHON_REQUIREMENTS.every((requirement) => {
        const { name, version } = requirementParts(requirement);
        return installedDistributionVersion(name, { root, platform }) === version;
      });
    },
    skipMessage: "LiteLLM already matches the pinned versions; skipping the Python install.",
  },
};

// Deliberately not a STEPS entry: those treat "artifact missing" as "run", and
// a missing tray means the user never asked for one. An update keeps whatever
// companion the user chose in sync; it never installs a new one.
//   unsupported - not macOS
//   absent      - no companion installed, leave it that way
//   skip        - installed and already matches its sources
//   rebuild     - installed but built from different sources
export function trayRebuildPlan({
  root = SOURCE_ROOT,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const definition = TRAY_PLATFORMS[platform];
  if (!definition) return "unsupported";
  if (!existsSync(definition.artifact(root, home))) {
    // A companion at a superseded location still counts as installed, so the
    // update migrates it rather than reading as "absent" and abandoning it.
    const legacy = definition.legacy?.(root);
    return legacy && existsSync(legacy) ? "rebuild" : "absent";
  }
  const stamp = readFile(definition.stamp(root, home));
  if (!stamp) return "rebuild";
  try {
    return JSON.parse(stamp)?.fingerprint === traySourceFingerprint(root, platform)
      ? "skip"
      : "rebuild";
  } catch {
    return "rebuild";
  }
}

export function recordTrayBuild({
  root = SOURCE_ROOT,
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const definition = TRAY_PLATFORMS[platform];
  if (!definition) throw new Error(`The desktop companion is not built on ${platform}.`);
  const target = definition.stamp(root, home);
  writeFileSync(
    target,
    `${JSON.stringify({ version: 1, step: "tray", fingerprint: traySourceFingerprint(root, platform) }, null, 2)}\n`,
    { encoding: "utf8" },
  );
  return target;
}

export function stepStatus(step, { root = SOURCE_ROOT, platform = process.platform } = {}) {
  const definition = STEPS[step];
  if (!definition) throw new Error(`Unknown install step: ${step}`);
  if (!definition.installed(root, platform)) return "run";
  const stamp = readFile(definition.stamp(root));
  if (!stamp) return "run";
  try {
    const parsed = JSON.parse(stamp);
    return parsed?.fingerprint === definition.fingerprint(root) ? "skip" : "run";
  } catch {
    return "run";
  }
}

export function recordStep(step, { root = SOURCE_ROOT } = {}) {
  const definition = STEPS[step];
  if (!definition) throw new Error(`Unknown install step: ${step}`);
  const target = definition.stamp(root);
  writeFileSync(
    target,
    `${JSON.stringify({ version: 1, step, fingerprint: definition.fingerprint(root) }, null, 2)}\n`,
    { encoding: "utf8" },
  );
  return target;
}

// The installers hold the pins as literals so the shell stays readable; this
// check keeps those copies identical to PYTHON_REQUIREMENTS.
export function installerRequirementDrift(root = SOURCE_ROOT) {
  return [path.join("bin", "install"), "install.ps1"].filter((script) => {
    const contents = readFile(path.join(root, script)) ?? "";
    return !PYTHON_REQUIREMENTS.every((requirement) => contents.includes(requirement));
  });
}

function main(argv) {
  const [command, step] = argv;
  if (command === "status") {
    // Fail open: an unexpected error must run the step, never skip it.
    let status = "run";
    try {
      status = stepStatus(step);
    } catch {
      status = "run";
    }
    process.stdout.write(`${status}\n`);
    return 0;
  }
  if (command === "record") {
    recordStep(step);
    return 0;
  }
  if (command === "tray-plan") {
    // Fail closed, unlike `status`: an unexpected error must leave the
    // companion alone rather than trigger a Swift build during an update.
    let plan = "absent";
    try {
      plan = trayRebuildPlan();
    } catch {
      plan = "absent";
    }
    process.stdout.write(`${plan}\n`);
    return 0;
  }
  if (command === "record-tray") {
    recordTrayBuild();
    return 0;
  }
  if (command === "requirements") {
    process.stdout.write(`${PYTHON_REQUIREMENTS.join("\n")}\n`);
    return 0;
  }
  console.error(
    "Usage: install-plan.mjs status|record <node-deps|python-deps> | tray-plan | record-tray | requirements",
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
