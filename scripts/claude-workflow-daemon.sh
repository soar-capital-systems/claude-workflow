#!/usr/bin/env bash
# Manage the shared claude-workflow gateway daemon.
#
# Usage: claude-workflow-daemon.sh {start|stop|restart|reconcile|status|log|install-shell|uninstall-shell|migrate-shell}
#
# `ensure` is a fail-closed compatibility command for historical shell hooks.
# Shell startup must never start or source the shared gateway.
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
MANAGED_STATE_HELPER="$REPO_ROOT/js/cli/claude-workflow-managed-state.js"
normalize_directory_base() {
  local value="$1"
  while [ "$value" != "/" ] && [ "${value%/}" != "$value" ]; do
    value="${value%/}"
  done
  printf '%s\n' "$value"
}
HOME_BASE="$(normalize_directory_base "$HOME")"
STATE_HOME="$(normalize_directory_base "${XDG_STATE_HOME:-$HOME_BASE/.cache}")"
CANONICAL_STATE_DIR="$STATE_HOME/claude-workflow"
LEGACY_STATE_DIR="$HOME_BASE/.cache/ultrathink"
if [ -n "${CLAUDE_WORKFLOW_GATEWAY_STATE_DIR:-}" ]; then
  STATE_DIR="$CLAUDE_WORKFLOW_GATEWAY_STATE_DIR"
elif [ ! -e "$CANONICAL_STATE_DIR" ] && {
  [ -f "$LEGACY_STATE_DIR/claude-workflow-gateway.pid" ] ||
    [ -f "$LEGACY_STATE_DIR/claude-workflow-gateway.env" ] ||
    [ -f "$LEGACY_STATE_DIR/.claude-workflow-gateway.owner" ]
}; then
  STATE_DIR="$LEGACY_STATE_DIR"
else
  STATE_DIR="$CANONICAL_STATE_DIR"
fi
ENV_FILE="${CLAUDE_WORKFLOW_GATEWAY_ENV_FILE:-$STATE_DIR/claude-workflow-gateway.env}"
if [ "$STATE_DIR" = "$CANONICAL_STATE_DIR" ]; then
  STATE_KIND="canonical"
elif [ "$STATE_DIR" = "$LEGACY_STATE_DIR" ]; then
  STATE_KIND="legacy"
else
  STATE_KIND="custom"
fi
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
  node_bin="$(find_node)" || {
    echo "claude-workflow-gateway: node not found" >&2
    return 1
  }
  "$node_bin" "$MANAGED_STATE_HELPER" claim "$STATE_DIR" "$STATE_KIND"
}

verify_or_migrate_existing_state() {
  local node_bin
  [ -e "$STATE_DIR" ] || return 2
  node_bin="$(find_node)" || {
    echo "claude-workflow-gateway: node not found" >&2
    return 1
  }
  "$node_bin" "$MANAGED_STATE_HELPER" verify-or-migrate "$STATE_DIR" "$STATE_KIND"
}

verify_managed_replacement() {
  local target="$1"
  local node_bin
  node_bin="$(find_node)" || return 1
  "$node_bin" "$MANAGED_STATE_HELPER" verify-replacement "$STATE_DIR" "${target##*/}"
}

remove_managed_runtime_files() {
  local node_bin
  node_bin="$(find_node)" || return 1
  "$node_bin" "$MANAGED_STATE_HELPER" remove "$STATE_DIR" \
    "${PID_FILE##*/}" "${REVISION_FILE##*/}" "${ENV_FILE##*/}"
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
  local node_bin
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
  if [ "$ENV_FILE" != "$STATE_DIR/claude-workflow-gateway.env" ]; then
    echo "claude-workflow-gateway: CLAUDE_WORKFLOW_GATEWAY_ENV_FILE must be exactly $STATE_DIR/claude-workflow-gateway.env (inside the managed state directory)" >&2
    return 1
  fi
  if [ "${ULTRATHINK_GATEWAY_TRACE_DIR+x}" = "x" ]; then
    case "${ULTRATHINK_GATEWAY_TRACE_DIR:-}" in
      ''|"$STATE_DIR/gateway-trace") ;;
      *)
        trace_dir_normalized="$(printf '%s' "$ULTRATHINK_GATEWAY_TRACE_DIR" | tr '[:upper:]' '[:lower:]')"
        case "$trace_dir_normalized" in
          0|false|no|off) ;;
          *)
            echo "claude-workflow-gateway: shared-daemon ULTRATHINK_GATEWAY_TRACE_DIR must be $STATE_DIR/gateway-trace or disabled with off/false/no/0" >&2
            return 1
            ;;
        esac
        ;;
      esac
  fi
  node_bin="$(find_node)" || {
    echo "claude-workflow-gateway: node not found" >&2
    return 1
  }
  "$node_bin" "$MANAGED_STATE_HELPER" validate-paths "$STATE_DIR" "$ENV_FILE"
}

