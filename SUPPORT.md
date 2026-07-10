# Support

## Supported environment

- Node.js 20 or newer.
- Current Claude Code CLI.
- Codex CLI 0.144.1 or newer.
- macOS, Linux, or WSL. Shared mode requires Bash; its managed hook supports
  Bash and zsh.
- A Codex workspace whose live model catalog includes the configured model.

On WSL, install Node.js, Claude Code, Codex, and Claude Workflow in the same
distribution. Their commands, user configuration, and gateway state must use
the Linux filesystem rather than `/mnt/...` paths or Windows executables.

The configured Codex model must appear in your workspace model catalog. If the
default `gpt-5.6-terra` route is absent, run
`claude-workflow config --agents <model-id>` with a full model ID available to
your Codex workspace. The interactive Codex `/model` picker shows available
choices.

## Before opening an issue

Run:

```bash
claude-workflow --version
claude-workflow doctor
claude-workflow config
```

For shared-mode problems, also run:

```bash
claude-workflow-gateway status
claude-workflow-gateway log 100
curl -s http://127.0.0.1:4318/healthz
```

Include the failing command, OS/shell, sanitized health response, and the first
relevant error. Never attach credentials or an unredacted gateway env file.

## Known boundaries

- Codex-routed image blocks are rejected rather than silently discarded.
- A pending dynamic tool call occupies one bounded pool slot until its result,
  its independent timeout, or daemon restart.
- `pendingToolTimeoutMs=0` deliberately disables expiry and can hold that slot
  indefinitely; the hard session cap still prevents unbounded process growth.
- `ultra` reasoning can create nested Codex delegation. The workflow defaults
  to `max` because Claude already owns subagent orchestration.
- Large-output truncation is never proof of complete review. Follow
  `docs/LARGE_FILES_AND_DIFFS.md` for coverage accounting.
