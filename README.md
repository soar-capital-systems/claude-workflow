# Claude Workflow

Claude Workflow routes Claude Code through a local Anthropic-compatible
gateway. The main session uses Anthropic Fable by default. You can also run the
main session directly on Codex or Kimi K3. Delegated agents use the configured
Codex model.

The default Fable/Terra route uses your existing Claude Code and Codex CLI
authentication, so it needs no additional provider API key.

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

Install Claude Workflow from its repository:

```bash
git clone https://github.com/yshaaban/claude-workflow.git
cd claude-workflow
npm install --global --install-links .
```

Choose a main route, then run setup. The default uses Fable as the coordinator:

```bash
claude auth login
codex login
claude-workflow setup
```

For direct Codex with no Anthropic login:

```bash
codex login
claude-workflow config --main codex
claude-workflow setup --prepare-claude
```

Start Claude Workflow inside a trusted repository:

```bash
cd /path/to/project
claude-workflow
```

`--install-links` copies the package into npm's global prefix, so the command does not depend on the source checkout after installation.

`setup` verifies the supported platform, installed CLI versions, required authentication, Linux-native WSL paths, and the effective routing configuration. It does not make a model request or verify live model availability. Without `--shared` or `--prepare-claude`, it creates no files and changes no shell settings. Fable requires Claude authentication. Direct Codex uses `codex login` and does not require an Anthropic login. Kimi uses its Kimi Code credential.

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

Wrapper options must appear before `--`. Unknown wrapper options are rejected.
Use `claude-workflow config --main <preset>` to change a supported main route.
Advanced custom routes must configure the model id and provider or route map
together; Claude's native `--model` option cannot override workflow routing.

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

Terra is the balanced default. Sol is the frontier tier when maximum capability
matters more than latency or cost.

### Coordinated and direct execution

The default Fable/Terra profile is a coordinator workflow. When Fable starts an
Agent or Workflow, Claude Code returns the Codex result to Fable as a tool
result. Claude Code then resumes Fable so it can combine results, handle
failures, or continue the task. Each resume is another parent model call. A
background Workflow can resume once for launch and again for completion; the
exact sequence depends on the Claude Code version and orchestration path.

The gateway converts the Codex app-server response to Anthropic Messages JSON
locally and deterministically. That conversion performs no model inference.
For schema-based agents, the gateway preserves Claude Code's `StructuredOutput`
tool name so Codex can return the requested object without an enforcement
retry.

Use Codex as the main model when you want a plain Codex answer without a Fable
parent turn:

```bash
claude-workflow config --main codex --agents terra --effort max
claude-workflow setup --prepare-claude
claude-workflow
```

The direct profile uses the configured Codex model and reasoning effort. With
the defaults, that is Terra at `max`. It also disables Claude Code's automatic
terminal-title request. A plain prompt that needs no tool continuation therefore
makes one provider request and returns the Codex response directly. If Codex
calls a Claude Code tool, Codex must resume after the tool result to finish the
task.

Direct mode does not use the Fable coordinator. Return to the default profile
with the command below. If direct Codex starts an Agent or Workflow, Claude Code
still resumes that Codex parent; direct mode removes Fable from the path, not
Claude Code's delegation lifecycle.

```bash
claude-workflow config --main fable
```

An explicit Anthropic passthrough or route remains active when you select
Codex. Mixed Codex/Anthropic routing requires
`ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY`. For a Codex-only profile, remove that
Anthropic route-map entry and set any explicit passthrough list to
`ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS=none`.

### Kimi K3 as the main model

The built-in Kimi preset uses K3 with max reasoning and the full 1M context
profile. It requires a Kimi Code Allegretto plan or higher. Workflow agents
remain on the configured Codex route, which is Terra by default.

