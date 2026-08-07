import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("install.sh is valid POSIX shell", () => {
  const result = spawnSync("sh", ["-n", path.join(root, "install.sh")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test(
  "install.ps1 parses under powershell.exe",
  { skip: process.platform !== "win32" },
  () => {
    // The POSIX installer is covered by `sh -n` everywhere, but nothing on a
    // non-Windows machine can parse install.ps1 -- it ships edits that no
    // developer without Windows can validate. Running the real parser here is
    // the only place that gap closes.
    const escaped = path.join(root, "install.ps1").replaceAll("'", "''");
    const check = [
      "$tokens = $null; $errors = $null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
      "if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
    ].join("; ");
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", check], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  },
);

test("both installers keep the update when setup reports exit 2", () => {
  // setup.mjs exits 2 for "the checkout is healthy, configuration is
  // unfinished". The number is the contract between three files that cannot
  // import each other, so losing the branch in either installer silently
  // restores the trap where a declined prompt discards the code update.
  const posix = readFileSync(path.join(root, "install.sh"), "utf8");
  const windows = readFileSync(path.join(root, "install.ps1"), "utf8");

  assert.match(posix, /setup_status["\s]*-eq["\s]*2/);
  assert.match(windows, /\$SetupExitCode\s+-eq\s+2/);

  // The rollback must stay reachable for every other non-zero status, so an
  // unrecognized failure still restores the previous revision.
  assert.match(posix, /switch --detach "\$previous_revision"/);
  assert.match(windows, /switch --detach \$PreviousRevision/);
});
