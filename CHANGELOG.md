# Changelog

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
