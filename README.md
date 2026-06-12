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

To keep long-running workflows from overflowing Codex's context window, the gateway bounds each single Codex input with `ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS` (default `256000`, set `0` to disable). Fresh canonical sessions still seed Codex with recent transcript context, but temporary fork sessions start from the current request instead of replaying the whole accumulated Claude history. If Codex still reports a context-window exhaustion before any stream output is forwarded, the gateway evicts the exhausted Codex thread and retries once on a clean thread with the current request.

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
ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=claude-fable-5*
ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID=claude-sonnet-4-7
ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.5
ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=medium
ULTRATHINK_GATEWAY_SUBAGENT_VERBOSITY=high
```

Codex route:

```bash
ULTRATHINK_GATEWAY_CODEX_COMMAND=codex
ULTRATHINK_GATEWAY_CODEX_MODEL=gpt-5.5
ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT=low
ULTRATHINK_GATEWAY_CODEX_VERBOSITY=low
ULTRATHINK_GATEWAY_CODEX_SANDBOX=workspace-write
ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY=never
ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS=256000
ULTRATHINK_GATEWAY_CODEX_FORK_IDLE_TIMEOUT_MS=30000
ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS=16
```

`ULTRATHINK_GATEWAY_CODEX_COMMAND` is only the executable name or path. Do not set it to `codex app-server`; the gateway appends `app-server` itself.

If you bind the gateway to a non-loopback host, set `ULTRATHINK_GATEWAY_SHARED_SECRET`. `claude-workflow` rejects unauthenticated non-loopback launches. If the shared secret is set and your main route still uses Anthropic passthrough, also set `ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY` on the gateway.

Corporate proxy environments are supported for gateway upstream HTTP requests through `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, and `NO_PROXY`. Proxy URLs must use `http://` or `https://`. The launcher adds the local gateway host to `NO_PROXY` and `no_proxy` for the child Claude process so Claude does not try to reach `127.0.0.1` through the proxy.

See [.env.example](.env.example) for the full option set.

## Standalone Gateway

The package also exposes the gateway for targeted debugging:

```bash
npm run start:gateway
# or, after npm link:
claude-workflow-gateway
```

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
