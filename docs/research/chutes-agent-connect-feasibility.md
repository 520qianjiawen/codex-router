# Chutes provider feasibility for Codex Router

Date checked: 2026-08-09

## Outcome

Yes. Chutes is a clean technical fit for Codex Router as an API-key-backed,
OpenAI-compatible provider. The safe first implementation should register
`chutes` as a catalog-only provider, let the user store a Chutes key through the
router's hidden local prompt/tray flow, discover models from Chutes' public live
catalog, and locally curate the models the user wants. It can participate in the
router's signed-in coexistence mode without replacing or reading the user's
ChatGPT authentication.

This feasibility check made no authenticated inference or quota-bearing request.
The remaining uncertainties require an explicitly approved, small compatibility
probe after implementation.

## Official Chutes contract

- Chutes documents the inference base URL as `https://llm.chutes.ai/v1`, with
  `Authorization: Bearer <Chutes key>`, concrete model IDs from `GET /v1/models`,
  and inference through `POST /v1/chat/completions`.
  [Connect Any Agent](https://chutes.ai/agents/connect)
- Chutes' Codex guide calls its Codex support "guide only": it works where the
  runtime accepts an OpenAI-compatible provider, but upstream Codex does not ship
  a built-in Chutes provider. Codex Router supplies exactly that missing provider
  and protocol bridge.
  [Chutes Codex guide](https://chutes.ai/agents/codex)
- The model-specific Kimi K3 OpenAPI document contains
  `/v1/chat/completions`, `/v1/completions`, and `/v1/models`; it does **not**
  advertise `/v1/responses`. Its agent guide explicitly says chat-completions
  streaming is supported.
  [Kimi K3 OpenAPI](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee/openapi.json),
  [Kimi K3 agent guide](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee/llms.txt)
- Chutes' public live catalog is the source of truth for current model IDs and
  capabilities. At the time of this check it advertised 13 hosted LLMs. The
  current `moonshotai/Kimi-K3-TEE` entry reports a 1,048,576-token context,
  65,535-token maximum output, text/image/video input, text output, and feature
  flags for tools, reasoning, JSON mode, and structured output. It also reports
  TEE-backed confidential compute and current per-token prices.
  [Live model catalog](https://llm.chutes.ai/v1/models),
  [Kimi K3 model page](https://chutes.ai/app/chute/chutes-moonshotai-kimi-k3-tee)
- Chutes separately documents function calling on its optimized vLLM/SGLang
  serving templates. That proves a supported tool-call surface, but not that
  every hosted model accepts Codex Router's forced `tool_choice: "required"`
  compatibility probe.
  [Chutes function-calling guide](https://chutes.ai/docs/guides/agents-and-tools)
- The management API exposes authenticated usage/quota surfaces including
  `GET /invocations/usage`, `GET /invocations/stats/llm`,
  `GET /users/me/quotas`, and `GET /users/me/subscription_usage`; the latter is
  described as monthly and four-hour usage versus caps. Chutes also documents
  OAuth 2.0/PKCE with `chutes:invoke`, `account:read`, and `billing:read` scopes.
  [Invocations API](https://chutes.ai/docs/api-reference/invocations),
  [Chutes authentication](https://chutes.ai/docs/getting-started/authentication),
  [Sign in with Chutes](https://chutes.ai/docs/sign-in-with-chutes/overview),
  [Management OpenAPI](https://api.chutes.ai/openapi.json)

## Why the existing router can carry it

The local router already has the needed seams:

- `src/model-registry.mjs` accepts credentialed `openai-compatible` providers,
  isolates their base URL and credential metadata, and allows only text/image
  picker modalities.
- `src/litellm-config.mjs` deliberately converts Codex Responses traffic to
  upstream Chat Completions (`use_chat_completions_api: true`) for ordinary
  OpenAI-compatible providers. Chutes therefore does not need to implement
  `/v1/responses` itself.
- `src/api-forwarder.mjs` strips the caller's OpenAI/ChatGPT headers, resolves
  only the selected provider's credential, rewrites the gateway model to the
  concrete upstream model, sends Bearer auth, and forwards streaming responses.
- `src/provider-onboarding.mjs` already produces an API-key setup card for every
  registered provider. The tray can accept the Chutes key over stdin and store
  it in the router's protected credential file; the key need not enter chat,
  command arguments, or logs.
- `src/config-manager.mjs` defines `codex-router-signed` with
  `requires_openai_auth = true`, Responses wire format, and WebSockets disabled.
  Adding a routed Chutes model does not alter that mode: native model slugs keep
  using the caller's ChatGPT session, while a Chutes slug goes through the
  gateway and only receives the locally stored Chutes key.

## Capability assessment

| Capability | Feasibility | Evidence / caveat |
|---|---|---|
| Chat Completions | Ready | Official endpoint and OpenAPI path. |
| Responses API | Bridge required | Not advertised by Chutes; the router's existing LiteLLM bridge supplies it. |
| SSE streaming | Advertised | Explicitly `Streaming: yes` in the Kimi K3 agent guide. |
| Tool calling | Advertised, probe required | Live catalog says `tools`; forced tool choice and multi-turn tool history still need a live router probe. |
| Image input | Advertised, probe required | Live Kimi K3 metadata says `text`, `image`, `video`; the router should expose only `text` and `image`, because its picker schema does not support video. |
| 1M context | Ready as metadata | Current Kimi K3 catalog value is 1,048,576; a conservative auto-compaction threshold around 900,000 matches the router's existing long-context safety margin. |
| Max output | Ready as metadata | Current catalog reports 65,535. |
| Reasoning effort picker | Conservative initially | `reasoning` is advertised, but Chutes does not document Kimi K3's accepted effort ladder in the model OpenAPI. Ship one conservative level or omit effort translation until a probe confirms the exact parameter/values. |
| Native v2 subagents | Disabled initially | Must remain unset until marker-return spawn, encrypted payload relay, and same-thread follow-up pass through signed coexistence. |
| Usage in tray | Implementable | Router traffic works generically; Chutes account quota/usage endpoints can be adapted after their authenticated response shape is captured without spending inference quota. Balance/credit semantics should not be claimed until confirmed. |

## Recommended implementation shape

1. Add a canonical `chutes` provider definition with the official base URL,
   `CHUTES_API_KEY`, a dedicated protected credential filename, a dedicated
   Keychain service name, and no OAuth requirement for the first version.
2. Ship it as **catalog-only**, because Chutes explicitly says the live catalog
   can change and static IDs are examples. Extend discovery/curation tests so
   `GET /v1/models` metadata can seed context, image, and feature choices without
   blindly asserting unverified capabilities.
3. For this user's current goal, locally curate
   `moonshotai/Kimi-K3-TEE` with context 1,048,576, auto-compact 900,000,
   max output 65,535, and picker input modalities `text,image`.
4. Add the tray provider icon/setup card, installer/provider-selection paths,
   doctor checks, support-bundle redaction, catalog/routing tests, and graceful
   usage-unavailable behavior before calling the provider complete.
5. After a fresh explicit quota-test approval, run the smallest sequence that
   proves: authenticated streaming response, forced tool call, tool result
   continuation, image input, accurate/usable token counts, signed-coexistence
   routing evidence, and only then the native subagent marker/follow-up checks.
   Do not enable `multiAgentVersion: "v2"` before all collaboration checks pass.

## Recommendation

Proceed if the user wants Chutes in the router. The lowest-risk first release is
API-key authentication plus catalog-only discovery and local Kimi K3 curation.
OAuth is technically possible, but it adds app registration, PKCE callback,
refresh-token storage, scopes, and expiry handling without being necessary for
the user's immediate goal; it should be a separate, explicitly chosen follow-up.
