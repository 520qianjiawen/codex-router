// Guards the committed Homebrew formula against silent staleness.
//
// The formula embeds every pinned Python resource, so a change to
// requirements/python.txt leaves it wrong without touching the version. Nothing
// about the checked-in file looks different in that state, and the next release
// would ship a tap that installs a different dependency set than the lock
// describes. This regenerates the formula from the version, URL, and checksum
// the committed file already declares, and fails when the result differs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFormula, FORMULA_PATH } from "./generate-formula.mjs";

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function field(contents, name, pattern) {
  const match = pattern.exec(contents);
  if (!match) {
    throw new Error(`The committed formula declares no ${name}.`);
  }
  return match[1];
}

async function main() {
  const formulaPath = path.join(sourceRoot, FORMULA_PATH);
  let committed;
  try {
    committed = readFileSync(formulaPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // The first release writes this file; before then there is nothing to drift.
    process.stdout.write(
      `${JSON.stringify({ checked: false, reason: `${FORMULA_PATH} does not exist yet` })}\n`,
    );
    return;
  }

  const regenerated = await buildFormula({
    version: field(committed, "version", /^\s*version\s+"([^"]+)"/m),
    sourceUrl: field(committed, "url", /^\s*url\s+"([^"]+)"/m),
    sourceSha256: field(committed, "sha256", /^\s*sha256\s+"([a-f0-9]{64})"/m),
    pythonFormula: field(committed, "Python formula", /depends_on\s+"(python@[\d.]+)"/),
    pythonVersion: field(committed, "Python version", /depends_on\s+"python@([\d.]+)"/),
  });

  if (regenerated === committed) {
    process.stdout.write(`${JSON.stringify({ checked: true, drifted: false })}\n`);
    return;
  }

  const committedLines = committed.split("\n");
  const regeneratedLines = regenerated.split("\n");
  const firstDifference = committedLines.findIndex(
    (line, index) => line !== regeneratedLines[index],
  );
  throw new Error(
    [
      `${FORMULA_PATH} no longer matches requirements/python.txt.`,
      `First difference at line ${firstDifference + 1}:`,
      `  committed:    ${committedLines[firstDifference] ?? "(end of file)"}`,
      `  regenerated:  ${regeneratedLines[firstDifference] ?? "(end of file)"}`,
      "",
      "Regenerate it with packaging/homebrew/generate-formula.mjs using the",
      "version, URL, and checksum of the release the formula points at.",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
