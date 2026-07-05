# Claude Workflow

`claude-workflow` launches the normal Claude Code TUI through a private local Anthropic-compatible gateway. The main/frontier Claude model stays on Anthropic, while workflow subagents and lower-tier Claude model ids can route to Codex through your local `codex login`.

The default local setup does not require Gemini, DeepSeek, OpenAI, or Anthropic API keys. It uses Claude Code local auth for Anthropic passthrough and `codex app-server` for Codex-backed routes.

## Requirements

- Node.js 20 or newer
- `claude` CLI on `PATH`
- `codex` CLI on `PATH`
- Local Claude Code auth
- `codex login`

Check the required CLIs:

```bash
command -v claude
command -v codex
codex login status
```

## Install

```bash
npm install
npm link
```

After linking, run from the project you want Claude Code and Codex to work in:

```bash
cd /path/to/your/project
claude-workflow
```

One-shot prompt mode:

```bash
claude-workflow "Use a workflow to delegate a tiny subagent task, then summarize what happened."
```

Resume an existing Claude Code conversation through a fresh local gateway:

```bash
claude-workflow --resume d3512e5e-c859-4109-aad1-f517c268d1e5
claude-workflow --continue
```

Do not export `ANTHROPIC_BASE_URL` yourself when using the launcher. It starts the local gateway first, chooses a port, then sets `ANTHROPIC_BASE_URL` only for the child Claude process.

## Behavior

- Starts a private local gateway on `127.0.0.1` with an OS-assigned port by default.
- Starts Claude Code on `ULTRATHINK_GATEWAY_MAIN_MODEL_ID`, defaulting to `claude-fable-5[1m]`.
- Keeps the `claude-fable-5*` frontier family on Anthropic by default.
- Routes the default workflow subagent model to Codex `gpt-5.5`.
- Shows routed model metadata by default, such as `codex-gpt-5.5-medium-via-claude-sonnet-4-7`.
- Runs Codex app-server sessions with `workspace-write` and `approvalPolicy=never` unless overridden.
- Launches Claude Code with `--dangerously-skip-permissions` by default.
- Passes Claude Code session flags such as `--resume`, `-r`, `--continue`, `-c`, `--fork-session`, `--from-pr`, and `--session-id` through to interactive Claude.

Safe multi-folder behavior is the default. Leave `ULTRATHINK_GATEWAY_PORT` unset, or set it to `0`, so each `claude-workflow` process gets its own localhost port. If you force a fixed port such as `4318`, only one process can use it at a time.

## Shared Gateway Daemon

Sessions started outside the launcher, such as plain `claude`, `claude --resume`, or background workflow runs, have no private per-session gateway. If they request routed model ids directly from Anthropic, those ids can 404. The shared daemon runs the same workflow routing on a fixed local port and publishes shell exports for normal Claude Code sessions:

```bash
npm run daemon
npm run daemon:status
npm run daemon:stop
npm run daemon:log

# Install the shell hook. It writes to ~/.zshrc for zsh users and ~/.bashrc
# otherwise; remove that block to disable.
bash scripts/claude-workflow-daemon.sh install-shell
```

The daemon uses `ULTRATHINK_GATEWAY_DAEMON_PORT` (default `4318`), deliberately separate from the launcher's `ULTRATHINK_GATEWAY_PORT`. The `claude-workflow` launcher still overrides the daemon exports with its own private gateway.

To keep long-running workflows from overflowing Codex's context window, the gateway learns the upstream model window from Codex app-server usage reports and adapts each input budget to `min(configured ceiling, window * 0.8)`. The workflow launcher and daemon default `ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS` to `180000` before a live window is learned; the standalone raw gateway default is `192000`. Live sessions recycle onto a fresh bounded transcript-replay thread once reported context plus the incoming payload passes 75% of the window. New Codex threads also set `model_auto_compact_token_limit_scope=body_after_prefix` by default so post-compaction summaries do not immediately count against the next compaction window again. Claude tool results sent back to Codex dynamic tools are capped per result by `ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_MAX_BYTES` (default `10000`, set `0` to disable) and across a session by `ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES` (default `64000`, set `0` to disable). The aggregate budget resets after Codex reports a real context shrink. If Codex still reports context exhaustion before stream output is forwarded, the gateway retries on a clean thread with bounded transcript replay first, then current-request-only input.

Permission flags:

```bash
# Default behavior, made explicit
claude-workflow --yolo
claude-workflow --dangerously-skip-permissions

# Restore Claude Code permission prompts
claude-workflow --no-yolo
CLAUDE_WORKFLOW_SKIP_PERMISSIONS=false claude-workflow
```

