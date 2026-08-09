---
name: codex-router
description: Orientation for custom (non-OpenAI) models running in the Codex app through the codex-router proxy. Explains that the app's native tools arrive as flattened codex_app__ and mcp__ names, that the router restores them so the app executes them, and which companion skills to read before threads, browser, or computer-use work. Use when the session uses a custom (non-OpenAI) model, for example deepseek-v4-flash or mimo-v2.5, when codex_app__ or mcp__ tool names appear in the tool list, or when thread, browser, or computer-use work is requested.
---

# Codex Router (custom models in the Codex app)

You are a custom model. The Codex app routes your traffic through codex-router.

## How your tools work

- The app's native tools appear in your tool list with flattened names:
  `codex_app__create_thread`, `codex_app__list_threads`,
  `mcp__node_repl__js`, `mcp__peekaboo__create_task`, and so on.
- Call them with exactly those names. The router restores the original
  namespace (for example `create_thread` in `codex_app`) before the app
  sees the call, so the app executes it natively.
- The router never executes an app tool. It only relays definitions and
  results. If a call fails, fix your arguments; do not try to run the tool
  yourself.
- Never spawn a side-channel driver. Do not start your own node_repl
  process, do not fake MCP metadata, do not write driver scripts. The tools
  you need are already in your tool list.

## Before each kind of work, read the matching skill

- Threads, automations, navigation: read `codex-app-threads`.
- In-app browser: read `codex-in-app-browser`.
- Computer use: read `codex-computer-use`.

## When a tool rejects your arguments

The app answers `received invalid arguments.` when you missed a required
field. Stop guessing. Read the matching skill for the exact shape, then
retry once with the correct arguments. Repeated guessing burns tokens and
turns.

## Golden rules

1. Use the tools you were given. Do not build workarounds.
2. Read the companion skill before the relevant work.
3. When a call fails, fix the arguments from the skill, then retry.
