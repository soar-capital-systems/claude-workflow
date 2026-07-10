import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CODEX_MODEL, envFlag, isGatewayLoopbackHost } from '../gateway/config.js';
import { resolveModelRoute } from '../gateway/model-routing.js';
import {
  buildWorkflowGatewayConfig,
  DEFAULT_MAIN_MODEL_ID,
  DEFAULT_SUBAGENT_REASONING_EFFORT,
  routeProvider,
  routeTargetSummary,
} from '../gateway/workflow-config.js';

const COMMAND_TIMEOUT_MS = 10_000;
const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_LOCK_POLL_MS = 25;
const MINIMUM_CODEX_VERSION = Object.freeze([0, 144, 1]);
const CONFIG_FILE_NAME = '.claude-workflow.env';
const SAFE_CONFIG_VALUE = /^[A-Za-z0-9._:/[\]-]+$/u;
const REASONING_EFFORTS = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const AGENT_TIERS = new Set(['sol', 'terra', 'luna']);
const PERMISSION_MODES = new Set(['bypass', 'prompt']);
const CODEX_LOGIN_FAILURE_PATTERN =
  /not\s+logged\s+in|logged\s+out|not\s+authenticated|not\s+signed\s+in/iu;
const CODEX_LOGIN_SUCCESS_PATTERN = /logged in|authenticated|signed in/iu;
const MANAGED_CONFIG_KEYS = Object.freeze([
  'ULTRATHINK_GATEWAY_MAIN_MODEL_ID',
  'ULTRATHINK_GATEWAY_MAIN_PROVIDER',
  'CLAUDE_WORKFLOW_MAIN_PROVIDER',
  'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL',
  'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_CODEX_MODEL',
  'ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL',
  'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT',
  'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID',
  'CLAUDE_WORKFLOW_SKIP_PERMISSIONS',
]);
const GATEWAY_MANAGER = fileURLToPath(
  new URL('../../scripts/claude-workflow-daemon.sh', import.meta.url)
);

function writeLine(stream, value = '') {
  stream.write(`${value}\n`);
}

function withProcessEnvironment(env, callback) {
  if (!env || env === process.env) {
    return callback();
  }

  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    return callback();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, original);
  }
}

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || COMMAND_TIMEOUT_MS,
    shell: process.platform === 'win32',
  });
}

function commandOutput(result) {
  return `${result?.stdout || ''}${result?.stderr || ''}`.trim();
}

function commandFailure(result) {
  if (result?.error?.code === 'ETIMEDOUT') {
    return 'timed out';
  }
  if (result?.error) {
    return result.error.message;
  }
  return `exited with status ${result?.status ?? 'unknown'}`;
}

export function findExecutable(commandName, env = process.env) {
  if (typeof commandName !== 'string' || commandName.trim() === '') {
    return '';
  }

  if (path.isAbsolute(commandName) || commandName.includes(path.sep)) {
    try {
      fs.accessSync(commandName, fs.constants.X_OK);
      return path.resolve(commandName);
    } catch {
      return '';
    }
  }

  for (const directory of String(env.PATH || '').split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, commandName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return '';
}

export function isWsl(env = process.env) {
  if (process.platform !== 'linux') {
    return false;
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  try {
    return /microsoft/iu.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
  } catch {
    return false;
  }
}

export function isWindowsMountedPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  return /^\/mnt\/[a-z](?:\/|$)/iu.test(normalized) || /\.exe$/iu.test(normalized);
}

function platformCheck(env = process.env, codexCommand = 'codex') {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return {
      ok: false,
      label: `Platform ${process.platform}`,
      detail: 'Use macOS, Linux, or WSL with Linux-native tools.',
    };
  }

  if (!isWsl(env)) {
    return {
      ok: true,
      label: process.platform === 'darwin' ? 'Platform macOS' : 'Platform Linux',
    };
  }

  const unsafePaths = [];
  const pathCandidates = [
    ['Node.js', process.execPath],
    ['Claude Workflow', GATEWAY_MANAGER],
    ['Claude Code', findExecutable('claude', env)],
    ['Codex', findExecutable(codexCommand, env)],
    ['Home directory', env.HOME || env.USERPROFILE || os.homedir()],
    [
      'Gateway state',
      env.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR ||
        (env.XDG_STATE_HOME
          ? path.join(env.XDG_STATE_HOME, 'claude-workflow')
          : path.join(env.HOME || os.homedir(), '.cache', 'claude-workflow')),
    ],
  ];
  for (const [label, candidate] of pathCandidates) {
    if (!candidate) {
      continue;
    }
    let resolved;
    try {
      resolved = resolveThroughExistingAncestor(candidate);
    } catch (error) {
      return {
        ok: false,
        label: 'Platform WSL',
        detail: `Could not resolve ${label}: ${error.message}`,
      };
    }
    if (isWindowsMountedPath(resolved)) {
      unsafePaths.push([label, resolved]);
    }
  }
  if (unsafePaths.length > 0) {
    return {
      ok: false,
      label: 'Platform WSL',
      detail:
        `${unsafePaths.map(([name]) => name).join(', ')} resolves to Windows or /mnt storage. ` +
        'Install Node.js, Claude Code, and Codex inside this WSL distribution and keep state under /home.',
    };
  }

  return { ok: true, label: 'Platform WSL (Linux-native tools)' };
}

