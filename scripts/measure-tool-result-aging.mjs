#!/usr/bin/env node

import { createReadStream } from "node:fs";
import readline from "node:readline";

import { ageToolResults } from "../src/tool-result-aging.mjs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/measure-tool-result-aging.mjs ROLLOUT.jsonl");
  process.exitCode = 2;
} else {
  const lines = readline.createInterface({ input: createReadStream(path) });
  let input = [];
  let compactions = 0;
  for await (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "compacted") {
      input = Array.isArray(row.payload?.replacement_history)
        ? row.payload.replacement_history
        : [];
      compactions += 1;
    } else if (row.type === "response_item" && row.payload) {
      input.push(row.payload);
    }
  }
  const beforeBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  const result = ageToolResults(input);
  const afterBytes = Buffer.byteLength(JSON.stringify(result.input), "utf8");
  console.log(JSON.stringify({
    source: "latest compaction replacement history plus following response items",
    compactions,
    items: input.length,
    beforeBytes,
    afterBytes,
    bytesSaved: beforeBytes - afterBytes,
    reductionPercent: Number((((beforeBytes - afterBytes) / Math.max(1, beforeBytes)) * 100).toFixed(2)),
    estimatedInputTokensBefore: Math.ceil(beforeBytes / 3.3),
    estimatedInputTokensAfter: Math.ceil(afterBytes / 3.3),
    estimatedInputTokensSaved: Math.floor((beforeBytes - afterBytes) / 3.3),
    ...result.stats,
  }, null, 2));
}