validate_shared_project_env() {
  local normalized
  normalized="$(printf '%s' "${CLAUDE_WORKFLOW_LOAD_PROJECT_ENV:-}" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    1|true|yes|on)
      echo "claude-workflow-gateway: shared mode cannot load a repository .env; use the per-session claude-workflow launcher when CLAUDE_WORKFLOW_LOAD_PROJECT_ENV is enabled" >&2
      return 1
      ;;
  esac
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
  const stats = fs.lstatSync(configPath, { bigint: true });
  hash.update(`user-config:${configName}\0`);
  hash.update(crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest());
  hash.update('\0');
  hash.update(String(stats.mode));
  hash.update('\0');
}

const revisionEnvPrefixes = ['CLAUDE_WORKFLOW_', 'ULTRATHINK_'];
const revisionEnvNames = new Set([
  'ANTHROPIC_API_KEY',
  'BAILIAN_TOKEN_PLAN_API_KEY',
  'CODEX_HOME',
  'DASHSCOPE_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_DEFAULT_MODEL_ID',
  'GLM_API_KEY',
  'GLM_BASE_URL',
  'GLM_DEFAULT_MODEL_ID',
  'KIMI_API_KEY',
  'OPENAI_API_KEY',
  'PATH',
  'QWEN_API_KEY',
  'QWEN_BASE_URL',
  'QWEN_MODEL',
  'QWEN_REASONING_EFFORT',
  'ZAI_API_KEY',
  'ZAI_BASE_URL',
  'ZAI_DEFAULT_MODEL_ID',
  'ZAI_REASONING_EFFORT',
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
]);
const projectEnvOptIn = new Set(['1', 'true', 'yes', 'on']).has(
  String(process.env.CLAUDE_WORKFLOW_LOAD_PROJECT_ENV || '').trim().toLowerCase()
);
if (projectEnvOptIn) {
  const projectRoot = process.cwd();
  const projectEnvPath = path.join(projectRoot, '.env');
  hash.update('project-root\0');
  hash.update(projectRoot);
  hash.update('\0');
  if (fs.existsSync(projectEnvPath)) {
    const stats = fs.lstatSync(projectEnvPath, { bigint: true });
    hash.update('project-config:.env\0');
    hash.update(crypto.createHash('sha256').update(fs.readFileSync(projectEnvPath)).digest());
    hash.update('\0');
    hash.update(String(stats.mode));
    hash.update('\0');
  }
}
const noProxyEntries = [process.env.no_proxy, process.env.NO_PROXY]
  .filter((value) => typeof value === 'string' && value.trim() !== '')
  .join(',')
  .split(/[,\s]+/u)
  .map((entry) => entry.trim())
  .filter(Boolean);
const seenNoProxyEntries = new Set();
const canonicalNoProxyEntries = noProxyEntries.filter((entry) => {
  const normalized = entry.toLowerCase();
  if (seenNoProxyEntries.has(normalized)) {
    return false;
  }
  seenNoProxyEntries.add(normalized);
  return true;
});
const proxyConfigured = [
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
].some((name) => String(process.env[name] || '').trim() !== '');
const gatewayHost = String(process.env.ULTRATHINK_GATEWAY_HOST || '127.0.0.1')
  .trim()
  .replace(/^\[/u, '')
  .replace(/\]$/u, '')
  .replace(/\.$/u, '')
  .toLowerCase();