function nodeCheck() {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    ok: Number.isInteger(major) && major >= 20,
    label: `Node.js ${process.version}`,
    ...(
      Number.isInteger(major) && major >= 20
        ? {}
        : { detail: 'Install Node.js 20 or newer.' }
    ),
  };
}

function versionAtLeast(actual, required) {
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] > required[index]) {
      return true;
    }
    if (actual[index] < required[index]) {
      return false;
    }
  }
  return true;
}

function claudeCheck(run = commandResult, env = process.env) {
  if (!findExecutable('claude', env)) {
    return {
      ok: false,
      label: 'Claude Code',
      detail: 'Not found on PATH. Install Claude Code, then run `claude auth login`.',
    };
  }

  const versionResult = run('claude', ['--version'], { env });
  if (versionResult.status !== 0 || versionResult.error) {
    return {
      ok: false,
      label: 'Claude Code',
      detail: `Could not read its version: ${commandFailure(versionResult)}.`,
    };
  }

  const version = (commandOutput(versionResult).split(/\r?\n/u)[0] || 'installed')
    .replace(/\s*\(Claude Code\)\s*$/iu, '')
    .trim();
  const authResult = run('claude', ['auth', 'status', '--json'], { env });
  if (authResult.status !== 0 || authResult.error) {
    return {
      ok: false,
      label: `Claude Code ${version}`,
      detail: `Authentication check ${commandFailure(authResult)}. Run \`claude auth login\`.`,
    };
  }

  try {
    const status = JSON.parse(authResult.stdout || '{}');
    const loggedIn = status.loggedIn === true || status.logged_in === true;
    return loggedIn
      ? { ok: true, label: `Claude Code ${version} (authenticated)` }
      : {
          ok: false,
          label: `Claude Code ${version}`,
          detail: 'Not authenticated. Run `claude auth login`.',
        };
  } catch {
    return {
      ok: false,
      label: `Claude Code ${version}`,
      detail: 'Authentication status was not valid JSON. Update Claude Code and try again.',
    };
  }
}

