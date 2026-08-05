import path from "node:path";

import { safeIdentifier } from "./codex-agent-catalog.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { SOURCE_ROOT, TARGET } from "./paths.mjs";
import { selectedListedModels, writeProviderSelection } from "./provider-selection.mjs";
import {
  configureProvider,
  parseSetupArgs,
  run,
  selectProviders,
} from "./setup-shared.mjs";

if (TARGET !== "opencode") {
  throw new Error("opencode-setup.mjs requires MODEL_ROUTER_TARGET=opencode.");
}

const args = process.argv.slice(2);
const { guided, selectionOnly, help, providers: requested, argumentError } = parseSetupArgs(args);

if (help) {
  process.stdout.write(`Usage: model-router opencode setup [options]

Configure the local OpenAI-compatible gateway for opencode and generate one
subagent per selected model in opencode's config.

Options:
  --guided             Ask provider and authentication questions interactively
  --auto               Use already configured credentials (default)
  --providers LIST     Comma-separated provider ids
  --selection-only     Save provider selection without installing (development)
  --help               Show this help

Providers: ${[...PROVIDERS.keys()].join(", ")}
`);
  process.exit(0);
}

const providerKeyCommand = (id) => `./bin/model-router opencode provider-key ${id} set`;

function printOpencodeInstructions(providers) {
  const models = selectedListedModels();
  const subagents = models.map((model) => ({
    name: safeIdentifier(model.slug, "-"),
    model: `codex-router/${model.gatewayModel}`,
  }));
  process.stdout.write(
    `\nopencode Router is ready with: ${providers.join(", ")}\n\n` +
      "Subagents were added for every enabled model. Fully quit and reopen opencode,\n" +
      "then invoke them with @agent-name or through the Task tool.\n\n" +
      "Generated subagents:\n" +
      subagents.map(({ name, model }) => `  @${name}  ->  ${model}`).join("\n") +
      "\n\nYour existing opencode providers and agents are untouched.\n",
  );
}

async function main() {
  if (argumentError) throw new Error(argumentError);
  const providers = selectProviders({ requested, guided, appName: "opencode" });
  if (providers.length === 0) {
    throw new Error(
      "No configured provider was found. Run opencode setup with --guided or configure a provider key first.",
    );
  }
  for (const id of providers) {
    configureProvider(PROVIDERS.get(id), { guided, providerKeyCommand });
  }
  writeProviderSelection(providers);

  if (selectionOnly) {
    process.stdout.write(`${JSON.stringify({ target: "opencode", providers }, null, 2)}\n`);
    return;
  }

  if (process.platform === "win32") {
    run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(SOURCE_ROOT, "install.ps1"),
      "-CheckoutInstall",
      "-Target",
      "opencode",
    ]);
  } else {
    run(path.join(SOURCE_ROOT, "bin", "install"), []);
  }

  run(process.execPath, [path.join(SOURCE_ROOT, "src", "opencode-doctor.mjs")]);
  printOpencodeInstructions(providers);
}

main().catch((error) => {
  console.error(`opencode-router setup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