if (proxyConfigured && gatewayHost && !seenNoProxyEntries.has(gatewayHost)) {
  canonicalNoProxyEntries.push(gatewayHost);
}
const canonicalNoProxy = canonicalNoProxyEntries.join(',');
if (canonicalNoProxy) {
  hash.update('environment:NO_PROXY\0');
  hash.update(crypto.createHash('sha256').update(canonicalNoProxy).digest());
  hash.update('\0');
}
function ambientAnthropicApiKeyIsEffective() {
  if (String(process.env.ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY || '').trim()) {
    return false;
  }
  try {
    const routeMap = JSON.parse(process.env.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON || '{}');
    if (
      routeMap &&
      typeof routeMap === 'object' &&
      !Array.isArray(routeMap) &&
      Object.values(routeMap).some((route) =>
        String(route?.provider || route?.target?.provider || '').trim().toLowerCase() ===
        'anthropic'
      )
    ) {
      return true;
    }
  } catch {
    // Hash conservatively; the daemon will report the malformed route map.
    return true;
  }
  const passthrough = String(
    process.env.ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS ||
      process.env.ULTRATHINK_GATEWAY_PASSTHROUGH_MODEL_IDS ||
      ''
  ).trim();
  if (passthrough) {
    return passthrough.toLowerCase() !== 'none';
  }
  return String(
    process.env.ULTRATHINK_GATEWAY_MAIN_PROVIDER ||
      process.env.CLAUDE_WORKFLOW_MAIN_PROVIDER ||
      'anthropic'
  ).trim().toLowerCase() === 'anthropic';
}
const includeAmbientAnthropicApiKey = ambientAnthropicApiKeyIsEffective();
for (const name of Object.keys(process.env).sort()) {
  if (
    !revisionEnvNames.has(name) &&
    !revisionEnvPrefixes.some((prefix) => name.startsWith(prefix))
  ) {
    continue;
  }
  if (name === 'ULTRATHINK_GATEWAY_RUNTIME_REVISION' ||
      name === 'ULTRATHINK_GATEWAY_RUNTIME_STARTED_AT') {
    continue;
  }
  if (name.startsWith('CLAUDE_WORKFLOW_GATEWAY_MANAGED_') ||
      name.startsWith('CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_')) {
    continue;
  }
  if (
    name === 'ANTHROPIC_API_KEY' &&
    (!includeAmbientAnthropicApiKey ||
      (process.env.CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN &&
        process.env.ANTHROPIC_API_KEY ===
          process.env.CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN))
  ) {
    continue;
  }
  hash.update(`environment:${name}\0`);
  hash.update(
    crypto.createHash('sha256').update(String(process.env[name] || '')).digest()
  );
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
  if ! verify_managed_replacement "$target"; then
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
  "$node_bin" - "$DAEMON_JS" "$LOG_FILE" "$STATE_DIR" "$PORT" <<'NODE'
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const daemonPath = process.argv[2];
const logPath = process.argv[3];
const statePath = process.argv[4];
const port = process.argv[5];
if (fs.existsSync(logPath)) {
  const existingLogStats = fs.lstatSync(logPath);
  if (existingLogStats.isSymbolicLink() || !existingLogStats.isFile()) {
    throw new Error(`gateway log path must be a regular file: ${logPath}`);
  }
}
const logFlags =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_APPEND |
  (fs.constants.O_NOFOLLOW || 0);
const logFd = fs.openSync(logPath, logFlags, 0o600);
fs.fchmodSync(logFd, 0o600);
const logStats = fs.fstatSync(logFd);
if (
  !logStats.isFile() ||
  (logStats.mode & 0o077) !== 0 ||
  (typeof process.getuid === 'function' && logStats.uid !== process.getuid())
) {
  fs.closeSync(logFd);
  throw new Error(
    `gateway log does not enforce owner-only permissions: ${logPath}. ` +
      'On WSL, use the Linux filesystem or enable DrvFS metadata.'
  );
}
const child = spawn(
  process.execPath,
  [
    daemonPath,
    '--claude-workflow-managed-state',
    statePath,
    '--claude-workflow-managed-port',
    port,
  ],
  {
  detached: true,
  env: process.env,
  stdio: ['ignore', logFd, logFd],
  }
);
child.unref();
fs.closeSync(logFd);
process.stdout.write(`${child.pid}\n`);
NODE
}