function codexCheck(commandName, run = commandResult, env = process.env) {
  if (!findExecutable(commandName, env)) {
    return {
      ok: false,
      label: 'Codex CLI',
      detail: `${commandName} was not found or is not executable. Install Codex, then run \`${commandName} login\`.`,
    };
  }

  const versionResult = run(commandName, ['--version'], { env });
  if (versionResult.status !== 0 || versionResult.error) {
    return {
      ok: false,
      label: 'Codex CLI',
      detail: `Could not read its version: ${commandFailure(versionResult)}.`,
    };
  }

  const version = (commandOutput(versionResult).split(/\r?\n/u)[0] || 'installed')
    .replace(/^codex-cli\s+/iu, '')
    .trim();
  const versionParts = version.match(/(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number);
  if (!versionParts || !versionAtLeast(versionParts, MINIMUM_CODEX_VERSION)) {
    return {
      ok: false,
      label: `Codex CLI ${version}`,
      detail: 'Claude Workflow requires Codex CLI 0.144.1 or newer. Update Codex and try again.',
    };
  }
  const authResult = run(commandName, ['login', 'status'], { env });
  const authOutput = commandOutput(authResult).toLowerCase();
  const loggedIn =
    authResult.status === 0 &&
    !authResult.error &&
    !CODEX_LOGIN_FAILURE_PATTERN.test(authOutput) &&
    CODEX_LOGIN_SUCCESS_PATTERN.test(authOutput);
  return loggedIn
    ? { ok: true, label: `Codex CLI ${version} (authenticated)` }
    : {
        ok: false,
        label: `Codex CLI ${version}`,
        detail: `Not authenticated. Run \`${commandName} login\`.`,
      };
}

function friendlyMainName(modelId) {
  if (/^claude-fable-5(?:\[|$)/u.test(modelId)) {
    return 'Fable 5';
  }
  return modelId;
}

function friendlyAgentName(modelId) {
  const tier = String(modelId || '').match(/-(sol|terra|luna)$/u)?.[1];
  return tier ? `${tier[0].toUpperCase()}${tier.slice(1)}` : modelId;
}

export function configurationPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(path.resolve(home), CONFIG_FILE_NAME);
}

export function effectiveConfigurationSummary(env = process.env) {
  return withProcessEnvironment(env, function summarizeEffectiveConfiguration() {
    const {
      config,
      mainModelId,
      rawSubagentModelId,
      subagentModelId,
      subagentRoute,
    } = buildWorkflowGatewayConfig();
    const mainRoute = resolveModelRoute(mainModelId, config);
    resolveModelRoute(rawSubagentModelId, config);
    if (subagentModelId !== rawSubagentModelId) {
      resolveModelRoute(subagentModelId, config);
    }
    if (!isGatewayLoopbackHost(config.host) && !config.sharedSecret) {
      throw new Error(
        `Gateway host ${config.host} is not loopback and has no shared secret. ` +
          'Use 127.0.0.1 or configure ULTRATHINK_GATEWAY_SHARED_SECRET.'
      );
    }
    if (
      config.sharedSecret &&
      routeProvider(mainRoute) === 'anthropic' &&
      !config.anthropic.apiKey
    ) {
      throw new Error(
        'Anthropic passthrough with a gateway shared secret requires ' +
          'ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY.'
      );
    }
    const agentModel =
      subagentRoute.model ||
      subagentRoute.upstreamModel ||
      subagentRoute.upstream_model ||
      config.codex.model;
    const effort =
      subagentRoute.reasoningEffort ||
      subagentRoute.reasoning_effort ||
      DEFAULT_SUBAGENT_REASONING_EFFORT;
    const configPath = configurationPath(env);

    return {
      path: configPath,
      fileExists: fs.existsSync(configPath),
      main: {
        name: friendlyMainName(mainModelId),
        model: mainModelId,
        provider: routeProvider(mainRoute),
        target: routeTargetSummary(mainRoute),
      },
      agents: {
        name: friendlyAgentName(agentModel),
        displayModel: subagentModelId,
        model: agentModel,
        provider: routeProvider(subagentRoute),
        effort,
      },
      permissions: envFlag(
        'CLAUDE_WORKFLOW_SKIP_PERMISSIONS',
        envFlag('ULTRATHINK_WORKFLOWS_SKIP_PERMISSIONS', true)
      )
        ? 'bypass'
        : 'prompt',
    };
  });
}

function configurationLines(summary) {
  const fileState = summary.fileExists ? '' : ' (not created; package defaults active)';
  return [
    `Config file   ${summary.path}${fileState}`,
    `Main          ${summary.main.name} -> ${summary.main.provider} (${summary.main.model})`,
    `Agents        ${summary.agents.name} -> ${summary.agents.provider} (${summary.agents.model})`,
    `Reasoning     ${summary.agents.effort}`,
    `Permissions   ${summary.permissions}`,
  ];
}

function assignmentKey(line) {
  return line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u)?.[1] || '';
}

