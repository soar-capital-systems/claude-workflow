#!/usr/bin/env bash
# Manage the shared claude-workflow gateway daemon.
#
# Usage: claude-workflow-daemon.sh {ensure|start|stop|restart|status|log|install-shell}
#
# `ensure` never blocks the caller: one fast health probe, and if the daemon
# is down it spawns the (flock-guarded) start in the background — safe to call
# from ~/.bashrc so every shell revives the daemon after a WSL/machine
# restart. State lives in ~/.cache/ultrathink/.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DAEMON_JS="$REPO_ROOT/js/cli/claude-workflow-daemon.js"
STATE_DIR="${CLAUDE_WORKFLOW_GATEWAY_STATE_DIR:-$HOME/.cache/ultrathink}"
PID_FILE="$STATE_DIR/claude-workflow-gateway.pid"
LOCK_FILE="$STATE_DIR/claude-workflow-gateway.start.lock"
LOCK_DIR="$STATE_DIR/claude-workflow-gateway.start.lock.d"
LOG_FILE="$STATE_DIR/claude-workflow-gateway.log"
# Deliberately NOT ULTRATHINK_GATEWAY_PORT (the per-session launcher's knob).
# Keep the default in sync with DEFAULT_DAEMON_PORT in claude-workflow-daemon.js.
PORT="${ULTRATHINK_GATEWAY_DAEMON_PORT:-4318}"
HEALTH_URL="http://127.0.0.1:$PORT/healthz"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # Non-interactive shells may not have nvm loaded; prefer the newest install.
  local candidate
  candidate="$(ls -1v "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  return 1
}

healthy() {
  curl -sf --max-time 1 "$HEALTH_URL" >/dev/null 2>&1
}

daemon_pid() {
  cat "$PID_FILE" 2>/dev/null
}

# Only treat the recorded pid as ours when its command line is actually the
# daemon — after a reboot the OS can hand a stale pid to an unrelated process,
# which stop/restart must never kill.
pid_is_daemon() {
  local pid="$1"
  case "$pid" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac

  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q "claude-workflow-daemon"
    return $?
  fi

  ps -p "$pid" -o command= 2>/dev/null | grep -q "claude-workflow-daemon"
}

pid_running() {
  pid_is_daemon "$(daemon_pid)"
}

acquire_start_lock() {
  # Single-starter mutex: concurrent shells (tmux session restore) must not
  # each spawn a gateway that loses the port race. Linux/WSL normally have
  # flock; macOS does not, so fall back to atomic mkdir with a stale-pid check.
  if command -v flock >/dev/null 2>&1; then
    START_LOCK_MODE="flock"
    exec 9>"$LOCK_FILE"
    if flock -n 9; then
      return 0
    fi
    echo "claude-workflow-gateway: another start is already in progress"
    return 1
  fi

  START_LOCK_MODE="directory"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" >"$LOCK_DIR/pid"
    return 0
  fi

  local lock_pid
  lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -rf "$LOCK_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" >"$LOCK_DIR/pid"
      return 0
    fi
  fi

  echo "claude-workflow-gateway: another start is already in progress"
  return 1
}

release_start_lock() {
  case "${START_LOCK_MODE:-}" in
    flock)
      flock -u 9 2>/dev/null || true
      ;;
    directory)
      rm -rf "$LOCK_DIR"
      ;;
  esac
  START_LOCK_MODE=""
}

start_daemon() {
  mkdir -p "$STATE_DIR"

  if ! acquire_start_lock; then
    return 0
  fi

  start_daemon_locked
  local result=$?
  release_start_lock
  return "$result"
}

start_daemon_locked() {
  if healthy; then
    echo "claude-workflow-gateway: already running on port $PORT"
    return 0
  fi

  NODE_BIN="$(find_node)" || {
    echo "claude-workflow-gateway: node not found" >&2
    return 1
  }

  ULTRATHINK_GATEWAY_DAEMON_PORT="$PORT" nohup "$NODE_BIN" "$DAEMON_JS" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"

  for _ in $(seq 1 20); do
    if healthy; then
      echo "claude-workflow-gateway: started on port $PORT (pid $(daemon_pid))"
      return 0
    fi
    if ! pid_running; then
      echo "claude-workflow-gateway: failed to start; see $LOG_FILE" >&2
      return 1
    fi
    sleep 0.25
  done

  echo "claude-workflow-gateway: did not become healthy; see $LOG_FILE" >&2
  return 1
}

stop_daemon() {
  local pid
  pid="$(daemon_pid)"
  if pid_is_daemon "$pid"; then
    kill "$pid" 2>/dev/null
    rm -f "$PID_FILE"
    echo "claude-workflow-gateway: stopped"
  else
    rm -f "$PID_FILE"
    echo "claude-workflow-gateway: not running"
  fi
}

install_shell() {
  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  local shell_rc="$HOME/.bashrc"
  if [ "$shell_name" = "zsh" ]; then
    shell_rc="$HOME/.zshrc"
  fi

  local marker=">>> ultrathink claude-workflow gateway >>>"
  if grep -qF "$marker" "$shell_rc" 2>/dev/null; then
    echo "claude-workflow-gateway: $shell_rc block already installed"
    return 0
  fi
  {
    echo ''
    echo "# $marker"
    echo "[ -f \"$SCRIPT_DIR/claude-workflow-gateway.bashrc\" ] && . \"$SCRIPT_DIR/claude-workflow-gateway.bashrc\""
    echo '# <<< ultrathink claude-workflow gateway <<<'
  } >>"$shell_rc"
  echo "claude-workflow-gateway: installed shell hook in $shell_rc"
}

case "${1:-status}" in
  ensure)
    if ! healthy; then
      # Never block an interactive shell: hand off to a background start.
      (start_daemon >/dev/null 2>&1 &)
    fi
    ;;
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    stop_daemon
    sleep 0.5
    start_daemon
    ;;
  status)
    if healthy; then
      echo "claude-workflow-gateway: healthy on port $PORT"
    elif pid_running; then
      echo "claude-workflow-gateway: process alive (pid $(daemon_pid)) but not healthy"
      exit 1
    else
      echo "claude-workflow-gateway: not running"
      exit 1
    fi
    ;;
  log)
    tail -n "${2:-50}" "$LOG_FILE"
    ;;
  install-shell)
    install_shell
    ;;
  *)
    echo "Usage: $0 {ensure|start|stop|restart|status|log|install-shell}" >&2
    exit 2
    ;;
esac