health_payload() {
  local node_bin
  local health_url="${1:-$HEALTH_URL}"
  node_bin="$(find_node)" || return 1
  "$node_bin" - "$health_url" <<'NODE'
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
  local health_url="${3:-$HEALTH_URL}"
  local payload
  local node_bin
  payload="$(health_payload "$health_url" 2>/dev/null)" || return 1
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
    command_kind="$("$node_bin" - "$pid" "$DAEMON_JS" "$STATE_DIR" "$PORT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const pid = process.argv[2];
const expectedDaemon = fs.realpathSync(process.argv[3]);
const expectedState = process.argv[4];
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
  const stateIndex = args.indexOf('--claude-workflow-managed-state');
  const portIndex = args.indexOf('--claude-workflow-managed-port');
  const hasManagedBinding = stateIndex !== -1 || portIndex !== -1;
  if (stateIndex !== -1 && args[stateIndex + 1] === expectedState) {
    process.stdout.write('current');
  } else if (hasManagedBinding) {
    process.exit(1);
  } else {
    process.stdout.write('legacy');
  }
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
  local managed_marker
  local recorded_port
  managed_marker="$DAEMON_JS --claude-workflow-managed-state $STATE_DIR --claude-workflow-managed-port "
  case "$command_line" in
    *"$managed_marker"*)
      recorded_port="${command_line#*"$managed_marker"}"
      recorded_port="${recorded_port%% *}"
      case "$recorded_port" in
        ''|*[!0-9]*) return 1 ;;
      esac
      health_matches_runtime "$pid" "" "http://127.0.0.1:$recorded_port/healthz"
      return
      ;;
  esac
  if printf '%s\n' "$command_line" | grep -Fq -- "$DAEMON_JS"; then
    # Legacy managed daemons did not carry state/port identity arguments.
    health_matches_runtime "$pid"
    return
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
  verify_or_migrate_existing_state >/dev/null 2>&1 || return 1
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
  remove_managed_runtime_files
}

acquire_start_lock() {
  # Single-starter mutex: concurrent shells (tmux session restore) must not
  # each spawn a gateway that loses the port race. Linux/WSL normally have
  # flock; macOS does not, so fall back to atomic mkdir with a stale-pid check.
  if command -v flock >/dev/null 2>&1; then
    if ! verify_managed_replacement "$LOCK_FILE"; then
      return 1
    fi
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
    chmod 700 "$LOCK_DIR" 2>/dev/null || {
      rmdir "$LOCK_DIR" 2>/dev/null || true
      return 1
    }
    (umask 077 && printf '%s\n' "$$" >"$LOCK_DIR/pid") || {
      rm -f "$LOCK_DIR/pid"
      rmdir "$LOCK_DIR" 2>/dev/null || true
      return 1
    }
    return 0
  fi

  local lock_pid
  local node_bin
  node_bin="$(find_node)" || return 1
  lock_pid="$("$node_bin" "$MANAGED_STATE_HELPER" read-lock-pid "$STATE_DIR" 2>/dev/null)" || {
    echo "claude-workflow-gateway: existing start lock is not a verified managed lock; refusing removal" >&2
    return 1
  }
  if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
    "$node_bin" "$MANAGED_STATE_HELPER" remove-lock "$STATE_DIR" "$lock_pid" || return 1
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      chmod 700 "$LOCK_DIR" 2>/dev/null || {
        rmdir "$LOCK_DIR" 2>/dev/null || true
        return 1
      }
      (umask 077 && printf '%s\n' "$$" >"$LOCK_DIR/pid") || {
        rm -f "$LOCK_DIR/pid"
        rmdir "$LOCK_DIR" 2>/dev/null || true
        return 1
      }
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
      local node_bin
      node_bin="$(find_node)" || return 1
      "$node_bin" "$MANAGED_STATE_HELPER" remove-lock "$STATE_DIR" "$$" || return 1
      ;;
  esac
  START_LOCK_MODE=""
}

