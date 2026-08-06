import { spawnSync } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";

// Only macOS supervises the tray today. The Linux companion is launched
// directly by bin/model-router-tray and Windows has no tray build, so the
// commands succeed as no-ops there rather than failing an install.
const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;

const command = process.argv[2] || "status";

if (platform !== "darwin") {
  process.stdout.write(`${JSON.stringify({ installed: false, supported: false })}\n`);
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [path.join(SOURCE_ROOT, "src", "tray-service-macos.mjs"), ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
