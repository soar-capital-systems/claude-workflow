# Changelog

## Unreleased

### Added

- Direct Codex main routing through `claude-workflow config --main codex`, using
  the configured Codex model and reasoning effort without an Anthropic parent
  or login. Clean-home setup supplies private local gateway authentication and
  disables Claude Code's extra terminal-title request.
- First-class Kimi K3 main routing through Kimi Code's Anthropic-compatible
  API. `claude-workflow config --main kimi` selects the `k3[1m]` client alias,
  sends `k3` upstream with thinking enabled and `max` reasoning, and configures
  both Claude context variables for 1,048,576 tokens. `config --main k3`
  provides the Moderato-compatible 262,144-token profile.
- Kimi-specific setup, entitlement, session-restart, credential, and
  large-message guidance.
- An explicit `setup --prepare-claude` step for clean Claude Code homes. It
  preserves existing state, writes atomically, and creates a private backup
  before enabling third-party main routes such as direct Codex and Kimi.

### Changed

- Codex final-answer selection is local and phase-aware. Commentary and
  superseded assistant messages are excluded, and dynamic-tool boundaries
  settle on the next event-loop turn without another inference or fixed delay.
- Large-file guidance now distinguishes a model's context window from Kimi
  Code's 2,097,152-byte total message-content ceiling.
- Provider credentials remain inside the gateway process, managed
  non-Anthropic main routes receive automatic local gateway authentication,
  and provider-specific Claude settings are cleared when the main route
  changes.
- Daemon revision checks distinguish configuration inputs from generated client
  environment values, including managed auth, provider aliases, executable
  selection, and normalized proxy exclusions.
- Gateway bearer secrets and dedicated upstream credentials are removed from
  Codex app-server children and prerequisite probes.
- Per-session Claude routing now uses an owner-only temporary CLI settings
  layer, so user and repository settings remain unchanged while main model,
  context, max thinking, beta, and backend-selection values stay consistent.
- Shared setup fails closed on current Claude routing conflicts and rejects
  project `.env` loading; deterministic routing remains available through the
  per-session launcher.

### Fixed

- Schema agents retain the exact `StructuredOutput` tool name, avoiding a
  redundant enforcement inference, while rejected schema results can still be
  retried on their live Codex turn.
- Coalesced Codex app-server responses can no longer race turn listener
  registration in JSON or streaming requests, including large tool results.
- Launcher-managed Claude options precede native subcommands, temporary
  settings are removed on signals, and generic provider credentials do not
  leak into Claude or Codex child processes.
- Shared shell routing restores its complete owned environment before a
  profile refresh, preserves later user edits and export attributes, and cannot
  leave a stale gateway route when the manager or environment file fails. Bash
  and zsh option state is preserved, credential-bearing updates are hidden from
  shell xtrace, and hooks remain non-fatal under `set -e`.
- Current Codex app-server versions are detected from the source-defined
  `<originator>/<codex-version>` initialize user agent, while the older
  `codex_cli_rs` form remains supported.

## 0.1.0 - 2026-07-10

### Added

- Zero-config `setup` and read-only `doctor` checks for native tools,
  authentication, routing, and WSL path safety.
- A friendly `config` command for Fable/Codex models, reasoning effort, and
  permission behavior, backed by atomic owner-only user configuration.
- Shared `claude-workflow-gateway` daemon manager with revision-aware health,
  safe shell-hook install/uninstall, exact PID ownership, and upgrade-compatible
  state discovery.
- Large-file and diff review protocol, including a 12,000-line pending-result
  regression and explicit 1-based Claude Read guidance.
- Hard session admission limits, independent pending-tool expiry, context-window
  learning, proactive recycling, and transcript-first overflow recovery.
- Transcript continuity detection for Claude rewinds, branches, and compaction.
- Release checks for packed npm-bin execution, hostile shell values, trace
  concurrency, daemon lifecycle, Codex pipe failures, and native Claude argv.
- Linux checks for a self-contained global install, sourced Bash hooks, and
  shell-rc mode preservation.

### Changed

- Workflow subagents now default to `gpt-5.6-terra` with `max` reasoning and
  the short Claude-facing label `codex-terra`; Fable 5 remains the main route.
- Shared-daemon Codex threads are dynamic-tools-only (`environments: []`) so a
  daemon started in one directory cannot expose that native cwd to every repo.
- Current Codex owns token-aware tool-output truncation for workflow sessions;
  gateway byte caps remain explicit compatibility options.
- Workflow entrypoints ignore repository `.env` files unless the parent shell
  explicitly opts in with `CLAUDE_WORKFLOW_LOAD_PROJECT_ENV=true`.
- Standalone raw gateway moved to port 4319; the managed daemon remains 4318.
- Native Claude options and commands use an explicit `--` boundary.

### Fixed

- Large matching tool results no longer destroy the pending app-server call or
  get replayed as lossy transcript text.
- Read offsets are no longer rewritten or documented as zero-based, and a
  truncated middle never produces a fabricated continuation cursor.
- Historical/colliding tool-result IDs cannot hijack a pending call.
- Changed system instructions cannot silently reuse a thread pinned to stale
  developer instructions.
- Fresh fork sessions retain their bounded authoritative transcript.
- Child stdin `EPIPE`, duplicate replay cancellation, hard pool pressure, and
  blank/false-like configuration values are handled without daemon crashes or
  unbounded growth.
- Session expiry and forced shutdown await bounded app-server cleanup, avoiding
  orphaned Codex processes during timeouts and test interruption.
- Daemon env publication is shell-injection-safe, atomic, and private; health
  checks verify service/PID/revision rather than accepting an arbitrary 2xx.
- Trace files are private, bounded, rotated under a cross-process lock, recover
  abandoned locks, and reject unsafe existing directories without chmod side
  effects.
- GNU/Linux shell-rc mode detection no longer depends on BSD `stat` behavior.
  WSL state and trace paths fail closed when their filesystem cannot enforce
  Unix permissions, and manager-owned paths must be absolute.
- Executable scripts retain LF line endings in Windows/WSL checkouts, and test
  subprocess paths handle spaces and non-ASCII characters correctly.
