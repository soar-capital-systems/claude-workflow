# Claude Workflow

Claude Workflow lets Claude Code use Anthropic for the main session and Codex for delegated agents. It runs a local Anthropic-compatible gateway between Claude Code and both backends.

The gateway uses your existing Claude Code and Codex CLI authentication, so no separate model API keys are required.

Default routing:

```text
Claude Code -> local gateway -> Anthropic        (main session)
                              -> Codex app-server (workflow agents)
```

> [!WARNING]
> `claude-workflow` starts Claude Code with `--dangerously-skip-permissions` by default. Run it only in repositories and machine environments you trust. Use `--no-yolo` to restore normal permission prompts.

## Requirements

- Node.js 20 or newer.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started), installed and authenticated.
- [Codex CLI](https://github.com/openai/codex) 0.144.1 or newer, installed and authenticated.
- macOS, Linux, or WSL with Bash. The managed shell hook supports zsh and Bash.

On WSL, install Node.js, Claude Code, and Codex inside the same Linux distribution. Keep the project and gateway state under its Linux filesystem, such as `/home/<user>`, unless the mounted Windows filesystem is configured to preserve Unix permissions and symlinks.

```bash
node --version
claude --version
codex --version
codex login status
```

## Installation

```bash
git clone https://github.com/yshaaban/claude-workflow.git
cd claude-workflow
npm install --global --install-links .
```

`--install-links` copies the package into npm's global prefix instead of linking it to the checkout. The installation provides two commands:

- `claude-workflow` starts Claude Code with a gateway dedicated to that session.
- `claude-workflow-gateway` manages an optional shared gateway for shells and sessions started outside the wrapper.

Use a user-owned Node.js installation or npm prefix. The commands do not require a root-owned global installation.

## Quick start

```bash
cd /path/to/project

# Start an interactive session
claude-workflow

# Run one prompt and exit
claude-workflow "Review the current diff and delegate focused checks to workflow agents."

# Resume an existing session
claude-workflow --resume <session-id>
claude-workflow --continue
```

Use `--` before native Claude options or commands:

```bash
claude-workflow -- --add-dir ../shared --permission-mode plan
claude-workflow "Review the current diff." -- --output-format json
```

Wrapper options must appear before `--`. Unknown wrapper options are rejected. Set `ULTRATHINK_GATEWAY_MAIN_MODEL_ID` instead of passing Claude's native `--model` option.

Run `claude-workflow --help` for the complete command reference.

## Model routing

The default routes are:

| Traffic | Claude-facing model | Runs on |
| --- | --- | --- |
| Main session | `claude-fable-5[1m]` | Anthropic `claude-fable-5` |
| Workflow agents | `codex-terra` | Codex `gpt-5.6-terra` with `max` reasoning |

`[1m]` is a Claude Code model qualifier. The gateway sends the plain `claude-fable-5` model ID to Anthropic.

In the workflow profile, Fable requests go to Anthropic by default. Every other model request goes to Codex. Use a custom route map or Anthropic passthrough list to add exceptions.

`codex-terra` is the Claude-facing alias for the configured Codex model. To select a different model, add trusted user-wide overrides to `~/.claude-workflow.env`:

```bash
ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5.6-sol
ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=max
CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID=codex-sol
```

The selected model must be available to the authenticated Codex account or workspace.

## Permissions

Restore Claude Code's permission flow for one command or set a persistent default:

```bash
claude-workflow --no-yolo
claude-workflow -- --permission-mode plan

# Add to ~/.claude-workflow.env for a persistent default
CLAUDE_WORKFLOW_SKIP_PERMISSIONS=false
```

`--yolo` and `--dangerously-skip-permissions` explicitly enable the bypass. A native `--permission-mode` prevents the wrapper from adding the bypass flag.

## Gateway modes

### Per-session

`claude-workflow` starts a gateway on an available loopback port and closes it when Claude exits. By default, Codex can use its native shell and patch tools in the caller's repository.

### Shared

Plain `claude` commands do not use the per-session gateway. Start the shared gateway and install its shell hook when direct Claude invocations should use the workflow routes:

```bash
claude-workflow-gateway start
claude-workflow-gateway status
claude-workflow-gateway restart
claude-workflow-gateway log 100
```

Install the hook once to configure future shells:

```bash
claude-workflow-gateway install-shell
```

Remove it with:

```bash
claude-workflow-gateway uninstall-shell
```

After installation, open a new shell or source the updated shell rc file. After removal, close affected terminals and start a clean terminal session. Sourcing the rc file cannot unset gateway variables that are already present in the current shell.

The daemon binds to `127.0.0.1:4318`. Its state directory is owner-only (`0700`), and its state files, logs, and traces are owner-readable and writable (`0600`). The default location is `${XDG_STATE_HOME:-$HOME/.cache}/claude-workflow`.

Shared Codex threads disable native shell and patch execution. They use only the tools supplied by Claude Code, so the daemon's startup directory cannot become the working directory for unrelated repositories.

## Large repositories

Large results stay with the agent request that produced them. If output is shortened, the gateway marks the omitted region as an unreviewed gap. Agents are instructed to list changed files and diff hunks, then inspect bounded ranges before claiming complete coverage.

See [Large files and diffs](docs/LARGE_FILES_AND_DIFFS.md) for practical limits and the recommended review procedure.

## Configuration

Put trusted user-wide routing defaults in `~/.claude-workflow.env`. Values exported by the parent process take precedence. Project `.env` files are ignored unless the parent process sets `CLAUDE_WORKFLOW_LOAD_PROJECT_ENV=true`. A repository cannot enable itself.

Shell-manager settings such as `CLAUDE_WORKFLOW_GATEWAY_STATE_DIR`, `CLAUDE_WORKFLOW_SHELL_RC`, `ULTRATHINK_GATEWAY_DAEMON_PORT`, and `ULTRATHINK_GATEWAY_TRACE_DIR` must be exported by the parent shell. Manager-owned path values must be absolute. Gateway settings use the `ULTRATHINK_GATEWAY_` namespace.

Common settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ULTRATHINK_GATEWAY_MAIN_MODEL_ID` | `claude-fable-5[1m]` | Claude-facing main model |
| `ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL` | `claude-fable-5` | Anthropic model used for the main route |
| `ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL` | `gpt-5.6-terra` | Codex model used for workflow agents |
| `ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT` | `max` | Codex reasoning effort |
| `CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID` | `codex-terra` | Model label shown to Claude Code |

See [.env.example](.env.example) for route maps, context limits, traces, proxies, authentication, and additional provider routes.

## Security

- The gateway binds to loopback by default. Other processes running as the same OS user can still reach it.
- Non-loopback binds require `ULTRATHINK_GATEWAY_SHARED_SECRET`. Anthropic passthrough in this mode also requires a gateway-side Anthropic API key.
- Gateway state, logs, and traces use owner-only permissions.

See [SECURITY.md](SECURITY.md) for the full security model and vulnerability-reporting process.

## Troubleshooting

For shared-gateway problems, start with its status, recent logs, and health response:

```bash
claude-workflow-gateway status
claude-workflow-gateway log 100
curl -s http://127.0.0.1:4318/healthz
```

| Problem | Resolution |
| --- | --- |
| Codex is not logged in | Run `codex login`, then `codex login status`. |
| The configured Codex model is unavailable | Choose a model listed by your Codex installation. |
| The shared daemon requires a newer Codex version | Update Codex and run `claude-workflow-gateway restart`. |
| A routed model reaches Anthropic and returns 404 | Launch through `claude-workflow`, or install the shared-gateway hook and open a new shell or source the updated shell rc file. |
| A per-session gateway port is already in use | Unset `ULTRATHINK_GATEWAY_PORT` or set it to `0`. |
| The shared gateway port is already in use | Export a different `ULTRATHINK_GATEWAY_DAEMON_PORT` before starting the daemon. |
| A custom trace directory is rejected | Create it with mode `0700`, or use the managed default. |

See [SUPPORT.md](SUPPORT.md) for issue-reporting guidance and known boundaries.

## Development

```bash
npm ci
npm run check
npm test
npm run test:package
```

For local development, use `npm link` after installing dependencies. The default test suite does not call model APIs.

Run `npm run start:gateway` to start the raw protocol-testing gateway on `127.0.0.1:4319`.

## License

Claude Workflow is licensed under the [MIT License](LICENSE).
