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

## Getting started

Claude Workflow supports macOS, Linux, and WSL. Native Windows is not supported. You need Node.js 20 or newer, [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started), and [Codex CLI](https://github.com/openai/codex) 0.144.1 or newer.

Install Claude Code and Codex first if they are not already available:

```bash
npm install --global @anthropic-ai/claude-code
npm install --global @openai/codex
```

Install the package, check the local tools, then start it inside a trusted repository:

```bash
npm install --global @onetool/claude-workflow
claude-workflow setup

cd /path/to/project
claude-workflow
```

`setup` verifies the supported platform, installed CLI versions, authentication, Linux-native WSL paths, and the effective routing configuration. It does not make a model request or verify live model availability. Without `--shared`, it creates no files and changes no shell settings.

If a login check fails:

```bash
claude auth login
codex login
claude-workflow setup
```

Use a user-owned Node.js installation or npm prefix. Do not work around global-install permission errors with `sudo`; correct the Node.js installation or npm prefix instead.

On WSL, install Node.js, Claude Code, Codex, and Claude Workflow inside the same Linux distribution. `command -v node claude codex claude-workflow` should return Linux paths, not `/mnt/...` paths or Windows executables. Keep configuration and shared-gateway state under `/home/<user>`.

Most users only need the `claude-workflow` command. Enable [shared mode](#shared) only when ordinary `claude` commands should also use the gateway.

## Usage

```bash
# Start an interactive session
claude-workflow

# Run one prompt and exit
claude-workflow "Review the current diff and delegate focused checks."

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

`setup`, `doctor`, `config`, and `run` are command names. Use `run` when prompt text starts with one of them:

```bash
claude-workflow run "setup the repository and verify the result"
```

Run `claude-workflow --help` for the complete command reference.

## Model routing

The default routes are:

| Traffic | Claude-facing model | Runs on |
| --- | --- | --- |
| Main session | `claude-fable-5[1m]` | Anthropic `claude-fable-5` |
| Workflow agents | `codex-terra` | Codex `gpt-5.6-terra` with `max` reasoning |

`[1m]` is a Claude Code model qualifier. The gateway sends the plain `claude-fable-5` model ID to Anthropic.

In the workflow profile, Fable requests go to Anthropic by default. Every other model request goes to Codex. Use a custom route map or Anthropic passthrough list to add exceptions.

`codex-terra` is the short Claude-facing alias for the configured Codex model. Use the configuration command to change the agent tier or reasoning effort:

```bash
claude-workflow config --agents sol --effort max
```

The aliases `sol`, `terra`, and `luna` keep the configured tiered GPT family when possible; otherwise they use the package default family. A full model ID is also accepted. The model must be available to the authenticated Codex account or workspace.

## Permissions

Restore Claude Code's permission flow for one command or set a persistent default:

```bash
claude-workflow --no-yolo
claude-workflow -- --permission-mode plan

# Make permission prompts the persistent default
claude-workflow config --permissions prompt
```

`--yolo` and `--dangerously-skip-permissions` explicitly enable the bypass. A native `--permission-mode` prevents the wrapper from adding the bypass flag.

## Gateway modes

### Per-session

`claude-workflow` starts a gateway on an available loopback port and closes it when Claude exits. By default, Codex can use its native shell and patch tools in the caller's repository.

### Shared

Plain `claude` commands do not use the per-session gateway. Start the shared gateway and install its shell hook when direct Claude invocations should use the workflow routes:

Shared mode requires Bash. Its managed shell hook supports Bash and zsh.

```bash
claude-workflow setup --shared
```

Open a new shell after setup. Manage the gateway directly when needed:

```bash
claude-workflow-gateway start
claude-workflow-gateway status
claude-workflow-gateway restart
claude-workflow-gateway log 100
```

Install or refresh the hook manually with:

```bash
claude-workflow-gateway install-shell
```

Remove it with:

```bash
claude-workflow-gateway uninstall-shell
```

After removal, close affected terminals and start a clean shell. Sourcing the rc file cannot unset gateway variables that are already present in the current process.

The daemon binds to `127.0.0.1:4318`. Its state directory is owner-only (`0700`), and its state files, logs, and traces are owner-readable and writable (`0600`). The default location is `${XDG_STATE_HOME:-$HOME/.cache}/claude-workflow`.

Shared Codex threads disable native shell and patch execution. They use only the tools supplied by Claude Code, so the daemon's startup directory cannot become the working directory for unrelated repositories.

Before uninstalling the package, remove the hook and stop the daemon:

```bash
claude-workflow-gateway uninstall-shell
claude-workflow-gateway stop
npm uninstall --global @onetool/claude-workflow
```

## Large repositories

Large results stay with the agent request that produced them. If output is shortened, the gateway marks the omitted region as an unreviewed gap. Agents are instructed to list changed files and diff hunks, then inspect bounded ranges before claiming complete coverage.

See [Large files and diffs](docs/LARGE_FILES_AND_DIFFS.md) for practical limits and the recommended review procedure.

## Configuration

Inspect or change the common settings without editing environment variables:

```bash
claude-workflow config
claude-workflow config --main fable --agents terra --effort max
claude-workflow config --permissions prompt
claude-workflow config --reset
```

The command writes only requested settings to `~/.claude-workflow.env`, preserves unrelated entries, and keeps the file owner-only. `--reset` removes the settings managed by the command so package defaults apply again.

Exported environment variables override the saved file. Custom route-map entries can override the common agent settings. `--reset` removes every key managed by the command, including matching keys added manually, while preserving comments and unrelated entries. Legacy `~/.ultrathink.env` values can still override package defaults after a reset.

For advanced routes, put trusted user-wide values in `~/.claude-workflow.env`. Values exported by the parent process take precedence. Project `.env` files are ignored unless the parent process sets `CLAUDE_WORKFLOW_LOAD_PROJECT_ENV=true`; a repository cannot enable itself.

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
claude-workflow doctor
claude-workflow-gateway status
claude-workflow-gateway log 100
curl -s http://127.0.0.1:4318/healthz
```

| Problem | Resolution |
| --- | --- |
| Codex is not logged in | Run `codex login`, then `codex login status`. |
| The configured Codex model is unavailable | Choose a model offered by the interactive Codex `/model` picker. |
| The shared daemon requires a newer Codex version | Update Codex and run `claude-workflow-gateway restart`. |
| A routed model reaches Anthropic and returns 404 | Launch through `claude-workflow`, or install the shared-gateway hook and open a new shell or source the updated shell rc file. |
| A per-session gateway port is already in use | Unset `ULTRATHINK_GATEWAY_PORT` or set it to `0`. |
| The shared gateway port is already in use | Export a different `ULTRATHINK_GATEWAY_DAEMON_PORT` before starting the daemon. |
| A custom trace directory is rejected | Create it with mode `0700`, or use the managed default. |

See [SUPPORT.md](SUPPORT.md) for issue-reporting guidance and known boundaries.

## Development

```bash
git clone https://github.com/yshaaban/claude-workflow.git
cd claude-workflow
npm ci
npm run check
npm test
npm run test:package
```

For a self-contained global install from a checkout, run `npm install --global --install-links .`. For active development, use `npm link`. The default test suite does not call model APIs.

Run `npm run start:gateway` to start the raw protocol-testing gateway on `127.0.0.1:4319`.

## License

Claude Workflow is licensed under the [MIT License](LICENSE).
