# Local LLMs through Ollama

Codex Router treats Ollama as a managed, headless local runtime. The model
files remain in Ollama's store; the router only keeps selection, download
progress, benchmark, and catalog state under `~/.codex/codex-router`.

From the tray, open **Model settings → Local LLMs** and click **Download** on a
suggestion, or paste either form into the tag field:

```text
gemma4:12b
https://ollama.com/library/gemma4:12b
```

The click starts `ollama serve` detached from the UI. If the Ollama CLI is
missing, the router runs the official installer only as part of that explicit
install action (`brew install ollama` when Homebrew is available; otherwise the
official installer with `OLLAMA_NO_START=1` and native administrator
authorization on macOS, PolicyKit or an interactive terminal on Linux, or
WinGet on Windows). It never opens the Ollama chat window. A pull completes in the
background, then a tool-capable model is checked on and published to Codex.
The tray shows a persistent status card immediately—checking fit, preparing
Ollama, pulling layers, and then ready or failed—so a long download never looks
like a dead click.

The **View more** panel includes the complete tag inventories captured from the
official Ollama pages for Gemma 4, Qwen 3.5/3.6, Nemotron 3 Super, Ornith,
Nemotron 3, and Muse Glimmer. That includes quantized, MLX, BF16, and other
published variants—not only the family aliases. Cloud aliases are shown for
completeness but are labelled **cloud only** and cannot be downloaded as local
weights. The manifest is a dated snapshot, so arbitrary Ollama tags and model
URLs remain supported even when a newly published tag has not been added yet.
The router checks model size against available memory and disk before
downloading. An installed model's generation speed is measured on demand with
the **Speed** button and reported as tokens/second; unmeasured models never
receive a guessed number.

Useful commands:

```text
./bin/control local-models list --json
./bin/control local-models inspect https://ollama.com/library/gemma4:12b
./bin/control local-models install gemma4:12b --yes
./bin/control local-models benchmark gemma4:12b
./bin/control local-models runtime status
./bin/control local-models runtime start
./bin/control local-models runtime update --yes
```

Checking or unchecking a model refreshes the picker and gateway routes and
restarts the router service, so the newly published `local/...` route is served
by the process already running in the background. Foreground/dev routers have
no service to restart; restart them by hand after toggling.

Updating Ollama is explicit. A normal model install reuses the installed
runtime and does not replace it behind the user's back.

Downloads rated too large for the machine are stopped even when `--yes` is
present. Use `--force` only when you intentionally want to attempt one anyway.
If Ollama is not installed, first run `runtime start --yes`, then use
`install <tag> --force` for that deliberate override.