start_daemon() {
  validate_managed_port || return 1
  validate_shared_project_env || return 1
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
  if ! verify_managed_replacement "$LOG_FILE"; then
    echo "claude-workflow-gateway: refusing unverified log collision: $LOG_FILE" >&2
    return 1
  fi

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
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR="$STATE_DIR" \
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
  local state_result
  verify_or_migrate_existing_state
  state_result=$?
  if [ "$state_result" -ne 0 ]; then
    if [ "$state_result" -eq 2 ]; then
      echo "claude-workflow-gateway: not running"
      return 0
    fi
    return "$state_result"
  fi
  pid="$(daemon_pid)"
  if pid_is_daemon "$pid"; then
    if terminate_daemon_pid "$pid"; then
      remove_managed_runtime_files || return 1
      echo "claude-workflow-gateway: stopped"
    else
      echo "claude-workflow-gateway: could not stop verified daemon pid $pid" >&2
      return 1
    fi
  else
    remove_managed_runtime_files || return 1
    echo "claude-workflow-gateway: not running"
  fi
}

reconcile_daemon() {
  local pid
  local state_result
  verify_or_migrate_existing_state
  state_result=$?
  if [ "$state_result" -ne 0 ]; then
    if [ "$state_result" -eq 2 ]; then
      echo "claude-workflow-gateway: no running owned daemon to reconcile"
      return 0
    fi
    return "$state_result"
  fi
  pid="$(daemon_pid)"
  if ! pid_is_daemon "$pid"; then
    remove_managed_runtime_files || return 1
    echo "claude-workflow-gateway: no running owned daemon to reconcile"
    return 0
  fi

  start_daemon || return 1
  if ! daemon_is_current; then
    echo "claude-workflow-gateway: reconciliation did not load the installed runtime revision" >&2
    return 1
  fi
  echo "claude-workflow-gateway: running daemon matches the installed runtime revision"
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
  local link_count=0
  case "$target" in
    /*) ;;
    *)
      echo "claude-workflow-gateway: shell rc must resolve from an absolute path: $target" >&2
      return 1
      ;;
  esac
  while [ -h "$target" ]; do
    link_count=$((link_count + 1))
    if [ "$link_count" -gt 40 ]; then
      echo "claude-workflow-gateway: shell rc contains a symlink cycle: $target" >&2
      return 1
    fi
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
  local temp_file
  local transition_file
  local rendered_file
  local node_bin
  local shell_rc_mode
  local backup_file
  [ -f "$shell_rc" ] || return 0
  temp_file="$(mktemp "${shell_rc}.claude-workflow.XXXXXX")" || return 1
  if ! awk '
    index($0, "# >>> ultrathink claude-workflow gateway >>>") == 1 ||
    index($0, "# >>> claude-workflow gateway >>>") == 1 ||
    index($0, "# >>> claude-workflow shell cleanup >>>") == 1 {
      if (skipping) malformed = 1
      if (!inserted) {
        print "# __CLAUDE_WORKFLOW_SHELL_CLEANUP_TRANSITION__"
        inserted = 1
      }
      skipping = 1
      next
    }
    index($0, "# <<< ultrathink claude-workflow gateway <<<") == 1 ||
    index($0, "# <<< claude-workflow gateway <<<") == 1 ||
    index($0, "# <<< claude-workflow shell cleanup <<<") == 1 {
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
  if [ ! -r "$SCRIPT_DIR/claude-workflow-gateway.bashrc" ]; then
      rm -f "$temp_file"
      echo "claude-workflow-gateway: cleanup transition source is unavailable" >&2
      return 1
  fi
    if ! grep -Fq '# __CLAUDE_WORKFLOW_SHELL_CLEANUP_TRANSITION__' "$temp_file"; then
      {
        echo ''
        echo '# __CLAUDE_WORKFLOW_SHELL_CLEANUP_TRANSITION__'
      } >>"$temp_file" || {
        rm -f "$temp_file"
        return 1
      }
    fi
    transition_file="$(mktemp "${shell_rc}.claude-workflow-transition.XXXXXX")" || {
      rm -f "$temp_file"
      return 1
    }
    rendered_file="$(mktemp "${shell_rc}.claude-workflow-rendered.XXXXXX")" || {
      rm -f "$temp_file" "$transition_file"
      return 1
    }
    if ! {
      echo '# >>> claude-workflow shell cleanup >>>'
      cat "$SCRIPT_DIR/claude-workflow-gateway.bashrc"
      echo '# <<< claude-workflow shell cleanup <<<'
    } >"$transition_file"; then
      rm -f "$temp_file" "$transition_file" "$rendered_file"
      echo "claude-workflow-gateway: could not build shell cleanup transition for $shell_rc" >&2
      return 1
    fi
    if ! awk -v transition_file="$transition_file" '
      $0 == "# __CLAUDE_WORKFLOW_SHELL_CLEANUP_TRANSITION__" {
        while ((getline transition_line < transition_file) > 0) print transition_line
        close(transition_file)
        next
      }
      { print }
    ' "$temp_file" >"$rendered_file"; then
      rm -f "$temp_file" "$transition_file" "$rendered_file"
      echo "claude-workflow-gateway: could not render shell cleanup transition for $shell_rc" >&2
      return 1
    fi
    if ! mv -f "$rendered_file" "$temp_file"; then
      rm -f "$temp_file" "$transition_file" "$rendered_file"
      return 1
    fi
  rm -f "$transition_file"
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
    backup_file="${shell_rc}.claude-workflow.bak"
    if [ -h "$backup_file" ] || { [ -e "$backup_file" ] && [ ! -f "$backup_file" ]; }; then
      rm -f "$temp_file"
      echo "claude-workflow-gateway: refusing unsafe shell rc backup collision: $backup_file" >&2
      return 1
    fi
    if [ ! -e "$backup_file" ] && ! ln "$shell_rc" "$backup_file" 2>/dev/null; then
      rm -f "$temp_file"
      echo "claude-workflow-gateway: could not create shell rc backup: $backup_file" >&2
      return 1
    fi
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
  rewrite_shell_blocks "$shell_rc" || return 1
  echo "claude-workflow-gateway: installed cleanup-only shell transition in $shell_rc"
  echo "claude-workflow-gateway: open a new shell, or source that file once, to clear historical workflow exports"
}

uninstall_shell() {
  local shell_rc
  shell_rc="$(shell_rc_path)" || return 1
  shell_rc="$(resolve_shell_rc_target "$shell_rc")" || return 1
  if [ -e "$shell_rc" ] && [ ! -f "$shell_rc" ]; then
    echo "claude-workflow-gateway: shell rc must be a regular file: $shell_rc" >&2
    return 1
  fi
  [ -f "$shell_rc" ] || {
    echo "claude-workflow-gateway: no shell rc to migrate at $shell_rc"
    return 0
  }
  rewrite_shell_blocks "$shell_rc" || return 1
  echo "claude-workflow-gateway: replaced shell routing with a cleanup-only transition in $shell_rc"
  echo "claude-workflow-gateway: open a new shell, or source that file once, before removing the transition block"
}

inherited_workflow_routing_present() {
  if [ -n "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES:-}" ]; then
    return 0
  fi
  [ "${ANTHROPIC_BASE_URL:-}" = "http://127.0.0.1:4318" ] && {
    [ "${CLAUDE_CODE_SUBAGENT_MODEL:-}" = "codex-terra" ] ||
      [ "${ANTHROPIC_DEFAULT_SONNET_MODEL:-}" = "codex-terra" ] ||
      [ "${ANTHROPIC_DEFAULT_HAIKU_MODEL:-}" = "codex-terra" ] ||
      [ "${ANTHROPIC_DEFAULT_OPUS_MODEL:-}" = "codex-terra" ]
  }
}

migrate_shell() {
  if [ -n "${CLAUDE_WORKFLOW_SHELL_RC:-}" ]; then
    install_shell
    return
  fi
  case "$(basename "${SHELL:-}")" in
    bash|zsh) install_shell ;;
    *)
      if inherited_workflow_routing_present; then
        echo "claude-workflow-gateway: inherited workflow routing is active, but no Bash/zsh rc was selected; set CLAUDE_WORKFLOW_SHELL_RC to the absolute rc path and retry" >&2
        return 1
      fi
      echo "claude-workflow-gateway: no active Bash/zsh rc selected; shell migration skipped"
      ;;
  esac
}

migrate_shell_upgrade() {
  local shell_rc
  local migrated=0

  migrate_shell_upgrade_path() {
    local candidate="$1"
    candidate="$(resolve_shell_rc_target "$candidate")" || return 1
    if [ -e "$candidate" ] && [ ! -f "$candidate" ]; then
      echo "claude-workflow-gateway: shell rc must be a regular file: $candidate" >&2
      return 1
    fi
    if [ -f "$candidate" ] && grep -Eq \
      '^# >>> (ultrathink claude-workflow gateway|claude-workflow gateway|claude-workflow shell cleanup) >>>$' \
      "$candidate"; then
      rewrite_shell_blocks "$candidate" || return 1
      echo "claude-workflow-gateway: replaced shell routing with a cleanup-only transition in $candidate"
      migrated=1
    fi
  }

  if [ -n "${CLAUDE_WORKFLOW_SHELL_RC:-}" ]; then
    shell_rc="$(shell_rc_path)" || return 1
    migrate_shell_upgrade_path "$shell_rc" || return 1
  else
    migrate_shell_upgrade_path "$HOME_BASE/.bashrc" || return 1
    migrate_shell_upgrade_path "${ZDOTDIR:-$HOME_BASE}/.zshrc" || return 1
  fi
  if [ "$migrated" = 1 ]; then
    echo "claude-workflow-gateway: open a new shell, or source the migrated rc once, to clear historical workflow exports"
    return 0
  fi
  if inherited_workflow_routing_present; then
    case "$(basename "${SHELL:-}")" in
      bash|zsh) install_shell; return ;;
      *)
        echo "claude-workflow-gateway: inherited workflow routing is active, but no Bash/zsh rc was selected; set CLAUDE_WORKFLOW_SHELL_RC to the absolute rc path and retry" >&2
        return 1
        ;;
    esac
  fi
  echo "claude-workflow-gateway: no historical shell routing to migrate"
}

case "${1:-status}" in
  ensure)
    # Retained only so old hooks fail closed instead of starting a gateway
    # after a manager upgrade. Shell-wide routing is no longer supported.
    echo "claude-workflow-gateway: automatic shell routing was removed; use claude-workflow for scoped routing" >&2
    exit 1
    ;;
  start)
    validate_manager_paths && start_daemon
    ;;
  stop)
    validate_manager_paths && stop_daemon
    ;;
  restart)
    validate_manager_paths && stop_daemon && start_daemon
    ;;
  reconcile)
    # Package install/setup hook: refresh only a daemon the recorded pid and
    # health endpoint prove is ours. A stopped daemon stays stopped.
    validate_manager_paths && reconcile_daemon
    ;;
  status)
    validate_manager_paths || exit 1
    if [ -e "$STATE_DIR" ]; then
      verify_or_migrate_existing_state || exit 1
    fi
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
    validate_manager_paths || exit 1
    verify_or_migrate_existing_state || exit 1
    tail -n "${2:-50}" "$LOG_FILE"
    ;;
  install-shell)
    install_shell
    ;;
  uninstall-shell)
    uninstall_shell
    ;;
  migrate-shell)
    migrate_shell
    ;;
  migrate-shell-upgrade)
    migrate_shell_upgrade
    ;;
  *)
    echo "Usage: $0 {ensure|start|stop|restart|reconcile|status|log|install-shell|uninstall-shell|migrate-shell|migrate-shell-upgrade}" >&2
    exit 2
    ;;
esac
