# Compatible apps: T3 Code and opencode

Some apps need no dedicated router target because they either **wrap an official
CLI** the router already integrates, or they **natively accept any
OpenAI-compatible provider**. This guide covers T3 Code and opencode. Nothing
here changes those apps' own subscriptions, history, or settings beyond the
additive model configuration the router owns.

## T3 Code

[T3 Code](https://betterstack.com/community/guides/ai/t3-code/) is a GUI that
drives official coding CLIs through adapters rather
than talking to models directly. Because of that, **you integrate the underlying
CLI, and T3 Code inherits the added models** — there is no T3 Code target to
install.

1. Install the target for the CLI T3 Code drives:
   - Codex adapter → install the **codex** target (`./install.sh --target codex --guided`).
2. Fully quit and reopen T3 Code so its adapter reloads the model list.
3. Pick the added model in T3 Code's model selector; project context and thread
   history are preserved by T3 Code as usual.

As T3 Code's Cursor and opencode adapters mature, the corresponding target below
applies the same way.

## opencode

[opencode](https://opencode.ai/docs/providers/) natively supports any
OpenAI-compatible provider, and this repository ships opencode as a first-class
router target. The installer writes the `codex-router` provider block into
opencode's config and generates one **subagent** for every selected model, so
you can pin DeepSeek, Kimi, Grok, or any other routed model as an opencode
Task/@-mention subagent without hand-writing opencode's `agent` section.

1. Install the opencode target:
   ```sh
   ./install.sh --target opencode --guided
   ```
   Noninteractive installs can pass `--auto --providers deepseek,kimi-oauth`.
2. Add credentials when prompted, or before installing:
   ```sh
   ./bin/model-router opencode provider-key deepseek set
   ```
3. The installer adds the `codex-router` provider and an `agent` entry per
   selected model, for example:
   ```json
   {
     "agent": {
       "deepseek-deepseek-v4-pro": {
         "mode": "subagent",
         "model": "codex-router/deepseek-v4-pro"
       },
       "kimi-oauth-kimi-for-coding": {
         "mode": "subagent",
         "model": "codex-router/kimi-oauth-kimi-for-coding"
       }
     }
   }
   ```
   The subagent name is derived from the model slug, and the model id is the
   gateway model exposed by the `codex-router` provider.
4. Fully quit and reopen opencode. Invoke the generated subagents with
   `@agent-name` or through the Task tool.

Changing the selected providers later (`providers enable/disable` or
`provider-key ... set`) refreshes the generated provider block and subagents
without touching unrelated opencode settings.

## Why T3 Code needs no target

T3 Code is a GUI that drives official coding CLIs through adapters rather than
talking to models directly. Because of that, you integrate the underlying CLI,
and T3 Code inherits the added models — there is no T3 Code target to install.
The router's job for T3 Code is only to expose the shared provider registry
through the endpoint the driven CLI already knows how to consume.
