# Support

## Supported environment

- Node.js 20 or newer.
- Current Claude Code CLI.
- Codex CLI 0.144.1 or newer.
- macOS, Linux, or WSL. Shared mode requires Bash; its managed hook supports
  Bash and zsh.
- A Codex workspace whose live model catalog includes the configured model.
- For the built-in Kimi 1M preset, a Kimi Code API key and an Allegretto plan or
  higher. Moderato can select the 256K profile with `config --main k3`.
- For Qwen, an Alibaba Token Plan with access to `qwen3.8-max` and a matching
  `sk-sp-` key for the configured region and endpoint.

On WSL, install Node.js, Claude Code, Codex, and Claude Workflow in the same
distribution. Their commands, user configuration, and gateway state must use
the Linux filesystem rather than `/mnt/...` paths or Windows executables.

The configured Codex model must appear in your workspace model catalog. This
profile is shared by workflow agents and the direct Codex main route. If the
default `gpt-5.6-terra` route is absent, run
`claude-workflow config --agents <model-id>` with a full model ID available to
your Codex workspace. The interactive Codex `/model` picker shows available
choices.

Direct Codex, Kimi, and Qwen require Claude Code's third-party-model mode. On a
clean Claude Code installation, run `claude-workflow setup --prepare-claude`; it
preserves the existing Claude state and makes a private backup. Kimi uses its
own provider route and does not need to appear in the Codex or
Claude Code `/model` picker. Select the 1M profile with `claude-workflow config
--main kimi` or the Moderato 256K profile with `claude-workflow config --main
k3`, then add `ULTRATHINK_GATEWAY_KIMI_API_KEY` to the owner-only
`~/.claude-workflow.env` file, and verify a new session with Claude Code's
`/status` command. Kimi Code keys and Kimi Open Platform keys are not
interchangeable. For shared mode, restart the gateway and open a new shell
after changing the route.

For Qwen, select `claude-workflow config --main qwen`, add
`ULTRATHINK_GATEWAY_QWEN_API_KEY` to the owner-only configuration, and start a
new session. The built-in profile uses the Singapore Token Plan
OpenAI-compatible endpoint. Standard DashScope keys require an explicit
matching base URL and are not interchangeable with Token Plan keys.

The per-session `claude-workflow` launcher overrides user, project, and local
routing settings without modifying them. Organization-managed Claude settings
remain authoritative. Shared mode relies on environment exports, so use the
launcher in repositories whose settings conflict with those exports.

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
- Kimi's 1M context window does not raise its 2,097,152-byte total
  message-content ceiling. Large files and diffs still require bounded reads
  and explicit coverage tracking.
- Kimi Code does not document an Anthropic-compatible token-count endpoint.
  The gateway uses a conservative UTF-8 byte estimate for Claude Code's local
  compaction signal; it is not an exact provider token count.
- Qwen's OpenAI-compatible Token Plan route also uses a conservative local
  UTF-8 estimate for Claude's compaction signal. It is not an exact tokenizer
  or billing count and makes no provider request.
- Qwen deep-thinking mode accepts automatic or disabled tool selection. Named
  and required choices are rejected locally because coercion would change the
  request contract.
- Shared mode is user-wide. It rejects project `.env` loading and cannot
  override organization policy or conflicting Claude settings introduced by a
  repository entered after setup. Use the per-session launcher for those cases.