export function rewriteConfigurationText(content, updates = {}, removals = []) {
  const lineEnding = String(content).includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = String(content).endsWith('\n');
  const sourceLines = String(content) === '' ? [] : String(content).split(/\r?\n/u);
  if (hadTrailingNewline) {
    sourceLines.pop();
  }

  const pending = new Map(Object.entries(updates));
  const removed = new Set(removals);
  const managed = new Set([...pending.keys(), ...removed]);
  const emitted = new Set();
  const result = [];
  for (const line of sourceLines) {
    const key = assignmentKey(line);
    if (!key || !managed.has(key)) {
      result.push(line);
      continue;
    }
    if (removed.has(key) || emitted.has(key)) {
      continue;
    }
    result.push(`${key}=${pending.get(key)}`);
    emitted.add(key);
    pending.delete(key);
  }

  if (pending.size > 0) {
    if (result.length > 0 && result.at(-1) !== '') {
      result.push('');
    }
    for (const [key, value] of pending) {
      result.push(`${key}=${value}`);
    }
  }

  if (result.length === 0) {
    return '';
  }
  return `${result.join(lineEnding)}${lineEnding}`;
}

function assertSafeConfigurationValues(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (!MANAGED_CONFIG_KEYS.includes(key)) {
      throw new Error(`refusing to manage unsupported configuration key ${key}`);
    }
    if (!SAFE_CONFIG_VALUE.test(value)) {
      throw new Error(`invalid value for ${key}`);
    }
  }
}

function sameFileVersion(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function waitForLockPoll() {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, CONFIG_LOCK_POLL_MS);
}

function acquireConfigurationLock(target) {
  const lockPath = path.join(path.dirname(target), `.${path.basename(target)}.lock`);
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  while (true) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        'utf8'
      );
      fs.fsyncSync(descriptor);
      fs.fchmodSync(descriptor, 0o600);
      const stats = fs.fstatSync(descriptor);
      if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
        throw new Error(
          `configuration storage does not enforce owner-only permissions: ${lockPath}. ` +
            'On WSL, use the Linux filesystem or enable DrvFS metadata.'
        );
      }
      return { descriptor, path: lockPath };
    } catch (error) {
      if (descriptor !== null) {
        fs.closeSync(descriptor);
        fs.rmSync(lockPath, { force: true });
      }
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      let stats;
      try {
        stats = fs.lstatSync(lockPath);
      } catch (statError) {
        if (statError?.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`configuration lock must be a regular file: ${lockPath}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for another configuration update: ${target}. ` +
            `If no config command is running, remove the stale lock ${lockPath}.`
        );
      }
      waitForLockPoll();
    }
  }
}

function releaseConfigurationLock(lock) {
  try {
    fs.closeSync(lock.descriptor);
  } finally {
    fs.rmSync(lock.path, { force: true });
  }
}

export function writeUserConfiguration(target, updates = {}, removals = []) {
  assertSafeConfigurationValues(updates);
  const absoluteTarget = path.resolve(target);
  const directory = path.dirname(absoluteTarget);
  fs.mkdirSync(directory, { recursive: true });

  const lock = acquireConfigurationLock(absoluteTarget);
  try {
    return writeUserConfigurationLocked(absoluteTarget, updates, removals);
  } finally {
    releaseConfigurationLock(lock);
  }
}

