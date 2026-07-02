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
  _ULTRATHINK_GATEWAY_SOURCE="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  _ULTRATHINK_GATEWAY_SOURCE="$(eval 'printf "%s" "${(%):-%x}"')"
else
  _ULTRATHINK_GATEWAY_SOURCE=""
fi

_ULTRATHINK_GATEWAY_DIR="$(cd "$(dirname "$_ULTRATHINK_GATEWAY_SOURCE")" 2>/dev/null && pwd)"
if [ -n "$_ULTRATHINK_GATEWAY_DIR" ] && [ -x "$_ULTRATHINK_GATEWAY_DIR/claude-workflow-daemon.sh" ]; then
  "$_ULTRATHINK_GATEWAY_DIR/claude-workflow-daemon.sh" ensure >/dev/null 2>&1
  if [ -f "$HOME/.cache/ultrathink/claude-workflow-gateway.env" ]; then
    . "$HOME/.cache/ultrathink/claude-workflow-gateway.env"
  fi
fi
unset _ULTRATHINK_GATEWAY_SOURCE
unset _ULTRATHINK_GATEWAY_DIR
