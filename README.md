# Claude Workflow

Claude Workflow runs Claude Code through a local gateway. Anthropic Opus 5 is
the default main model, and delegated agents run through Codex Terra with max
reasoning. The main session can also run directly on Codex, Kimi K3, or Alibaba
Qwen 3.8 Max.

The gateway preserves Claude Code's normal interface and tools. Provider
credentials stay in the gateway process and are removed from Claude, Codex,
and prerequisite-check child processes.

> [!WARNING]
> Claude Workflow starts Claude Code with `--dangerously-skip-permissions` by
> default. Use it only in repositories and machine environments you trust.
> Pass `--no-yolo` or configure `--permissions prompt` to restore prompts.

## Requirements

- Node.js 20 or newer
- Current [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- Codex CLI 0.144.1 or newer
- macOS, Linux, or WSL

The default route needs `claude auth login` and `codex login`. Direct Codex,
Kimi, and Qwen do not need an Anthropic login, but Codex authentication is
still required for delegated agents.

Native Windows is not supported. On WSL, install Node.js, Claude Code, Codex,
and Claude Workflow inside the same Linux distribution. Keep the source,
configuration, npm prefix/cache, and gateway state on the Linux filesystem,
not under `/mnt` or another DrvFS mount.

## Install

```bash
git clone https://github.com/yshaaban/claude-workflow.git
cd claude-workflow
npm install --global --install-links .
```

`--install-links` creates a self-contained global installation. The command
does not depend on the clone after installation.

For the default Opus/Terra route:

```bash
claude auth login
codex login
claude-workflow setup
cd /path/to/a/trusted/repository
claude-workflow
```

`setup` checks the platform, CLI versions, authentication, WSL paths, and the
effective route. It makes no model request and does not test provider
entitlement. Without `--prepare-claude` or `--shared`, it does not create files
or change shell settings.

## Choose a main route

```bash
claude-workflow config --main opus   # default coordinator
claude-workflow config --main codex  # direct Codex
claude-workflow config --main kimi   # K3, 1M profile
claude-workflow config --main k3     # K3, 256K profile
claude-workflow config --main qwen   # Qwen 3.8 Max, 1M/xhigh profile
claude-workflow config --main fable  # optional Anthropic Fable route
```

Default routing:

| Traffic | Claude-facing model | Upstream |
| --- | --- | --- |
| Main session | `claude-opus-5[1m]` | Anthropic `claude-opus-5` |
| Workflow agents | `codex-terra` | Codex `gpt-5.6-terra`, max reasoning |

Change the Codex agent tier and reasoning level with short names:

```bash
claude-workflow config --agents terra --effort max
claude-workflow config --agents sol --effort max
```

Terra is the balanced default. Sol is the frontier tier when capability matters
more than latency or cost. You can also provide a full model ID available to
your authenticated Codex workspace.

## Qwen 3.8 Max

The Qwen preset uses Alibaba's exact `qwen3.8-max` model through its
OpenAI-compatible Token Plan endpoint. Claude sees the durable
`qwen3.8-max[1m]` alias.

| Setting | Value |
| --- | ---: |
| Client context | 983,616 tokens |
| Maximum answer | 131,072 tokens |
| Reasoning effort | `xhigh` |
| Maximum thinking budget | 262,144 tokens |

Configure the route, add the key in an editor, and prepare Claude Code once:

```bash
codex login
claude-workflow config --main qwen
${EDITOR:-vi} ~/.claude-workflow.env
chmod 600 ~/.claude-workflow.env
claude-workflow setup --prepare-claude
claude-workflow
```

Add this line to `~/.claude-workflow.env`:

```dotenv
ULTRATHINK_GATEWAY_QWEN_API_KEY=replace_with_your_sk_sp_token_plan_key
```

The built-in endpoint is:

```text
https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
```

Token Plan keys use the `sk-sp-` prefix and must match the Token Plan endpoint.
`BAILIAN_TOKEN_PLAN_API_KEY` and `QWEN_API_KEY` are supported compatibility
aliases. A standard `DASHSCOPE_API_KEY` is used only when `QWEN_BASE_URL` or
`ULTRATHINK_GATEWAY_QWEN_BASE_URL` explicitly selects its matching endpoint.
Custom remote endpoints must use HTTPS; plain HTTP is accepted only on
loopback for a local gateway.
The Qwen profile rejects the Anthropic-compatible `/apps/anthropic` URL because
this integration uses the OpenAI-compatible transport for explicit xhigh
reasoning and tool controls.

Qwen reasoning is preserved across tool continuations. Deep-thinking mode
supports `tool_choice` values `auto` and `none`; required or named choices fail
locally rather than being silently weakened. The `/count_tokens` result is a
conservative local estimate used for compaction, not an exact billing count,
and it does not call the model.

See Alibaba's [OpenAI-compatible Qwen API](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)
and [model limits](https://help.aliyun.com/en/model-studio/text-generation-model/)
for the provider contract. Token Plan is intended for interactive coding and
agent tools; do not use the supplied plan credential for CI or batch workloads.

## Kimi K3

The Kimi preset uses the Kimi Code Anthropic-compatible API with adaptive
thinking and max reasoning. `kimi` selects the 1,048,576-token Allegretto
profile; `k3` selects the 262,144-token Moderato profile.

```bash
codex login
claude-workflow config --main kimi
${EDITOR:-vi} ~/.claude-workflow.env
chmod 600 ~/.claude-workflow.env
claude-workflow setup --prepare-claude
claude-workflow
```

```dotenv
ULTRATHINK_GATEWAY_KIMI_API_KEY=replace_with_your_kimi_code_key
```

Kimi Code and Kimi Open Platform credentials are not interchangeable. The
client alias `k3[1m]` is sent upstream as `k3`.

## Direct Codex

Use direct Codex when you want the main answer without an Anthropic coordinator
turn:

```bash
codex login
claude-workflow config --main codex --agents terra --effort max
claude-workflow setup --prepare-claude
claude-workflow
```

The main session and delegated agents use the configured Codex profile. Return
to the default coordinator with `claude-workflow config --main opus`.

## How requests are handled

```text
Claude Code
    │ Anthropic Messages
    ▼
local per-session gateway
    ├── Anthropic main route
    ├── Codex app-server
    ├── Kimi Anthropic-compatible API
    └── Qwen OpenAI-compatible API
```

Anthropic/OpenAI/Codex response conversion is local and deterministic. It does
not ask another model to rewrite or disguise a response. Direct third-party
routes also disable Claude Code's automatic terminal-title request, so a plain
prompt makes one provider request.

Tool use still requires a continuation: the provider requests a tool, Claude
Code executes it, and the provider receives the result in the next turn. A
coordinator workflow also resumes its parent after delegated work. Those are
real orchestration turns, not response-conversion overhead.

The per-session launcher starts a private loopback gateway on a dynamic port,
builds an owner-only temporary Claude settings layer, and removes it at exit.
It never stores an upstream key in that settings file.

## Large files and diffs

Claude Workflow supports repositories with very large source files and diffs,
but complete review still requires explicit coverage accounting. Start with a
file and hunk inventory, inspect bounded ranges, track omitted gaps, and never
treat truncated output as proof that the unseen lines were reviewed.

The workflow Codex profile leaves tool-output truncation to the current Codex
app-server by default. Qwen tool continuations preserve large results without
an extra gateway truncation layer. Claude's `Read` tool still uses paged,
1-based ranges.

See [Reviewing large files and diffs](docs/LARGE_FILES_AND_DIFFS.md) for the
full 12,000-line review protocol.

## Everyday commands

```bash
# Interactive session
claude-workflow

# One prompt and exit
claude-workflow "Review the current diff and delegate focused checks."

# Resume Claude Code state
claude-workflow --resume <session-id>
claude-workflow --continue

# Show or change configuration
claude-workflow config
claude-workflow config --json
claude-workflow config --permissions prompt

# Diagnostics
claude-workflow doctor
claude-workflow setup
```

Use `run` when prompt text begins with a reserved command name:

```bash
claude-workflow run "setup the repository and verify the result"
```

Pass native Claude options after `--`:

```bash
claude-workflow -- --add-dir ../shared --permission-mode plan
claude-workflow "Review the diff." -- --output-format json
```

Run `claude-workflow --help` for the complete command reference.

## Configuration

Common settings belong in `~/.claude-workflow.env`. The file must be a regular,
non-symlink file owned by the current user with mode `0600`. Exported parent
variables take precedence. `~/.ultrathink.env` remains a legacy fallback.

Workflow entrypoints ignore a repository `.env` by default. A trusted
per-session launch can opt in by exporting
`CLAUDE_WORKFLOW_LOAD_PROJECT_ENV=true` in its parent shell. Shared mode rejects
that option because its daemon is user-wide.

Use `.env.example` for the complete configuration reference. Useful defaults:

```dotenv
ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-opus-5[1m]
ULTRATHINK_GATEWAY_MAIN_PROVIDER=anthropic
ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID=claude-sonnet-5
ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.6-terra
ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max
ULTRATHINK_GATEWAY_SUBAGENT_VERBOSITY=high
```

`setup --prepare-claude` enables Claude Code's third-party-model mode. It
preserves the existing `.claude.json`, writes atomically with owner-only
permissions, and creates a private backup before changing an existing file. It
does not edit Claude user, project, or local settings. Organization-managed
Claude settings remain authoritative.

## Shared gateway

Most users should use the per-session `claude-workflow` command. Shared mode is
for explicit clients that need a stable gateway URL:

```bash
claude-workflow setup --shared --prepare-claude
claude-workflow-gateway status
claude-workflow-gateway log 100
claude-workflow-gateway restart
claude-workflow-gateway stop
```

The managed daemon defaults to `127.0.0.1:4318`. State, environment exports,
logs, and traces are owner-only. Changing a provider, key, endpoint, or model
requires a daemon restart and a new Claude session. Plain `claude` commands are
not silently routed through the gateway.

## Security boundaries

- Permission bypass is deliberate and is not a sandbox.
- The gateway binds to loopback by default. Non-loopback binds require a shared
  secret.
- Managed non-Anthropic routes use a random local gateway credential even on
  loopback.
- Put provider keys only in the owner-only user configuration. Do not place
  them in repositories, shell history, command arguments, traces, or issues.
- Provider credentials are removed from Claude, Codex, and native preflight
  child environments.
- Shared-daemon Codex threads expose only Claude-provided dynamic tools, not the
  daemon's native working directory.

See [SECURITY.md](SECURITY.md) for reporting and the full security model.

## Troubleshooting

Run these first:

```bash
claude-workflow --version
claude-workflow doctor
claude-workflow config
```

Common problems:

- `401` or `403` from Qwen: confirm the key begins with `sk-sp-`, belongs to the
  selected Token Plan and region, and is paired with the built-in endpoint.
- Qwen model unavailable: setup does not probe entitlement. Confirm that
  `qwen3.8-max` is enabled for the account and start a new session.
- Old route after a configuration change: close the Claude session. In shared
  mode, restart the gateway and open a new shell.
- WSL path rejection: move the checkout, home, npm prefix/cache, Node.js, and
  CLI installations to the Linux filesystem.
- Large or incomplete review: follow the bounded coverage process in
  `docs/LARGE_FILES_AND_DIFFS.md`.

Never attach an unredacted gateway environment file, trace, prompt, or API key
to an issue.

## Development

```bash
npm install
npm run check
npm test
npm run test:package
```

The test suite covers macOS/Linux lifecycle behavior, WSL path validation,
gateway security, provider wire contracts, installed Claude clean-home flows,
large tool results, packaging, and self-contained global installation. Live
provider calls are intentionally excluded from CI.

See [SUPPORT.md](SUPPORT.md) for supported environments and known boundaries.