function writeUserConfigurationLocked(absoluteTarget, updates, removals) {
  const directory = path.dirname(absoluteTarget);
  let originalStats = null;
  let original = '';
  try {
    originalStats = fs.lstatSync(absoluteTarget);
    if (originalStats.isSymbolicLink() || !originalStats.isFile()) {
      throw new Error(`configuration path must be a regular file, not a symlink: ${absoluteTarget}`);
    }
    if (typeof process.getuid === 'function' && originalStats.uid !== process.getuid()) {
      throw new Error(`configuration file is not owned by the current user: ${absoluteTarget}`);
    }
    original = fs.readFileSync(absoluteTarget, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const next = rewriteConfigurationText(original, updates, removals);
  if (next === original) {
    if (originalStats && (originalStats.mode & 0o077) !== 0) {
      fs.chmodSync(absoluteTarget, 0o600);
      const hardenedStats = fs.lstatSync(absoluteTarget);
      if ((hardenedStats.mode & 0o077) !== 0) {
        throw new Error(
          `configuration storage does not enforce owner-only permissions: ${absoluteTarget}. ` +
            'On WSL, use the Linux filesystem or enable DrvFS metadata.'
        );
      }
    }
    return { changed: false, path: absoluteTarget };
  }

  const temporary = path.join(
    directory,
    `.${path.basename(absoluteTarget)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, next, 'utf8');
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    const temporaryStats = fs.fstatSync(descriptor);
    if (!temporaryStats.isFile() || (temporaryStats.mode & 0o077) !== 0) {
      throw new Error(
        `configuration storage does not enforce owner-only permissions: ${directory}. ` +
          'On WSL, use the Linux filesystem or enable DrvFS metadata.'
      );
    }
    fs.closeSync(descriptor);
    descriptor = null;

    if (originalStats) {
      const currentStats = fs.lstatSync(absoluteTarget);
      if (!sameFileVersion(originalStats, currentStats)) {
        throw new Error(`configuration changed while it was being updated: ${absoluteTarget}`);
      }
    } else if (fs.existsSync(absoluteTarget)) {
      throw new Error(`configuration appeared while it was being created: ${absoluteTarget}`);
    }

    fs.renameSync(temporary, absoluteTarget);
    const publishedStats = fs.lstatSync(absoluteTarget);
    if (!publishedStats.isFile() || publishedStats.isSymbolicLink() || (publishedStats.mode & 0o077) !== 0) {
      throw new Error(`published configuration is not an owner-only regular file: ${absoluteTarget}`);
    }
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
  }

  return { changed: true, path: absoluteTarget };
}

function parseNamedOptions(args, allowed) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' && allowed.has('help')) {
      if (Object.hasOwn(parsed, 'help')) {
        throw new Error('--help may be specified only once');
      }
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument ${arg}`);
    }
    const separator = arg.indexOf('=');
    const name = separator > 0 ? arg.slice(2, separator) : arg.slice(2);
    if (!allowed.has(name)) {
      throw new Error(`unknown option --${name}`);
    }
    if (Object.hasOwn(parsed, name)) {
      throw new Error(`--${name} may be specified only once`);
    }
    if (allowed.get(name) === false) {
      if (separator > 0) {
        throw new Error(`--${name} does not take a value`);
      }
      parsed[name] = true;
      continue;
    }
    const value = separator > 0 ? arg.slice(separator + 1) : args[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    parsed[name] = value;
  }
  return parsed;
}

function normalizeModel(value, label) {
  const normalized = String(value || '').trim();
  if (!SAFE_CONFIG_VALUE.test(normalized)) {
    throw new Error(`${label} must be a model id without spaces or shell characters`);
  }
  return normalized;
}

function agentModel(value, currentModel) {
  const trimmed = String(value || '').trim();
  const normalized = trimmed.toLowerCase();
  if (!AGENT_TIERS.has(normalized)) {
    return normalizeModel(trimmed, '--agents');
  }

  const family = String(currentModel || '').match(/^(gpt-\d+(?:\.\d+)*-)(?:sol|terra|luna)$/u)?.[1]
    || DEFAULT_CODEX_MODEL.match(/^(gpt-\d+(?:\.\d+)*-)/u)?.[1];
  if (!family) {
    throw new Error('could not determine the current Codex model family; pass a full model id');
  }
  return `${family}${normalized}`;
}

function configUsage() {
  return [
    'Usage:',
    '  claude-workflow config',
    '  claude-workflow config --agents terra --effort max',
    '  claude-workflow config --main fable --permissions bypass',
    '  claude-workflow config --reset',
    '',
    'Options:',
    '  --main <fable|model-id>       Main Anthropic model',
    '  --agents <sol|terra|luna|id>  Codex model for workflow agents',
    '  --effort <level>              minimal, low, medium, high, xhigh, max, or ultra',
    '  --permissions <mode>          bypass or prompt',
    '  --reset                       Remove settings managed by this command',
    '  --json                        Print the effective configuration as JSON',
    '  --path                        Print the user configuration path',
    '  --help, -h                    Show this help',
    '',
    `Saved settings use ${CONFIG_FILE_NAME} in the home directory. Exported environment variables take precedence.`,
  ].join('\n');
}

export function runConfigCommand(args, options = {}) {
  const stdout = options.stdout || process.stdout;
  const parsed = parseNamedOptions(
    args,
    new Map([
      ['main', true],
      ['agents', true],
      ['effort', true],
      ['permissions', true],
      ['reset', false],
      ['json', false],
      ['path', false],
      ['help', false],
    ])
  );
  if (parsed.help) {
    writeLine(stdout, configUsage());
    return;
  }
  if (parsed.path) {
    if (Object.keys(parsed).length !== 1) {
      throw new Error('--path cannot be combined with other config options');
    }
    writeLine(stdout, configurationPath());
    return;
  }

  const writeOptions = ['main', 'agents', 'effort', 'permissions'].filter((name) => parsed[name]);
  if (parsed.reset && writeOptions.length > 0) {
    throw new Error('--reset cannot be combined with configuration values');
  }
  if (parsed.json && (parsed.reset || writeOptions.length > 0)) {
    throw new Error('--json cannot be combined with configuration changes');
  }

  if (!parsed.reset && writeOptions.length === 0) {
    const summary = effectiveConfigurationSummary();
    if (parsed.json) {
      writeLine(stdout, JSON.stringify(summary, null, 2));
      return;
    }
    for (const line of configurationLines(summary)) {
      writeLine(stdout, line);
    }
    return;
  }

  const updates = {};
  const removals = new Set();
  if (parsed.reset) {
    for (const key of MANAGED_CONFIG_KEYS) {
      removals.add(key);
    }
  } else {
    const current = parsed.agents ? effectiveConfigurationSummary() : null;
    if (parsed.main) {
      updates.ULTRATHINK_GATEWAY_MAIN_MODEL_ID =
        parsed.main.trim().toLowerCase() === 'fable'
          ? DEFAULT_MAIN_MODEL_ID
          : normalizeModel(parsed.main, '--main');
      updates.ULTRATHINK_GATEWAY_MAIN_PROVIDER = 'anthropic';
      for (const key of [
        'CLAUDE_WORKFLOW_MAIN_PROVIDER',
        'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL',
        'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT',
      ]) {
        removals.add(key);
      }
    }
    if (parsed.agents) {
      const model = agentModel(parsed.agents, current.agents.model);
      updates.ULTRATHINK_GATEWAY_CODEX_MODEL = model;
      updates.ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL = model;
      removals.add('CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID');
    }
    if (parsed.effort) {
      const effort = parsed.effort.toLowerCase();
      if (!REASONING_EFFORTS.has(effort)) {
        throw new Error(`unsupported reasoning effort ${parsed.effort}`);
      }
      updates.ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT = effort;
      updates.ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT = effort;
    }
    if (parsed.permissions) {
      const permissions = parsed.permissions.toLowerCase();
      if (!PERMISSION_MODES.has(permissions)) {
        throw new Error('--permissions must be bypass or prompt');
      }
      updates.CLAUDE_WORKFLOW_SKIP_PERMISSIONS =
        permissions === 'bypass' ? 'true' : 'false';
    }
  }

  const result = writeUserConfiguration(configurationPath(), updates, [...removals]);
  writeLine(stdout, `${result.changed ? 'Saved' : 'Already current'}: ${result.path}`);
  if (parsed.reset) {
    writeLine(
      stdout,
      'Managed settings were removed. Package defaults apply unless parent or legacy configuration overrides them.'
    );
  } else {
    for (const name of writeOptions) {
      const value = parsed[name];
      writeLine(stdout, `${name[0].toUpperCase()}${name.slice(1)}: ${value}`);
    }
    writeLine(stdout, 'These settings apply to new commands. Exported environment variables take precedence.');
    writeLine(stdout, 'Custom route-map entries can override the common agent settings.');
    writeLine(stdout, 'Shared mode picks up changes in a new shell or after `claude-workflow-gateway restart`.');
  }
}

function diagnosticReport(options = {}) {
  const env = options.env || process.env;
  return withProcessEnvironment(env, function buildDiagnosticReport() {
    let routeCheck;
    try {
      const summary = effectiveConfigurationSummary(process.env);
      routeCheck = {
        ok: true,
        label: `Routing ${summary.main.name} main; ${summary.agents.name}/${summary.agents.effort} agents`,
      };
    } catch (error) {
      routeCheck = {
        ok: false,
        label: 'Routing configuration',
        detail: error.message,
      };
    }

    let codexCommand = 'codex';
    try {
      codexCommand = buildWorkflowGatewayConfig().config.codex.command;
    } catch {
      // The routing check above reports invalid configuration. Use the default
      // command so the remaining diagnostics still provide useful information.
    }
    const run = options.run || commandResult;
    const checks = [
      platformCheck(env, codexCommand),
      nodeCheck(),
      claudeCheck(run, env),
      codexCheck(codexCommand, run, env),
      routeCheck,
    ];
    return { checks, ok: checks.every((check) => check.ok) };
  });
}

function printDiagnosticReport(report, stdout) {
  for (const check of report.checks) {
    writeLine(stdout, `[${check.ok ? 'ok' : 'error'}] ${check.label}`);
    if (check.detail) {
      writeLine(stdout, `        ${check.detail}`);
    }
  }
}

function setupUsage() {
  return [
    'Usage:',
    '  claude-workflow setup',
    '  claude-workflow setup --shared',
    '',
    'Checks Node.js, Claude Code, Codex, authentication, platform paths, and routing.',
    'Without --shared, setup is read-only and creates no configuration file.',
    '',
    'Options:',
    '  --shared  Start the shared gateway and install its zsh/Bash hook',
    '  --json    Print diagnostics as JSON (cannot be combined with --shared)',
    '  --help, -h Show this help',
  ].join('\n');
}

function runGatewayAction(action, options = {}) {
  const result = spawnSync('bash', [GATEWAY_MANAGER, action], {
    cwd: process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.stdout) {
    (options.stdout || process.stdout).write(result.stdout);
  }
  if (result.stderr) {
    (options.stderr || process.stderr).write(result.stderr);
  }
  if (result.status !== 0 || result.error) {
    throw new Error(`shared gateway ${action} failed: ${commandFailure(result)}`);
  }
}

function managerPathSetting(env, name) {
  const value = String(env[name] || '').trim();
  if (value && !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return value;
}

function nearestExistingDirectory(value) {
  let candidate = path.resolve(value);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }
  if (!fs.lstatSync(candidate).isDirectory()) {
    throw new Error(`shared shell rc parent is not a directory: ${candidate}`);
  }
  return candidate;
}

function resolveThroughExistingAncestor(value, visited = new Set()) {
  const absolute = path.resolve(value);
  if (visited.has(absolute) || visited.size >= 40) {
    throw new Error(`path contains a symlink cycle: ${value}`);
  }
  visited.add(absolute);
  const parsed = path.parse(absolute);
  const parts = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let candidate = parsed.root;

  for (let index = 0; index < parts.length; index += 1) {
    candidate = path.join(candidate, parts[index]);
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return path.join(candidate, ...parts.slice(index + 1));
      }
      if (error?.code === 'ENOTDIR') {
        throw new Error(`path has a non-directory ancestor: ${candidate}`);
      }
      throw error;
    }

    if (!stats.isSymbolicLink()) {
      continue;
    }
    const linkTarget = fs.readlinkSync(candidate);
    const resolvedTarget = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(path.dirname(candidate), linkTarget);
    return resolveThroughExistingAncestor(
      path.join(resolvedTarget, ...parts.slice(index + 1)),
      visited
    );
  }

  return candidate;
}

