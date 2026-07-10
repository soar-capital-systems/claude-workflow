# Large files and diffs through the Claude-to-Codex gateway

This note records the July 10, 2026 investigation and the operating contract
for repository work where a file or diff can exceed 12,000 lines.

## Upstream baseline inspected

- Repository: [`openai/codex`](https://github.com/openai/codex)
- Exact `main` snapshot used for the code-path audit:
  [`6ad0e943cc727dc836d7c671f3377db30107f4d9`](https://github.com/openai/codex/commit/6ad0e943cc727dc836d7c671f3377db30107f4d9)
- `main` re-fetched before final validation:
  [`54c44b9ed4c7d6d1ec9bf7897bb76f6411d8e033`](https://github.com/openai/codex/commit/54c44b9ed4c7d6d1ec9bf7897bb76f6411d8e033).
  Changes after the audited snapshot affect bounded exec-server response and
  tracing paths; they do not change the app-server dynamic-tool/history paths
  cited below.
- Latest stable release at investigation time:
  [`rust-v0.144.1`](https://github.com/openai/codex/releases/tag/rust-v0.144.1)
- Locally installed CLI at final validation: `codex-cli 0.144.1`

The public workflow default was subsequently moved from the audited GPT-5.5
route to `gpt-5.6-terra` with `max` reasoning. The gateway learns the selected
model's real context window at runtime, so the large-output protocol below is
not tied to the older model's window size.

Relevant upstream behavior:

- Dynamic tool results are accepted in full and then token-truncated when
  copied into model history. At the audited snapshot, the GPT-5.5 policy was
  10,000 tokens;
  history uses additional serialization headroom. This protects context, not
  app-server ingress memory or the completeness of a review.
- Native unified-exec output also defaults to 10,000 model-visible tokens and
  a bounded process buffer. Its pressure fallback retains head and tail, so a
  middle diff hunk can still disappear.
- Turn-diff tracking caches by file/revision, gives exact diffing a per-file
  time budget, and falls back to a coarse content-exact diff. Upstream has a
  48,000-line near-total-rewrite regression. The aggregate diff is nevertheless
  fully materialized; it is not a paged review API.
- Syntax highlighting is skipped above 512 KiB or 10,000 lines. That improves
  rendering cost but does not reduce the underlying diff payload.
- Newer exec-server file reads use open/read-block/close with explicit offsets
  and blocks up to 1 MiB. There is no generic durable, content-addressed result
  store or general diff cursor exposed by app-server.

Primary source pointers:

- [Dynamic result history truncation](https://github.com/openai/codex/blob/6ad0e943cc727dc836d7c671f3377db30107f4d9/codex-rs/core/src/context_manager/history.rs#L370-L395)
- [Turn diff tracker](https://github.com/openai/codex/blob/6ad0e943cc727dc836d7c671f3377db30107f4d9/codex-rs/core/src/turn_diff_tracker.rs#L123-L182)
- [48,000-line diff regression](https://github.com/openai/codex/blob/6ad0e943cc727dc836d7c671f3377db30107f4d9/codex-rs/core/src/turn_diff_tracker_tests.rs#L431-L495)
- [Paged file-read server](https://github.com/openai/codex/blob/6ad0e943cc727dc836d7c671f3377db30107f4d9/codex-rs/exec-server/src/file_read.rs#L46-L70)

## What actually failed here

Three independent problems had been conflated as “large context”:

1. The shared gateway process predated all of the attempted fixes. Its health
   check proved only that a process answered HTTP; it never proved which source
   revision was loaded.
2. A matching Claude `tool_result` was evaluated for context pressure in its
   raw, potentially hundreds-of-kilobytes form before the gateway prepared it.
   The gateway then destroyed the paused dynamic-tool call and replayed the raw
   result as lossy transcript text on a new thread. The nominal byte cap ran
   only on the path that had just been bypassed.
3. The Read workaround invented the wrong contract. Claude Code 2.1.206 uses
   1-based source-line offsets, but the gateway documented a zero-based cursor,
   silently removed large offsets, and derived a next cursor from output whose
   middle it had omitted.

Claude Read can also reject a result before the gateway receives it. Production
records included a 12,299-line, 414,673-byte JSON file: a whole read exceeded
256 KiB, 2,000 lines exceeded 25,000 tokens, and even tiny line ranges failed
when a selected line was extremely dense. Post-result truncation cannot prevent
that class of error.

## Current contract

The gateway now follows these rules:

1. A matching tool result always continues the live pending app-server call.
   It is never recycled based on the raw Claude replay payload.
2. Workflow sessions let current Codex own token-aware model-history
   truncation. Optional gateway byte caps remain available for compatibility,
   are hard bounds including metadata, and explicitly mark an unseen gap.
3. Read arguments pass through unchanged. Its schema and failure feedback use
   1-based source lines, warn about Claude's pre-result limits, and prescribe
   structured/byte-range queries for dense single-line data.
4. Bash and Grep descriptions tell the routed model to inventory large diffs,
   snapshot/index hunks, retrieve bounded ranges, and treat truncation as
   incomplete evidence.
5. The shared daemon records a source digest, restarts when stale, enables a
   default trace, and exposes its loaded revision and budgets on `/healthz`.
6. Per-session launchers retain Codex's native environment because their cwd
   is the caller's repository. Shared-daemon threads send `environments: []`,
   disabling Codex-native shell/patch access and relying on Claude-provided
   dynamic tools instead. This prevents a daemon started from one folder from
   reading or editing another session through the wrong native cwd.

## Review protocol

For a large diff:

1. Record `git diff --stat`, `git diff --numstat`, and changed path names.
2. Snapshot a large per-file diff outside the prompt when needed. Index its
   `diff --git` and `@@` lines with `rg -n`; do not print it wholesale.
3. Inspect bounded ranges around every relevant hunk and track coverage in a
   small manifest. A head/tail preview is discovery evidence, not review
   completion.
4. Make localized changes with `apply_patch`. For a mechanical near-total
   rewrite, use an idempotent scripted transform or formatter, then validate
   scoped diffs and tests.

For a large file:

1. Locate symbols/facts with `rg -n` or Grep before reading.
2. Use explicit 1-based Read ranges and verify returned source-line numbers.
3. If a line itself is too large, query JSON with `jq`, columns with a parser,
   or exact byte/character intervals with Bash tools. Line pagination cannot
   split a minified one-line artifact.
4. Never advance a cursor across a truncation marker or claim full coverage of
   an omitted range.

## Validation oracle

The regression suite must continue to prove:

- a 12,000-line / roughly 500 KiB raw matching result stays on the same
  app-server process and reaches the pending call within its configured cap;
- byte caps include warning and omission text, for both per-result and
  aggregate limits;
- Read offsets are not silently rewritten and truncation never fabricates a
  gap-skipping continuation cursor;
- a healthy daemon with a stale recorded revision is replaced by `start` and
  by non-blocking `ensure`;
- `/healthz` identifies the loaded runtime and whether tracing is active.
- shared-daemon threads disable native environments while per-session threads
  retain them;
- a full pool rejects new work with 503 instead of exceeding the process cap,
  and a pending tool call survives ordinary idle cleanup until its separate
  pending-result deadline;
- app-server stdin closure becomes a request failure and cannot crash the
  gateway process.

The next architectural step, if multi-megabyte MCP/tool results become common,
is a content-addressed artifact spool: store the complete raw result outside
model context, return a digest/size/bounded preview, and expose deterministic
range/search/hunk retrieval with version checks. Upstream history truncation
alone does not bound ingress allocation, and arbitrary head/tail truncation
cannot prove complete review.
