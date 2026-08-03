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
- The gateway binds to loopback by default, but loopback is not an OS-user
  boundary. Other local users or processes in the same network namespace may
  be able to connect. A managed non-Anthropic main route therefore creates a
  random gateway secret and requires it on `/v1`; the shared daemon publishes
  that secret only through its owner-only environment file.
- Non-loopback binds require `ULTRATHINK_GATEWAY_SHARED_SECRET`. When that is
  set, every Anthropic route also needs the dedicated gateway-side
  `ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY`. A generic `ANTHROPIC_API_KEY` is not
  accepted as the shared-secret upstream credential.
- Provider API keys, including `ULTRATHINK_GATEWAY_KIMI_API_KEY` and
  `ULTRATHINK_GATEWAY_QWEN_API_KEY`, belong in the
  owner-only `~/.claude-workflow.env` file. Do not export them from a shell
  startup file or store them in a repository `.env`, command-line argument,
  issue, trace, or diagnostic attachment. Kimi requests use the gateway-side
  key rather than Claude Code's inbound credential. Qwen Token Plan keys must
  match their plan endpoint, and custom remote Qwen endpoints must use HTTPS.
  Dedicated gateway keys are removed from child processes; Kimi, Qwen, and
  unrelated Anthropic credentials are also removed from Codex probes and
  app-server processes.
- Per-session launches pass Claude a private owner-only `--settings` file that
  clears conflicting routing, beta, thinking, and provider-selection values.
  It contains only local gateway credentials, never upstream provider keys,
  and is removed on normal exit, SIGINT, and SIGTERM. Claude organization
  policy has higher precedence and is not bypassed.
- `setup --prepare-claude` is the only setup action that changes Claude Code's
  `.claude.json`. It preserves existing fields, refuses symlinks and foreign
  ownership, writes with owner-only permissions, and creates a private backup
  before changing an existing file.
- Shared-daemon Codex threads disable native execution environments and use
  Claude-provided dynamic tools. Per-launch sessions retain the caller cwd.
- Workflow entrypoints ignore project `.env` by default. Only a parent process
  can opt a trusted project into per-session loading. Shared mode rejects that
  opt-in because its daemon is global rather than repository-scoped.
- User configuration, state, env exports, logs, and traces are private. User
  configuration must be a current-user-owned, non-symlink regular file with no
  group or other access. Symlinks and broadly
  accessible custom state/trace locations are rejected.
- Unauthenticated non-loopback health responses omit paths, PIDs, revisions,
  and budgets.

Only the current default branch receives security fixes during the initial
public release period.