function sharedShellHookPath(env) {
  const customPath = managerPathSetting(env, 'CLAUDE_WORKFLOW_SHELL_RC');
  if (customPath) {
    return customPath;
  }

  const shellName = path.basename(String(env.SHELL || ''));
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (shellName === 'bash') {
    return path.join(home, '.bashrc');
  }
  if (shellName === 'zsh') {
    const zDotDirectory = String(env.ZDOTDIR || home);
    if (!path.isAbsolute(zDotDirectory)) {
      throw new Error('ZDOTDIR must be an absolute path for shared setup');
    }
    return path.join(zDotDirectory, '.zshrc');
  }
  throw new Error(
    `shared setup does not support shell ${shellName || 'unknown'}; ` +
      'set CLAUDE_WORKFLOW_SHELL_RC to an absolute zsh or Bash rc path'
  );
}

function validateSharedSetup(env = process.env) {
  if (!findExecutable('bash', env)) {
    throw new Error('shared setup requires bash on PATH');
  }
  fs.accessSync(GATEWAY_MANAGER, fs.constants.R_OK);

  managerPathSetting(env, 'CLAUDE_WORKFLOW_GATEWAY_STATE_DIR');
  managerPathSetting(env, 'CLAUDE_WORKFLOW_GATEWAY_ENV_FILE');
  const traceDirectory = String(env.ULTRATHINK_GATEWAY_TRACE_DIR || '').trim();
  if (
    traceDirectory &&
    !new Set(['0', 'false', 'no', 'off']).has(traceDirectory.toLowerCase()) &&
    !path.isAbsolute(traceDirectory)
  ) {
    throw new Error('ULTRATHINK_GATEWAY_TRACE_DIR must be absolute or disabled');
  }

  const hookPath = resolveThroughExistingAncestor(sharedShellHookPath(env));
  let hookStats = null;
  try {
    hookStats = fs.lstatSync(hookPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  if (hookStats) {
    const stats = hookStats;
    if (!stats.isFile()) {
      throw new Error(`shared shell rc must be a regular file: ${hookPath}`);
    }
    fs.accessSync(hookPath, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(path.dirname(hookPath), fs.constants.W_OK | fs.constants.X_OK);
  } else {
    fs.accessSync(
      nearestExistingDirectory(path.dirname(hookPath)),
      fs.constants.W_OK | fs.constants.X_OK
    );
  }

  if (isWsl(env)) {
    for (const [label, candidate] of [
      ['Claude Workflow installation', GATEWAY_MANAGER],
      ['Shared shell rc', hookPath],
      ['Shared gateway state', env.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR || ''],
      ['Shared gateway env file', env.CLAUDE_WORKFLOW_GATEWAY_ENV_FILE || ''],
      ['Shared gateway trace directory', traceDirectory],
    ]) {
      if (candidate && isWindowsMountedPath(resolveThroughExistingAncestor(candidate))) {
        throw new Error(`${label} must use the WSL Linux filesystem, not ${candidate}`);
      }
    }
  }
}

export function runSetupCommand(args, options = {}) {
  const stdout = options.stdout || process.stdout;
  const parsed = parseNamedOptions(
    args,
    new Map([
      ['shared', false],
      ['json', false],
      ['help', false],
    ])
  );
  if (parsed.help) {
    writeLine(stdout, setupUsage());
    return;
  }
  if (parsed.shared && parsed.json) {
    throw new Error('--json cannot be combined with --shared');
  }

  const report = diagnosticReport(options);
  if (parsed.json) {
    writeLine(stdout, JSON.stringify(report, null, 2));
  } else {
    writeLine(stdout, 'Claude Workflow setup');
    writeLine(stdout);
    printDiagnosticReport(report, stdout);
  }
  if (!report.ok) {
    throw new Error('setup checks failed; resolve the errors above and run setup again');
  }

  if (parsed.shared) {
    const gatewayAction = options.runGatewayAction || runGatewayAction;
    validateSharedSetup(options.env || process.env);
    gatewayAction('start', options);
    try {
      gatewayAction('install-shell', options);
    } catch (error) {
      throw new Error(
        `${error.message}. The gateway may still be running; use ` +
          '`claude-workflow-gateway stop` if you do not want it left active.'
      );
    }
    writeLine(stdout, 'Shared gateway enabled. Open a new shell before using plain `claude` commands.');
  } else if (!parsed.json) {
    writeLine(stdout);
    writeLine(stdout, 'Ready. Run `claude-workflow` in a trusted repository.');
    writeLine(stdout, 'Optional: use `claude-workflow config` to inspect or change defaults.');
  }
}

export function runDoctorCommand(args, options = {}) {
  const stdout = options.stdout || process.stdout;
  const parsed = parseNamedOptions(
    args,
    new Map([
      ['json', false],
      ['help', false],
    ])
  );
  if (parsed.help) {
    writeLine(
      stdout,
      'Usage: claude-workflow doctor [--json]\n\nRe-runs the read-only prerequisite and routing checks.\n\nOptions:\n  --json     Print diagnostics as JSON\n  --help, -h Show this help'
    );
    return;
  }

  const report = diagnosticReport(options);
  if (parsed.json) {
    writeLine(stdout, JSON.stringify(report, null, 2));
  } else {
    writeLine(stdout, 'Claude Workflow doctor');
    writeLine(stdout);
    printDiagnosticReport(report, stdout);
  }
  if (!report.ok) {
    throw new Error('diagnostics failed');
  }
}
