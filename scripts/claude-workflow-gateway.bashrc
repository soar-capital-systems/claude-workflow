# Sourceable shell hook for the shared claude-workflow gateway daemon.
# Installed into the current shell's rc file by:
# scripts/claude-workflow-daemon.sh install-shell
#
# Ensures the daemon is running (non-blocking) and exports its published env
# so every Claude Code session started from this shell — plain, resumed, or
# background — routes through the gateway: the frontier main model stays on
# Anthropic passthrough while agents route to Codex. The claude-workflow
# launcher overrides these exports with its own per-session gateway.
if [ -n "${BASH_SOURCE:-}" ]; then
  _CLAUDE_WORKFLOW_GATEWAY_SOURCE="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  _CLAUDE_WORKFLOW_GATEWAY_SOURCE="$(eval 'printf "%s" "${(%):-%x}"')"
else
  _CLAUDE_WORKFLOW_GATEWAY_SOURCE=""
fi

_CLAUDE_WORKFLOW_GATEWAY_DIR="$(cd "$(dirname "$_CLAUDE_WORKFLOW_GATEWAY_SOURCE")" 2>/dev/null && pwd)"
if [ -n "$_CLAUDE_WORKFLOW_GATEWAY_DIR" ] && [ -x "$_CLAUDE_WORKFLOW_GATEWAY_DIR/claude-workflow-daemon.sh" ]; then
  _CLAUDE_WORKFLOW_GATEWAY_MANAGER="$_CLAUDE_WORKFLOW_GATEWAY_DIR/claude-workflow-daemon.sh"
  _CLAUDE_WORKFLOW_GATEWAY_CANONICAL_STATE_DIR="${XDG_STATE_HOME:-$HOME/.cache}/claude-workflow"
  _CLAUDE_WORKFLOW_GATEWAY_LEGACY_STATE_DIR="$HOME/.cache/ultrathink"
  if [ -n "${CLAUDE_WORKFLOW_GATEWAY_STATE_DIR:-}" ]; then
    _CLAUDE_WORKFLOW_GATEWAY_STATE_DIR="$CLAUDE_WORKFLOW_GATEWAY_STATE_DIR"
  elif [ ! -e "$_CLAUDE_WORKFLOW_GATEWAY_CANONICAL_STATE_DIR" ] && {
    [ -f "$_CLAUDE_WORKFLOW_GATEWAY_LEGACY_STATE_DIR/claude-workflow-gateway.pid" ] ||
      [ -f "$_CLAUDE_WORKFLOW_GATEWAY_LEGACY_STATE_DIR/claude-workflow-gateway.env" ]
  }; then
    _CLAUDE_WORKFLOW_GATEWAY_STATE_DIR="$_CLAUDE_WORKFLOW_GATEWAY_LEGACY_STATE_DIR"
  else
    _CLAUDE_WORKFLOW_GATEWAY_STATE_DIR="$_CLAUDE_WORKFLOW_GATEWAY_CANONICAL_STATE_DIR"
  fi
  _CLAUDE_WORKFLOW_GATEWAY_ENV_FILE="${CLAUDE_WORKFLOW_GATEWAY_ENV_FILE:-$_CLAUDE_WORKFLOW_GATEWAY_STATE_DIR/claude-workflow-gateway.env}"
  "$_CLAUDE_WORKFLOW_GATEWAY_MANAGER" ensure >/dev/null 2>&1
  _CLAUDE_WORKFLOW_GATEWAY_ATTEMPT=0
  while [ "$_CLAUDE_WORKFLOW_GATEWAY_ATTEMPT" -lt 20 ]; do
    if "$_CLAUDE_WORKFLOW_GATEWAY_MANAGER" status >/dev/null 2>&1 && [ -r "$_CLAUDE_WORKFLOW_GATEWAY_ENV_FILE" ]; then
      . "$_CLAUDE_WORKFLOW_GATEWAY_ENV_FILE"
      break
    fi
    _CLAUDE_WORKFLOW_GATEWAY_ATTEMPT=$((_CLAUDE_WORKFLOW_GATEWAY_ATTEMPT + 1))
    sleep 0.1
  done
fi
unset _CLAUDE_WORKFLOW_GATEWAY_SOURCE
unset _CLAUDE_WORKFLOW_GATEWAY_DIR
unset _CLAUDE_WORKFLOW_GATEWAY_MANAGER
unset _CLAUDE_WORKFLOW_GATEWAY_CANONICAL_STATE_DIR
unset _CLAUDE_WORKFLOW_GATEWAY_LEGACY_STATE_DIR
unset _CLAUDE_WORKFLOW_GATEWAY_STATE_DIR
unset _CLAUDE_WORKFLOW_GATEWAY_ENV_FILE
unset _CLAUDE_WORKFLOW_GATEWAY_ATTEMPT
