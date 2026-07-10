# Security policy

## Reporting a vulnerability

Please use the repository's private GitHub security-advisory flow rather than a
public issue. Include the affected revision, reproduction steps, impact, and a
minimal redacted trace when useful. Do not include API keys, OAuth tokens,
published gateway env files, or complete private prompts/transcripts.

## Security model

- `claude-workflow` intentionally launches Claude Code with
  `--dangerously-skip-permissions` by default. This is a trusted-repository
  automation mode, not a sandbox boundary. Use `--no-yolo` for normal prompts.
- The gateway binds to loopback by default. Other processes running as the same
  OS user can reach a loopback daemon; use OS-user isolation for stronger
  separation.
- Non-loopback binds require `ULTRATHINK_GATEWAY_SHARED_SECRET`. When that is
  set, Anthropic passthrough also needs a gateway-side Anthropic API key.
- Shared-daemon Codex threads disable native execution environments and use
  Claude-provided dynamic tools. Per-launch sessions retain the caller cwd.
- Workflow entrypoints ignore project `.env` by default. Only a parent process
  can opt a trusted project in.
- State, env exports, logs, and traces are private. Symlinks and broadly
  accessible custom state/trace locations are rejected.
- Unauthenticated non-loopback health responses omit paths, PIDs, revisions,
  and budgets.

Only the current default branch receives security fixes during the initial
public release period.