Create an API key in the [Kimi Code Console](https://www.kimi.com/code/console),
select Kimi, then store the key in the owner-only user configuration:

```bash
# Allegretto or higher: K3 with 1M context
claude-workflow config --main kimi

# Moderato: use this 256K profile instead
# claude-workflow config --main k3

${EDITOR:-vi} ~/.claude-workflow.env
chmod 600 ~/.claude-workflow.env
```

Add this line in the editor:

```dotenv
ULTRATHINK_GATEWAY_KIMI_API_KEY=replace_with_your_kimi_code_key
```

Do not export the key from a shell startup file, put it in a repository `.env`,
or pass it on a command line that may be saved in shell history.
`claude-workflow config` preserves the key when other managed settings change.

Check the configuration, then start a new session:

```bash
claude-workflow setup --prepare-claude
cd /path/to/project
claude-workflow
```

`--prepare-claude` enables Claude Code's third-party-model mode without starting
its Anthropic login flow. It preserves the existing `.claude.json` object,
writes atomically with owner-only permissions, and creates
`~/.claude.json.claude-workflow.bak` before changing an existing file. When
`CLAUDE_CONFIG_DIR` is set, it uses that directory instead. It does not edit
Claude user, project, or local settings.

Each `claude-workflow` launch supplies a private, temporary `--settings` file
that overrides routing, context, thinking, and provider-selection keys for that
session. The file contains only client-side gateway values, never an upstream
Kimi key, and is removed when the launcher exits or handles SIGINT/SIGTERM.
Organization-managed Claude settings have higher precedence and can still
prevent third-party routing.

Run `/status` inside Claude Code to verify the active main model. The Kimi route
is selected by `claude-workflow config`, not by Claude Code's `/model` picker.

The client-facing `k3[1m]` alias maps to the upstream `k3` model. The gateway
keeps thinking enabled and sends `max` reasoning effort. The launcher sets both
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to
the configured Kimi context, which defaults to `1048576`.

Moderato supports K3 only at 256K, so `config --main k3` uses the plain `k3`
client model and sets both context values to `262144`.

After changing models, start a new Claude session so the route and prompt cache
are not reused. In shared mode, also run `claude-workflow-gateway restart` and
open a new shell. The gateway defaults to `https://api.kimi.com/coding/` and
sends messages to `https://api.kimi.com/coding/v1/messages`. See Kimi's
[model reference](https://www.kimi.com/code/docs/en/kimi-code/models.html) and
[Claude Code setup](https://www.kimi.com/code/docs/en/third-party-tools/other-coding-agents)
for provider-side requirements.

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

Plain `claude` commands do not use the per-session gateway. Shared mode exports
the gateway environment for direct Claude invocations:

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

Uninstalling the hook cannot mutate the shell process that ran the command.
Close affected parent terminals and start a clean shell after removal.

The daemon binds to `127.0.0.1:4318`. Its state directory is owner-only (`0700`), and its state files, logs, and traces are owner-readable and writable (`0600`). The default location is `${XDG_STATE_HOME:-$HOME/.cache}/claude-workflow`.

Claude user, project, local, and organization-managed settings can outrank
environment exports. Setup refuses known routing conflicts in the current user
and repository settings, but a different repository can introduce its own
conflict later. Use `claude-workflow` when routing must be deterministic. Shared
mode also rejects `CLAUDE_WORKFLOW_LOAD_PROJECT_ENV`; repository-specific
environment loading belongs to the per-session launcher.

Shared Codex threads disable native shell and patch execution. They use only the tools supplied by Claude Code, so the daemon's startup directory cannot become the working directory for unrelated repositories.

The hook applies Claude routing as an owned environment overlay. Before a
refresh it restores the values that were present when the overlay was applied,
while preserving values and export attributes changed later by the user. If the
manager or generated environment is unavailable, the shell keeps the restored
environment instead of retaining a dead gateway URL. The hook preserves Bash
and zsh option state, suppresses credential-bearing commands while xtrace is
enabled, and remains non-fatal under `set -e`.

Before uninstalling the package, remove the hook and stop the daemon:

```bash
claude-workflow-gateway uninstall-shell
claude-workflow-gateway stop
npm uninstall --global @onetool/claude-workflow
```

## Large repositories

Large results stay with the agent request that produced them. If output is shortened, the gateway marks the omitted region as an unreviewed gap. Agents are instructed to list changed files and diff hunks, then inspect bounded ranges before claiming complete coverage.

A 1M context window is not a license to send an entire large repository or diff
in one request. Kimi Code also limits
[total message content to 2,097,152 bytes](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html),
which can become the binding limit well before the token window. Inventory
changed files, index diff hunks, and inspect bounded ranges while recording
coverage.

See [Large files and diffs](docs/LARGE_FILES_AND_DIFFS.md) for practical limits and the recommended review procedure.

## Configuration

Inspect or change the common settings without editing environment variables:

```bash
claude-workflow config
claude-workflow config --main fable --agents terra --effort max
claude-workflow config --main codex
claude-workflow config --main kimi
claude-workflow config --permissions prompt
claude-workflow config --reset
```

The command writes only requested settings to `~/.claude-workflow.env`, preserves unrelated entries, and keeps the file owner-only. `--reset` removes the settings managed by the command so package defaults apply again.

Exported environment variables override the saved file. `--agents` and
`--effort` update the shared Codex profile used by workflow agents and by the
direct Codex main route. Custom route-map entries can override that profile.
`--reset` removes every key managed by the command, including matching keys
added manually, while preserving comments and unrelated entries. Legacy
`~/.ultrathink.env` values can still override package defaults after a reset.

The launcher owns the main model, model aliases, context, effort, thinking and
beta controls, provider-selection flags, and gateway discovery setting. It
derives or clears them when the route changes. Shared mode tracks effective
workflow, provider, executable, proxy, and credential inputs and restarts a
stale daemon when its shell hook runs.

For advanced routes, put trusted user-wide values in `~/.claude-workflow.env`.
Values exported by the parent process take precedence. Per-session launchers
ignore project `.env` files unless the parent process sets
`CLAUDE_WORKFLOW_LOAD_PROJECT_ENV=true`; a repository cannot enable itself.
Shared mode rejects that opt-in because one global daemon cannot safely follow
multiple repository configurations.

Shell-manager settings such as `CLAUDE_WORKFLOW_GATEWAY_STATE_DIR`, `CLAUDE_WORKFLOW_SHELL_RC`, `ULTRATHINK_GATEWAY_DAEMON_PORT`, and `ULTRATHINK_GATEWAY_TRACE_DIR` must be exported by the parent shell. Manager-owned path values must be absolute. Gateway settings use the `ULTRATHINK_GATEWAY_` namespace.

Common settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ULTRATHINK_GATEWAY_MAIN_MODEL_ID` | `claude-fable-5[1m]` | Claude-facing main model |
| `ULTRATHINK_GATEWAY_MAIN_PROVIDER` | `anthropic` | Main-route provider; `codex` selects direct Codex and `kimi` selects Kimi Code |
| `ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL` | Provider default | Upstream model used for the main route |
| `ULTRATHINK_GATEWAY_CODEX_MODEL` | `gpt-5.6-terra` | Shared Codex model for agents and the direct main route |
| `ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT` | `max` | Shared Codex reasoning effort |
| `ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL` | `gpt-5.6-terra` | Codex model used for workflow agents |
| `ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT` | `max` | Codex reasoning effort |
| `CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID` | `codex-terra` | Model label shown to Claude Code |

See [.env.example](.env.example) for route maps, context limits, traces, proxies, authentication, and additional provider routes.

## Security

- The gateway binds to loopback by default. Managed workflow configuration gives a non-Anthropic main route an automatic per-process gateway secret, so `/v1` rejects local callers that do not have it. Equivalent raw gateway routes must set one explicitly.
- Non-loopback binds require `ULTRATHINK_GATEWAY_SHARED_SECRET`. Any shared-secret configuration with an Anthropic route also requires the dedicated `ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY`; a generic `ANTHROPIC_API_KEY` is not accepted for that role.
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
| Kimi reports a missing key | Add `ULTRATHINK_GATEWAY_KIMI_API_KEY` to `~/.claude-workflow.env`, keep the file mode `0600`, and start a new session. |
| Direct Codex or Kimi opens Claude onboarding or reports third-party support is disabled | Run `claude-workflow setup --prepare-claude`, then start a new session. |
| Kimi returns 401 or full 1M context is unavailable | Confirm that the key is from Kimi Code, the account can use K3, and the plan is Allegretto or higher for 1M context. Then start a new session; restart shared mode first. |
| The shared daemon requires a newer Codex version | Update Codex and run `claude-workflow-gateway restart`. |
| The Codex TUI shows “Dismiss and keep waiting” during a security review | Claude Workflow uses `codex app-server` and does not render that TUI notice. No supported setting disables the provider-side safety buffer. |
| Shared setup reports conflicting Claude settings | Use `claude-workflow` for deterministic routing, or explicitly update the named user/project/local settings before enabling plain `claude` routing. Organization-managed settings cannot be overridden. |
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

For a self-contained global install from a checkout, run `npm install --global --install-links .`. For active development, use `npm link`. The default test suite does not call model APIs.

Run `npm run start:gateway` to start the raw protocol-testing gateway on `127.0.0.1:4319`.

## License

Claude Workflow is licensed under the [MIT License](LICENSE).