## Configuration

Configuration is read from the parent process environment, then a project `.env`, then `~/.claude-workflow.env`, then `~/.ultrathink.env` for compatibility with the original extraction source.

Common values:

```bash
ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-fable-5[1m]
ULTRATHINK_GATEWAY_MAIN_PROVIDER=anthropic
ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=claude-fable-5*
ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID=claude-sonnet-4-7
ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.5
ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=medium
ULTRATHINK_GATEWAY_SUBAGENT_VERBOSITY=high
```

Client-visible `[1m]` suffixes are aliases only. Anthropic passthrough sends the plain API model id upstream, for example `claude-opus-4-8[1m]` -> `claude-opus-4-8`. For Opus 4.8 1M passthrough:

```bash
ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-opus-4-8[1m]
ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=claude-opus-4-8*
# Optional explicit upstream override:
# ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=claude-opus-4-8
```

Codex route:

```bash
ULTRATHINK_GATEWAY_CODEX_COMMAND=codex
ULTRATHINK_GATEWAY_CODEX_MODEL=gpt-5.5
ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT=low
ULTRATHINK_GATEWAY_CODEX_VERBOSITY=low
ULTRATHINK_GATEWAY_CODEX_SANDBOX=workspace-write
ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY=never
ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS=180000
ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_MAX_BYTES=10000
ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES=64000
ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT=0
ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE=body_after_prefix
ULTRATHINK_GATEWAY_CODEX_FORK_IDLE_TIMEOUT_MS=30000
ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS=16
```

`ULTRATHINK_GATEWAY_CODEX_COMMAND` is only the executable name or path. Do not set it to `codex app-server`; the gateway appends `app-server` itself.

DeepSeek main route:

```bash
ULTRATHINK_GATEWAY_MAIN_PROVIDER=deepseek
ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-fable-5[1m]
ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY=your_deepseek_api_key
ULTRATHINK_GATEWAY_DEEPSEEK_MODEL=deepseek-v4-pro
ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT=max
ULTRATHINK_THINKING_LEVEL=HIGH
# Optional opt-out: ULTRATHINK_THINKING_LEVEL=OFF
```

DeepSeek thinking-mode routes omit `tool_choice` because the live API rejects that field while thinking is enabled. Tools are still advertised, and DeepSeek can choose tool calls normally.
DeepSeek V4 uses a 1M context window by default, so `[1m]` Claude aliases can map directly to `deepseek-v4-pro` or `deepseek-v4-flash`.
DeepSeek thinking is enabled by default and sends `reasoning_effort=max`.
Set `ULTRATHINK_THINKING_LEVEL=OFF` to disable DeepSeek thinking; gateway requests then send `thinking.type=disabled` and omit `reasoning_effort`.

Standalone route-map entries can also use exact keys or wildcard keys. Exact keys win before wildcard keys:

```bash
ULTRATHINK_GATEWAY_EXPOSED_MODELS=claude-fable-5[1m]
ULTRATHINK_GATEWAY_ROUTE_MAP_JSON='{"claude-fable-5*":{"provider":"deepseek","model":"deepseek-v4-pro","reasoningEffort":"max","displayName":"Fable 5 via DeepSeek V4 Pro"}}'
```

Wildcard route-map keys match requests, but they are not concrete model ids. Set `ULTRATHINK_GATEWAY_EXPOSED_MODELS` when a standalone client depends on `/v1/models` discovery.

If you bind the gateway to a non-loopback host, set `ULTRATHINK_GATEWAY_SHARED_SECRET`. `claude-workflow` rejects unauthenticated non-loopback launches. If the shared secret is set and your main route still uses Anthropic passthrough, also set `ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY` on the gateway.

Corporate proxy environments are supported for gateway upstream HTTP requests through `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY`. Proxy URLs must use `http://` or `https://`. The launcher adds the local gateway host to `NO_PROXY` and `no_proxy` for the child Claude process so Claude does not try to reach `127.0.0.1` through the proxy.

See [.env.example](.env.example) for the full option set.

## Standalone Raw Gateway

The package also exposes the raw Anthropic-compatible gateway for targeted debugging:

```bash
npm run start:gateway
```

After `npm link`, `claude-workflow-gateway` starts the shared workflow daemon rather than this raw gateway.

Endpoints:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`

## Development

```bash
npm install
npm run check
npm test
```

The gateway test suite uses fake Claude/Codex app-server processes for offline coverage of routing, streaming, tool calls, session reuse, startup reservations, proxy behavior, and launcher preflight handling.
