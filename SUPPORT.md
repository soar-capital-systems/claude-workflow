# Support

## Supported environment

- Node.js 20 or newer.
- Current native Claude Code CLI.
- Codex CLI 0.144.1 or newer for the shared daemon.
- macOS, Linux, or WSL with Bash; managed shell hooks support zsh and Bash.
- A Codex workspace whose live model catalog includes the configured model.

On WSL, install Node.js, Claude Code, and Codex in the same distribution. Keep
the project and gateway state on the Linux filesystem unless the Windows mount
is configured to preserve Unix permissions and symlinks.

The configured Codex model must appear in your workspace model catalog. If the
default `gpt-5.6-terra` route is absent, set
`ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL` and
`ULTRATHINK_GATEWAY_CODEX_MODEL` to a model returned by your Codex installation.

## Before opening an issue

Run:

```bash
claude --version
codex --version
codex login status
claude-workflow-gateway status
claude-workflow-gateway log 100
npm test
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
