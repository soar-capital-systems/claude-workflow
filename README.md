# Claude Workflow

`claude-workflow` runs Claude Code through a local Anthropic-compatible gateway. The main/frontier model stays on Anthropic using your normal Claude Code login, while workflow subagents and selected lower-tier model IDs are routed to the local Codex CLI using `codex login`.

No model API key is required for the default setup.

```text
Claude Code -> localhost gateway -> Anthropic (main/frontier model)
                                -> Codex app-server (workflow subagents)
```

> [!WARNING]
> The launcher intentionally adds `--dangerously-skip-permissions` by default. This gives Claude Code unrestricted automation permissions. Use it only in repositories and machine environments you trust. Use `--no-yolo` when you want normal permission prompts.

## Requirements

| Component | Supported baseline | Notes |
| --- | --- | --- |
| Node.js | 20 or newer | Required by the gateway |
| Claude Code | Current native CLI; verified with 2.1.206 | Install from [Anthropic's setup guide](https://docs.anthropic.com/en/docs/claude-code/getting-started) |
| Codex CLI | 0.144.1 or newer | Required for shared-daemon dynamic-tools-only threads; see [OpenAI Codex](https://github.com/openai/codex) |
| OS | macOS, Linux, or WSL | The daemon manager requires Bash |
| Shell hook | zsh or Bash | Other shells can point `CLAUDE_WORKFLOW_SHELL_RC` at a POSIX-compatible zsh/Bash rc file |

Authenticate both CLIs before starting:

```bash
claude --version
codex --version
codex login status
```

### Default model choice

The workflow default is `gpt-5.6-terra` at `max` reasoning, exposed to Claude Code under the short stable label `codex-terra`. [OpenAI describes Terra](https://openai.com/index/previewing-gpt-5-6-sol/) as the balanced everyday GPT-5.6 tier; it costs less than Sol and is a good fit when several delegated agents may run in parallel.

For the highest single-agent capability, opt into `gpt-5.6-sol` with `max`. Sol is OpenAI's flagship and most capable tier. The workflow does not default to `ultra`: that effort can delegate to more subagents itself, which creates nested orchestration inside Claude's existing workflow delegation.

```bash
# Highest capability instead of the balanced default
ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.6-sol \
ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max \
CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID=codex-sol \
claude-workflow
```

GPT-5.6 is currently a limited preview. The configured model must appear in `codex app-server`'s model catalog for your Codex workspace. If your account does not have it, set the upstream model to one your workspace exposes.

## Install

```bash
git clone https://github.com/yshaaban/claude-workflow.git
cd claude-workflow
npm ci
npm link
```

`npm link` installs two commands:

- `claude-workflow` — per-session launcher with an isolated dynamic localhost port.
- `claude-workflow-gateway` — shared-daemon lifecycle manager.

## Quick start

Run from the repository Claude should work in:

```bash
cd /path/to/project
claude-workflow
```

One-shot prompt:

```bash
claude-workflow "Delegate a focused review to workflow subagents, then summarize the findings."
```

Resume or continue a Claude Code session:

```bash
claude-workflow --resume <session-id>
claude-workflow --continue
```

The launcher owns model routing. Put wrapper options before `--` and native Claude options or commands after it:

```bash
# One-shot JSON output
claude-workflow "Review the current diff." -- --output-format json

# Native Claude options
claude-workflow -- --add-dir ../shared --permission-mode plan

# Native Claude commands
claude-workflow -- doctor
claude-workflow -- --version
```

Unknown wrapper flags fail instead of silently becoming prompt text. Configure the main model with `ULTRATHINK_GATEWAY_MAIN_MODEL_ID`; native `--model` is deliberately rejected because it would bypass the gateway route contract.

## Permission behavior

The permission bypass is intentional and can be made explicit:

```bash
claude-workflow --yolo
claude-workflow --dangerously-skip-permissions
```

Restore Claude Code's normal permission flow for one invocation or by environment:

```bash
claude-workflow --no-yolo
CLAUDE_WORKFLOW_SKIP_PERMISSIONS=false claude-workflow
claude-workflow -- --permission-mode plan
```

An explicit native `--permission-mode` suppresses the injected bypass flag for that invocation.

## Shared gateway daemon

Plain `claude`, resumed/background sessions, and sessions started outside the wrapper do not inherit a per-launch gateway. Install the shell hook when those sessions should use the same workflow routing:

```bash
claude-workflow-gateway start
claude-workflow-gateway status
claude-workflow-gateway restart
claude-workflow-gateway log

claude-workflow-gateway install-shell
# Later, to remove the managed block:
claude-workflow-gateway uninstall-shell
```

The manager:

- binds only to `127.0.0.1` on port 4318 by default;
- publishes shell-safe exports in a private state directory;
- verifies service identity, PID, and a source/config revision on every health check;
- restarts stale code or changed trusted home configuration;
- serializes concurrent startup and terminates the exact recorded process on stop;
- keeps private, bounded, rotating JSONL traces by default.

New installs use `${XDG_STATE_HOME:-$HOME/.cache}/claude-workflow`. Existing `~/.cache/ultrathink` daemon state is detected so upgrades do not strand an already-running gateway. Override the location with `CLAUDE_WORKFLOW_GATEWAY_STATE_DIR`.

The shell installer updates `~/.zshrc` or `~/.bashrc`, follows an rc-file symlink, preserves file mode, writes a backup, and refuses malformed/nested marker blocks.

## Repository isolation

Per-session launchers start Codex in the caller's repository and retain the configured Codex native environment.

The shared daemon cannot safely use one startup directory for every repository. Its Codex threads therefore send `environments: []`: Codex-native shell and patch execution are disabled, while Claude-provided dynamic tools remain available. This is why the shared daemon requires Codex 0.144.1 or newer.

Workflow entrypoints also ignore the current repository's `.env` by default. A repository cannot opt itself in. To trust it explicitly, export this in the parent shell before launching:

```bash
export CLAUDE_WORKFLOW_LOAD_PROJECT_ENV=true
```

## Large files and 12k-line diffs

The gateway now treats large output as a coverage problem, not merely a context-window problem:

- Claude `Read` offsets remain unchanged and are documented as 1-based source lines.
- A matching `tool_result` always continues its live pending Codex call, even when the result is hundreds of kilobytes.
- Current Codex owns token-aware dynamic-tool history truncation by default; optional gateway byte caps remain hard compatibility bounds.
- Truncation always identifies an unseen gap and never invents a continuation cursor.
- Bash/Grep tool descriptions require diff inventories, bounded per-hunk reads, and explicit accounting before claiming complete review.
- Fresh, rewound, branched, or compacted Claude transcripts seed a clean Codex thread from a bounded authoritative replay.
- Only a matching tool result in the latest user turn can resume a pending call.

The offline suite includes a 12,000-line / roughly 500 KiB pending-result regression. See [Large files and diffs](docs/LARGE_FILES_AND_DIFFS.md) for the upstream Codex audit, failure analysis, operating protocol, and validation oracle.

## Context and session strategy

The workflow profile uses these defaults:

- 180,000-token configured input ceiling, further bounded to 80% of the context window reported by Codex.
- proactive thread recycling at 75% of the effective input budget;
- bounded transcript replay first, latest-only input only as a last overflow recovery step;
- Codex auto-compaction at 70% of the configured workflow ceiling with `body_after_prefix` scope;
- upstream Codex token-aware tool-output truncation (gateway per-result and aggregate byte caps default to disabled);
- 16 hard session slots, 30-second fork idle timeout, and an independent 10-minute pending-tool timeout.

When every session slot is active, reserved, or waiting for a tool result, new unrelated work receives a retryable 503 instead of growing the process pool without bound.

## Configuration

Precedence for workflow entrypoints is:

1. Parent process environment.
2. Project `.env` only after parent-set `CLAUDE_WORKFLOW_LOAD_PROJECT_ENV=true`.
3. `~/.claude-workflow.env`.
4. Legacy `~/.ultrathink.env`.

Common settings:

| Variable | Workflow default | Purpose |
| --- | --- | --- |
| `ULTRATHINK_GATEWAY_MAIN_MODEL_ID` | `claude-fable-5[1m]` | Claude Code-facing main model alias |
| `ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL` | qualifier-stripped main ID | Actual Anthropic model ID |
| `ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID` | `claude-sonnet-5` | Claude-facing workflow agent slot |
| `ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL` | `gpt-5.6-terra` | Balanced Codex model tier |
| `ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT` | `max` | Maximum single-agent reasoning |
| `CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID` | `codex-terra` | Short Claude UI-facing routed label |
| `ULTRATHINK_GATEWAY_SUBAGENT_VERBOSITY` | `high` | Codex response verbosity |
| `ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS` | `16` | Hard app-server process/session cap |
| `ULTRATHINK_GATEWAY_CODEX_PENDING_TOOL_TIMEOUT_MS` | `600000` | Independent pending-tool lifetime; `0` disables expiry |
| `ULTRATHINK_GATEWAY_DAEMON_PORT` | `4318` | Managed shared daemon |
| `ULTRATHINK_GATEWAY_PORT` | `0` launcher / `4319` raw gateway | Per-launch or standalone bind |

See the packaged [.env.example](.env.example) for every supported route, budget, trace, proxy, and authentication setting.

## Security model

- The default gateway is loopback-only. A non-loopback bind is rejected unless `ULTRATHINK_GATEWAY_SHARED_SECRET` is set.
- A loopback daemon is not an authorization boundary against other processes running as the same OS user.
- With a shared secret, Anthropic passthrough requires a gateway-side `ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY`; the gateway never forwards its own shared secret upstream.
- Published env, PID/revision state, logs, and traces are private. Symlinked state/trace targets and broadly accessible custom directories are rejected.
- Unauthenticated non-loopback `/healthz` responses expose only service readiness, not PIDs, paths, revisions, or budgets.
- Trace files rotate at 8 MiB with three files retained, and oversized events become bounded metadata records.

See [SECURITY.md](SECURITY.md) for reporting and deployment guidance.

## Standalone raw gateway

For protocol debugging without the workflow profile:

```bash
npm run start:gateway
```

It defaults to `127.0.0.1:4319` and exposes:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`

## Troubleshooting

Check the daemon and exact loaded revision:

```bash
claude-workflow-gateway status
claude-workflow-gateway log 100
curl -s http://127.0.0.1:4318/healthz
```

Common failures:

- `codex is not logged in` — run `codex login` and `codex login status`.
- `requires Codex CLI 0.144.1 or newer` — update Codex, then run `claude-workflow-gateway restart`.
- fixed-port collision — unset `ULTRATHINK_GATEWAY_PORT` or set it to `0` for per-launch use.
- shared secret breaks Claude OAuth passthrough — configure `ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY`, or keep a local loopback gateway without a shared secret.
- custom trace directory rejected — create it with mode 0700, or use the managed default.
- routed model ID reaches Anthropic and 404s — launch through `claude-workflow` or install/restart the shared gateway shell hook.

## Development and release checks

```bash
npm ci
npm run check
npm test
npm run test:package
```

The offline suite covers routing, streaming, persistent/forked sessions, transcript rewinds, tool loops, 12k-line results, child-process failures, daemon lifecycle/revision checks, shell injection, trace rotation/concurrency, permission behavior, and packed npm-bin execution. Live GLM validation is opt-in with `npm run test:live:glm` and a configured API key.

Additional references:

- [CHANGELOG.md](CHANGELOG.md)
- [SUPPORT.md](SUPPORT.md)
- [Large files and diffs](docs/LARGE_FILES_AND_DIFFS.md)
- [Anthropic Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [OpenAI Codex source](https://github.com/openai/codex)
