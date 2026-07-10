#!/usr/bin/env bash
# Manage the shared claude-workflow gateway daemon.
#
# Usage: claude-workflow-daemon.sh {ensure|start|stop|restart|status|log|install-shell|uninstall-shell}
#
# `ensure` performs a fast health/source-revision check, then hands stale or
# missing daemon startup to the background behind a single-starter lock. It is
# safe to call from ~/.bashrc so every shell revives or refreshes the daemon.
# New installs keep state in ${XDG_STATE_HOME:-~/.cache}/claude-workflow/.
# Existing ~/.cache/ultrathink daemon state is detected for upgrade compatibility.
set -u
umask 077

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SOURCE" ]; do
  SCRIPT_LINK_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  SCRIPT_LINK_TARGET="$(readlink "$SCRIPT_SOURCE")"
  case "$SCRIPT_LINK_TARGET" in
    /*) SCRIPT_SOURCE="$SCRIPT_LINK_TARGET" ;;
    *) SCRIPT_SOURCE="$SCRIPT_LINK_DIR/$SCRIPT_LINK_TARGET" ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DAEMON_JS="$REPO_ROOT/js/cli/claude-workflow-daemon.js"
CANONICAL_STATE_DIR="${XDG_STATE_HOME:-$HOME/.cache}/claude-workflow"
LEGACY_STATE_DIR="$HOME/.cache/ultrathink"
if [ -n "${CLAUDE_WORKFLOW_GATEWAY_STATE_DIR:-}" ]; then
  STATE_DIR="$CLAUDE_WORKFLOW_GATEWAY_STATE_DIR"
elif [ ! -e "$CANONICAL_STATE_DIR" ] && {
  [ -f "$LEGACY_STATE_DIR/claude-workflow-gateway.pid" ] ||
    [ -f "$LEGACY_STATE_DIR/claude-workflow-gateway.env" ]
}; then
  STATE_DIR="$LEGACY_STATE_DIR"
else
  STATE_DIR="$CANONICAL_STATE_DIR"
fi
ENV_FILE="${CLAUDE_WORKFLOW_GATEWAY_ENV_FILE:-$STATE_DIR/claude-workflow-gateway.env}"
PID_FILE="$STATE_DIR/claude-workflow-gateway.pid"
REVISION_FILE="$STATE_DIR/claude-workflow-gateway.revision"
LOCK_FILE="$STATE_DIR/claude-workflow-gateway.start.lock"
LOCK_DIR="$STATE_DIR/claude-workflow-gateway.start.lock.d"
LOG_FILE="$STATE_DIR/claude-workflow-gateway.log"
DEFAULT_TRACE_DIR="$STATE_DIR/gateway-trace"
# Deliberately NOT ULTRATHINK_GATEWAY_PORT (the per-session launcher's knob).
# Keep the default in sync with DEFAULT_DAEMON_PORT in claude-workflow-daemon.js.
PORT="${ULTRATHINK_GATEWAY_DAEMON_PORT:-4318}"
HEALTH_URL="http://127.0.0.1:$PORT/healthz"

validate_managed_port() {
  case "$PORT" in
    ''|*[!0-9]*)
      echo "claude-workflow-gateway: ULTRATHINK_GATEWAY_DAEMON_PORT must be an integer from 1 to 65535" >&2
      return 1
      ;;
  esac
  if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "claude-workflow-gateway: ULTRATHINK_GATEWAY_DAEMON_PORT must be between 1 and 65535, got $PORT" >&2
    return 1
  fi
}

ensure_private_state_dir() {
  local node_bin
  if [ -L "$STATE_DIR" ]; then
    echo "claude-workflow-gateway: state directory must not be a symlink: $STATE_DIR" >&2
    return 1
  fi
  mkdir -p "$STATE_DIR" || return 1
  if [ ! -d "$STATE_DIR" ]; then
    echo "claude-workflow-gateway: state path is not a directory: $STATE_DIR" >&2
    return 1
  fi
  if ! chmod 700 "$STATE_DIR" 2>/dev/null; then
    echo "claude-workflow-gateway: could not make state directory owner-only: $STATE_DIR" >&2
    return 1
  fi
  node_bin="$(find_node)" || {
    echo "claude-workflow-gateway: node not found" >&2
    return 1
  }
  if ! path_has_owner_only_mode "$node_bin" "$STATE_DIR"; then
    echo "claude-workflow-gateway: state directory does not enforce owner-only permissions: $STATE_DIR" >&2
    echo "claude-workflow-gateway: on WSL, use the Linux filesystem or enable DrvFS metadata" >&2
    return 1
  fi
}

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # Non-interactive shells may not have nvm loaded; prefer the newest install.
  local candidate
  candidate="$(
    ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null |
      awk -F/ '
        {
          version = $(NF - 2)
          sub(/^v/, "", version)
          split(version, parts, ".")
          printf "%09d%09d%09d\t%s\n", parts[1], parts[2], parts[3], $0
        }
      ' |
      sort |
      tail -1 |
      cut -f2-
  )"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  return 1
}

file_mode() {
  local node_bin="$1"
  local target="$2"
  "$node_bin" - "$target" <<'NODE'
const fs = require('node:fs');
const stats = fs.statSync(process.argv[2]);
process.stdout.write((stats.mode & 0o7777).toString(8));
NODE
}

path_has_owner_only_mode() {
  local node_bin="$1"
  local target="$2"
  "$node_bin" - "$target" <<'NODE'
const fs = require('node:fs');
const stats = fs.lstatSync(process.argv[2]);
process.exit((stats.mode & 0o077) === 0 ? 0 : 1);
NODE
}

validate_manager_paths() {
  local trace_dir_normalized
  case "$STATE_DIR" in
    /*) ;;
    *)
      echo "claude-workflow-gateway: CLAUDE_WORKFLOW_GATEWAY_STATE_DIR/XDG_STATE_HOME must resolve to an absolute path: $STATE_DIR" >&2
      return 1
      ;;
  esac
  case "$ENV_FILE" in
    /*) ;;
    *)
      echo "claude-workflow-gateway: CLAUDE_WORKFLOW_GATEWAY_ENV_FILE must be an absolute path: $ENV_FILE" >&2
      return 1
      ;;
  esac
  if [ "${ULTRATHINK_GATEWAY_TRACE_DIR+x}" = "x" ]; then
    case "${ULTRATHINK_GATEWAY_TRACE_DIR:-}" in
      ''|/*) ;;
      *)
        trace_dir_normalized="$(printf '%s' "$ULTRATHINK_GATEWAY_TRACE_DIR" | tr '[:upper:]' '[:lower:]')"
        case "$trace_dir_normalized" in
          0|false|no|off) ;;
          *)
            echo "claude-workflow-gateway: ULTRATHINK_GATEWAY_TRACE_DIR must be absolute or disabled with off/false/no/0" >&2
            return 1
            ;;
        esac
        ;;
    esac
  fi
}

# Hash the runtime source tree, including uncommitted edits, so a healthy
# daemon can still be recognized as stale after a pull or local code change.
# Node is already a hard runtime dependency and gives us one portable digest
# implementation across macOS, Linux, and WSL.
source_revision() {
  local node_bin
  node_bin="$(find_node)" || return 1
  "$node_bin" - "$REPO_ROOT" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2]);
const hash = crypto.createHash('sha256');

function visit(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  for (const entry of entries) {
    const childRelativePath = path.posix.join(relativePath, entry.name);
    const childAbsolutePath = path.join(root, childRelativePath);
    if (entry.isDirectory()) {
      visit(childRelativePath);
      continue;
    }

    hash.update(childRelativePath);
    hash.update('\0');
    if (entry.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(fs.readlinkSync(childAbsolutePath));
    } else if (entry.isFile()) {
      hash.update('file\0');
      hash.update(fs.readFileSync(childAbsolutePath));
    } else {
      hash.update('other\0');
    }
    hash.update('\0');
  }
}

visit('js');
visit('scripts');
for (const relativePath of ['package.json', 'package-lock.json']) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }
  hash.update(relativePath);
  hash.update('\0file\0');
  hash.update(fs.readFileSync(absolutePath));
  hash.update('\0');
}
for (const configName of ['.claude-workflow.env', '.ultrathink.env']) {
  const configPath = path.join(process.env.HOME || '', configName);
  if (!configPath || !fs.existsSync(configPath)) {
    continue;
  }
  const stats = fs.statSync(configPath, { bigint: true });
  hash.update(`user-config-stat:${configName}\0`);
  hash.update(String(stats.size));
  hash.update('\0');
  hash.update(String(stats.mtimeNs));
  hash.update('\0');
}
process.stdout.write(`${hash.digest('hex')}\n`);
NODE
}

recorded_revision() {
  [ -r "$REVISION_FILE" ] || return 0
  tr -d '\r\n' <"$REVISION_FILE" 2>/dev/null
}

revision_matches() {
  local expected_revision="$1"
  [ -n "$expected_revision" ] && [ "$(recorded_revision)" = "$expected_revision" ]
}

write_atomic_state_file() {
  local target="$1"
  local value="$2"
  local temp_file
  local node_bin

  temp_file="$(umask 077 && mktemp "$STATE_DIR/.claude-workflow-gateway.XXXXXX")" || return 1
  if ! (umask 077 && printf '%s\n' "$value" >"$temp_file"); then
    rm -f "$temp_file"
    return 1
  fi
  if ! mv -f "$temp_file" "$target"; then
    rm -f "$temp_file"
    return 1
  fi
  node_bin="$(find_node)" || {
    rm -f "$target"
    return 1
  }
  if ! path_has_owner_only_mode "$node_bin" "$target"; then
    rm -f "$target"
    echo "claude-workflow-gateway: state file does not enforce owner-only permissions: $target" >&2
    return 1
  fi
}

spawn_detached_daemon() {
  local node_bin="$1"
  "$node_bin" - "$DAEMON_JS" "$LOG_FILE" <<'NODE'
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const daemonPath = process.argv[2];
const logPath = process.argv[3];
if (fs.existsSync(logPath)) {
  const existingLogStats = fs.lstatSync(logPath);
  if (existingLogStats.isSymbolicLink() || !existingLogStats.isFile()) {
    throw new Error(`gateway log path must be a regular file: ${logPath}`);
  }
}
const logFd = fs.openSync(logPath, 'a', 0o600);
fs.chmodSync(logPath, 0o600);
const logStats = fs.lstatSync(logPath);
if (!logStats.isFile() || logStats.isSymbolicLink() || (logStats.mode & 0o077) !== 0) {
  fs.closeSync(logFd);
  throw new Error(
    `gateway log does not enforce owner-only permissions: ${logPath}. ` +
      'On WSL, use the Linux filesystem or enable DrvFS metadata.'
  );
}
const child = spawn(process.execPath, [daemonPath], {
  detached: true,
  env: process.env,
  stdio: ['ignore', logFd, logFd],
});
child.unref();
fs.closeSync(logFd);
process.stdout.write(`${child.pid}\n`);
NODE
}

health_payload() {
  local node_bin
  node_bin="$(find_node)" || return 1
  "$node_bin" - "$HEALTH_URL" <<'NODE'
const http = require('node:http');
const url = process.argv[2];
const request = http.get(url, { timeout: 1000 }, (response) => {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    process.exitCode = 1;
    return;
  }
  let body = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      request.destroy(new Error('health response exceeded 1 MiB'));
    }
  });
  response.on('end', () => process.stdout.write(body));
});
request.on('timeout', () => request.destroy(new Error('health request timed out')));
request.on('error', () => { process.exitCode = 1; });
NODE
}

healthy() {
  health_payload >/dev/null 2>&1
}

health_matches_runtime() {
  local expected_pid="$1"
  local expected_revision="${2:-}"
  local payload
  local node_bin
  payload="$(health_payload 2>/dev/null)" || return 1
  node_bin="$(find_node)" || return 1
  "$node_bin" -e '
const expectedPid = Number(process.argv[1]);
const expectedRevision = process.argv[2];
const body = JSON.parse(process.argv[3]);
const acceptedServices = new Set(["ultrathink-anthropic-gateway", "claude-workflow-gateway"]);
const matches = body?.ok === true &&
  acceptedServices.has(body?.service) &&
  Number(body?.runtime_pid) === expectedPid &&
  (!expectedRevision || body?.runtime_revision === expectedRevision);
process.exit(matches ? 0 : 1);
' "$expected_pid" "$expected_revision" "$payload" >/dev/null 2>&1
}

daemon_pid() {
  cat "$PID_FILE" 2>/dev/null
}

# Only treat the recorded pid as ours when its command line is actually the
# daemon — after a reboot the OS can hand a stale pid to an unrelated process,
# which stop/restart must never kill.
pid_is_daemon() {
  local pid="$1"
  local command_kind
  local command_line
  local node_bin
  case "$pid" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac

  if [ -r "/proc/$pid/cmdline" ]; then
    node_bin="$(find_node)" || return 1
    command_kind="$("$node_bin" - "$pid" "$DAEMON_JS" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const pid = process.argv[2];
const expectedDaemon = fs.realpathSync(process.argv[3]);
const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`);
const args = commandLine.toString('utf8').split('\0').filter(Boolean);
if (args.length < 2) {
  process.exit(1);
}

let executable;
try {
  executable = path.basename(fs.realpathSync(`/proc/${pid}/exe`));
} catch {
  process.exit(1);
}
if (executable !== 'node' && executable !== 'nodejs') {
  process.exit(1);
}

let daemonArgument;
try {
  daemonArgument = fs.realpathSync(args[1]);
} catch {
  process.exit(1);
}
if (daemonArgument === expectedDaemon) {
  process.stdout.write('current');
} else if (path.basename(daemonArgument) === 'claude-workflow-daemon.js') {
  process.stdout.write('legacy');
} else {
  process.exit(1);
}
NODE
)" || return 1
    case "$command_kind" in
      current) return 0 ;;
      legacy) health_matches_runtime "$pid" ;;
      *) return 1 ;;
    esac
  fi

  command_line="$(ps -p "$pid" -o command= 2>/dev/null)" || return 1
  if printf '%s\n' "$command_line" | grep -Fq -- "node $DAEMON_JS" ||
    printf '%s\n' "$command_line" | grep -Fq -- "nodejs $DAEMON_JS"; then
    return 0
  fi
  printf '%s\n' "$command_line" | grep -Fq 'claude-workflow-daemon.js' &&
    health_matches_runtime "$pid"
}

pid_running() {
  pid_is_daemon "$(daemon_pid)"
}

daemon_is_current() {
  local expected_revision
  local pid
  if ! healthy || ! pid_running; then
    return 1
  fi

  pid="$(daemon_pid)"
  expected_revision="$(source_revision)" || return 1
  revision_matches "$expected_revision" && health_matches_runtime "$pid" "$expected_revision"
}

wait_until_unhealthy() {
  local attempt
  for attempt in $(seq 1 30); do
    if ! healthy; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

wait_for_pid_exit() {
  local pid="$1"
  local attempt
  for attempt in $(seq 1 100); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

terminate_daemon_pid() {
  local pid="$1"
  if ! pid_is_daemon "$pid"; then
    return 1
  fi

  kill "$pid" 2>/dev/null || true
  if wait_for_pid_exit "$pid"; then
    return 0
  fi

  if pid_is_daemon "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait_for_pid_exit "$pid"
}

cleanup_failed_start() {
  local pid="$1"
  terminate_daemon_pid "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE" "$REVISION_FILE" "$ENV_FILE"
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
  validate_managed_port || return 1
  ensure_private_state_dir || return 1

  if ! acquire_start_lock; then
    return 1
  fi

  start_daemon_locked
  local result=$?
  release_start_lock
  return "$result"
}

start_daemon_locked() {
  local runtime_revision
  runtime_revision="$(source_revision)" || {
    echo "claude-workflow-gateway: could not compute runtime source revision" >&2
    return 1
  }

  if healthy; then
    if ! pid_running; then
      echo "claude-workflow-gateway: port $PORT is healthy but is not owned by the recorded daemon" >&2
      return 1
    fi

    if ! health_matches_runtime "$(daemon_pid)"; then
      echo "claude-workflow-gateway: port $PORT is healthy but belongs to another process" >&2
      return 1
    fi

    if revision_matches "$runtime_revision" && health_matches_runtime "$(daemon_pid)" "$runtime_revision"; then
      echo "claude-workflow-gateway: already running current revision on port $PORT"
      return 0
    fi

    echo "claude-workflow-gateway: healthy daemon is stale; restarting"
    stop_daemon || return 1
    if ! wait_until_unhealthy; then
      echo "claude-workflow-gateway: stale daemon did not release port $PORT" >&2
      return 1
    fi
  fi

  if pid_running; then
    echo "claude-workflow-gateway: recorded daemon is not healthy on requested port $PORT; restarting"
    stop_daemon || return 1
  fi

  NODE_BIN="$(find_node)" || {
    echo "claude-workflow-gateway: node not found" >&2
    return 1
  }

  local trace_dir
  if [ "${ULTRATHINK_GATEWAY_TRACE_DIR+x}" = "x" ]; then
    trace_dir="$ULTRATHINK_GATEWAY_TRACE_DIR"
  else
    trace_dir="$DEFAULT_TRACE_DIR"
  fi

  local runtime_started_at
  runtime_started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  local started_pid
  started_pid="$(ULTRATHINK_GATEWAY_DAEMON_PORT="$PORT" \
    CLAUDE_WORKFLOW_GATEWAY_ENV_FILE="$ENV_FILE" \
    ULTRATHINK_GATEWAY_CODEX_CWD="$STATE_DIR" \
    ULTRATHINK_GATEWAY_RUNTIME_REVISION="$runtime_revision" \
    ULTRATHINK_GATEWAY_RUNTIME_STARTED_AT="$runtime_started_at" \
    ULTRATHINK_GATEWAY_TRACE_DIR="$trace_dir" \
    spawn_detached_daemon "$NODE_BIN")" || {
      echo "claude-workflow-gateway: failed to spawn detached daemon" >&2
      return 1
    }
  if ! write_atomic_state_file "$PID_FILE" "$started_pid"; then
    cleanup_failed_start "$started_pid"
    echo "claude-workflow-gateway: could not record daemon pid" >&2
    return 1
  fi

  for _ in $(seq 1 20); do
    if healthy && pid_running && health_matches_runtime "$started_pid" "$runtime_revision"; then
      if ! write_atomic_state_file "$REVISION_FILE" "$runtime_revision"; then
        stop_daemon >/dev/null 2>&1
        echo "claude-workflow-gateway: could not record daemon revision" >&2
        return 1
      fi
      echo "claude-workflow-gateway: started on port $PORT (pid $(daemon_pid))"
      return 0
    fi
    if ! pid_running; then
      cleanup_failed_start "$started_pid"
      echo "claude-workflow-gateway: failed to start; see $LOG_FILE" >&2
      return 1
    fi
    sleep 0.25
  done

  echo "claude-workflow-gateway: did not become healthy; see $LOG_FILE" >&2
  cleanup_failed_start "$started_pid"
  return 1
}

stop_daemon() {
  local pid
  pid="$(daemon_pid)"
  if pid_is_daemon "$pid"; then
    if terminate_daemon_pid "$pid"; then
      rm -f "$PID_FILE" "$REVISION_FILE" "$ENV_FILE"
      echo "claude-workflow-gateway: stopped"
    else
      echo "claude-workflow-gateway: could not stop verified daemon pid $pid" >&2
      return 1
    fi
  else
    rm -f "$PID_FILE" "$REVISION_FILE" "$ENV_FILE"
    echo "claude-workflow-gateway: not running"
  fi
}

shell_rc_path() {
  if [ -n "${CLAUDE_WORKFLOW_SHELL_RC:-}" ]; then
    case "$CLAUDE_WORKFLOW_SHELL_RC" in
      /*)
        printf '%s\n' "$CLAUDE_WORKFLOW_SHELL_RC"
        return 0
        ;;
      *)
        echo "claude-workflow-gateway: CLAUDE_WORKFLOW_SHELL_RC must be an absolute path" >&2
        return 1
        ;;
    esac
  fi

  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)
      printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    bash)
      printf '%s\n' "$HOME/.bashrc"
      ;;
    *)
      echo "claude-workflow-gateway: unsupported shell ${shell_name:-unknown}; set CLAUDE_WORKFLOW_SHELL_RC to a POSIX-compatible bash or zsh rc file" >&2
      return 1
      ;;
  esac
}

resolve_shell_rc_target() {
  local target="$1"
  local link_dir
  local link_target
  while [ -h "$target" ]; do
    link_dir="$(cd "$(dirname "$target")" && pwd)"
    link_target="$(readlink "$target")"
    case "$link_target" in
      /*) target="$link_target" ;;
      *) target="$link_dir/$link_target" ;;
    esac
  done
  printf '%s\n' "$target"
}

rewrite_shell_blocks() {
  local shell_rc="$1"
  local operation="${2:-remove}"
  local temp_file
  local node_bin
  local shell_rc_mode
  [ -f "$shell_rc" ] || return 0
  temp_file="$(mktemp "${shell_rc}.claude-workflow.XXXXXX")" || return 1
  if ! awk '
    index($0, "# >>> ultrathink claude-workflow gateway >>>") == 1 ||
    index($0, "# >>> claude-workflow gateway >>>") == 1 {
      if (skipping) malformed = 1
      skipping = 1
      next
    }
    index($0, "# <<< ultrathink claude-workflow gateway <<<") == 1 ||
    index($0, "# <<< claude-workflow gateway <<<") == 1 {
      if (!skipping) malformed = 1
      skipping = 0
      next
    }
    !skipping { print }
    END { if (skipping || malformed) exit 2 }
  ' "$shell_rc" >"$temp_file"; then
    rm -f "$temp_file"
    echo "claude-workflow-gateway: refusing to edit malformed shell hook markers in $shell_rc" >&2
    return 1
  fi
  if [ "$operation" = "install" ]; then
    if ! {
      echo ''
      echo '# >>> claude-workflow gateway >>>'
      cat <<'EOF'
if command -v claude-workflow-gateway >/dev/null 2>&1; then
  _CLAUDE_WORKFLOW_GATEWAY_MANAGER="$(command -v claude-workflow-gateway)"
  "$_CLAUDE_WORKFLOW_GATEWAY_MANAGER" ensure >/dev/null 2>&1
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
  _CLAUDE_WORKFLOW_GATEWAY_ATTEMPT=0
  while [ "$_CLAUDE_WORKFLOW_GATEWAY_ATTEMPT" -lt 20 ]; do
    if "$_CLAUDE_WORKFLOW_GATEWAY_MANAGER" status >/dev/null 2>&1 && [ -r "$_CLAUDE_WORKFLOW_GATEWAY_ENV_FILE" ]; then
      . "$_CLAUDE_WORKFLOW_GATEWAY_ENV_FILE"
      break
    fi
    _CLAUDE_WORKFLOW_GATEWAY_ATTEMPT=$((_CLAUDE_WORKFLOW_GATEWAY_ATTEMPT + 1))
    sleep 0.1
  done
  unset _CLAUDE_WORKFLOW_GATEWAY_MANAGER
  unset _CLAUDE_WORKFLOW_GATEWAY_CANONICAL_STATE_DIR
  unset _CLAUDE_WORKFLOW_GATEWAY_LEGACY_STATE_DIR
  unset _CLAUDE_WORKFLOW_GATEWAY_STATE_DIR
  unset _CLAUDE_WORKFLOW_GATEWAY_ENV_FILE
  unset _CLAUDE_WORKFLOW_GATEWAY_ATTEMPT
fi
EOF
      echo '# <<< claude-workflow gateway <<<'
    } >>"$temp_file"; then
      rm -f "$temp_file"
      echo "claude-workflow-gateway: could not build shell hook update for $shell_rc" >&2
      return 1
    fi
  fi
  if [ -e "$shell_rc" ]; then
    node_bin="$(find_node)" || {
      rm -f "$temp_file"
      echo "claude-workflow-gateway: node not found" >&2
      return 1
    }
    shell_rc_mode="$(file_mode "$node_bin" "$shell_rc")" || {
      rm -f "$temp_file"
      echo "claude-workflow-gateway: could not read shell rc mode: $shell_rc" >&2
      return 1
    }
    if ! chmod "$shell_rc_mode" "$temp_file" 2>/dev/null; then
      rm -f "$temp_file"
      echo "claude-workflow-gateway: could not preserve shell rc mode: $shell_rc" >&2
      return 1
    fi
    cp -p "$shell_rc" "${shell_rc}.claude-workflow.bak" 2>/dev/null || true
  fi
  if ! mv -f "$temp_file" "$shell_rc"; then
    rm -f "$temp_file"
    echo "claude-workflow-gateway: could not replace shell rc atomically: $shell_rc" >&2
    return 1
  fi
}

install_shell() {
  local shell_rc
  shell_rc="$(shell_rc_path)" || return 1
  shell_rc="$(resolve_shell_rc_target "$shell_rc")" || return 1
  mkdir -p "$(dirname "$shell_rc")" || return 1
  touch "$shell_rc" || return 1
  if [ ! -f "$shell_rc" ]; then
    echo "claude-workflow-gateway: shell rc must be a regular file: $shell_rc" >&2
    return 1
  fi
  rewrite_shell_blocks "$shell_rc" install || return 1
  echo "claude-workflow-gateway: installed or refreshed shell hook in $shell_rc"
}

uninstall_shell() {
  local shell_rc
  shell_rc="$(shell_rc_path)" || return 1
  shell_rc="$(resolve_shell_rc_target "$shell_rc")" || return 1
  rewrite_shell_blocks "$shell_rc" || return 1
  echo "claude-workflow-gateway: removed shell hook from $shell_rc"
}

validate_manager_paths || exit 1

case "${1:-status}" in
  ensure)
    if ! daemon_is_current; then
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
    stop_daemon && start_daemon
    ;;
  status)
    if daemon_is_current; then
      echo "claude-workflow-gateway: healthy and current on port $PORT"
    elif healthy && pid_running; then
      echo "claude-workflow-gateway: healthy but stale on port $PORT"
      exit 1
    elif healthy; then
      echo "claude-workflow-gateway: port $PORT is healthy but not owned by the recorded daemon"
      exit 1
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
  uninstall-shell)
    uninstall_shell
    ;;
  *)
    echo "Usage: $0 {ensure|start|stop|restart|status|log|install-shell|uninstall-shell}" >&2
    exit 2
    ;;
esac
