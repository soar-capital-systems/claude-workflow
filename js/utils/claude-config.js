import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { GATEWAY_ONLY_CREDENTIAL_ENV_NAMES } from './child-env.js';

const BACKUP_SUFFIX = '.claude-workflow.bak';

export const CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BETAS',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
]);

export function buildClaudeSettingsOverrideEnvironment(extraEnv, childEnv) {
  const settingsEnv = Object.fromEntries(
    GATEWAY_ONLY_CREDENTIAL_ENV_NAMES.map((name) => [name, ''])
  );
  for (const name of CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES) {
    if (name === 'ANTHROPIC_API_KEY' || name === 'ANTHROPIC_AUTH_TOKEN') {
      if (childEnv[name]) {
        settingsEnv[name] = String(childEnv[name]);
      }
      continue;
    }
    const value = extraEnv[name];
    settingsEnv[name] = value === null || value === undefined ? '' : String(value);
  }
  settingsEnv.ANTHROPIC_SMALL_FAST_MODEL = String(
    extraEnv.CLAUDE_CODE_SUBAGENT_MODEL || ''
  );
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const value = extraEnv[name];
    if (value !== null && value !== undefined) {
      settingsEnv[name] = String(value);
    }
  }
  return settingsEnv;
}

function ownerOnlyModeIsEnforced(stats) {
  return process.platform === 'win32' || (stats.mode & 0o077) === 0;
}

function assertSafeRegularFile(target, stats) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Claude state path must be a regular file, not a symlink: ${target}`);
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`Claude state file is not owned by the current user: ${target}`);
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

function optionalFile(target) {
  try {
    const stats = fs.lstatSync(target);
    assertSafeRegularFile(target, stats);
    return { content: fs.readFileSync(target, 'utf8'), stats };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { content: '', stats: null };
    }
    throw error;
  }
}

function writePrivateAtomic(target, content, expectedStats = undefined) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });

  const current = optionalFile(target);

  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    const temporaryStats = fs.fstatSync(descriptor);
    if (!temporaryStats.isFile() || !ownerOnlyModeIsEnforced(temporaryStats)) {
      throw new Error(
        `Claude state storage does not enforce owner-only permissions: ${directory}. ` +
          'On WSL, use the Linux filesystem or enable DrvFS metadata.'
      );
    }
    fs.closeSync(descriptor);
    descriptor = null;
    const requiredStats = expectedStats === undefined ? current.stats : expectedStats;
    const latest = optionalFile(target);
    if (requiredStats === null && latest.stats !== null) {
      throw new Error(`Claude state file appeared while it was being updated: ${target}`);
    }
    if (
      requiredStats !== null &&
      (latest.stats === null || !sameFileVersion(requiredStats, latest.stats))
    ) {
      throw new Error(`Claude state file changed while it was being updated: ${target}`);
    }
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    const publishedStats = fs.lstatSync(target);
    assertSafeRegularFile(target, publishedStats);
    if (!ownerOnlyModeIsEnforced(publishedStats)) {
      throw new Error(
        `Claude state storage does not enforce owner-only permissions: ${target}. ` +
          'On WSL, use the Linux filesystem or enable DrvFS metadata.'
      );
    }
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
  }
}

export function createPrivateClaudeSettingsOverride(settingsEnv) {
  if (!settingsEnv || typeof settingsEnv !== 'object' || Array.isArray(settingsEnv)) {
    throw new Error('Claude settings override env must be an object');
  }
  for (const [name, value] of Object.entries(settingsEnv)) {
    if (typeof value !== 'string') {
      throw new Error(`Claude settings override ${name} must be a string`);
    }
  }

  const temporaryRoot = os.tmpdir();
  if (!path.isAbsolute(temporaryRoot)) {
    throw new Error(`Claude settings override directory must be absolute: ${temporaryRoot}`);
  }
  const directory = fs.mkdtempSync(
    path.join(temporaryRoot, `claude-workflow-settings-${process.pid}-`)
  );
  let cleaned = false;
  try {
    fs.chmodSync(directory, 0o700);
    const directoryStats = fs.lstatSync(directory);
    if (
      directoryStats.isSymbolicLink() ||
      !directoryStats.isDirectory() ||
      (typeof process.getuid === 'function' && directoryStats.uid !== process.getuid()) ||
      !ownerOnlyModeIsEnforced(directoryStats)
    ) {
      throw new Error(
        `Claude settings override storage does not enforce owner-only permissions: ${directory}. ` +
          'On WSL, use the Linux filesystem or set TMPDIR to a private Linux path.'
      );
    }

    const target = path.join(directory, 'settings.json');
    writePrivateAtomic(target, `${JSON.stringify({ env: settingsEnv }, null, 2)}\n`, null);
    return {
      path: target,
      cleanup() {
        if (cleaned) {
          return;
        }
        cleaned = true;
        fs.rmSync(directory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    fs.rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

function claudeHomeDirectory(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (!path.isAbsolute(home)) {
    throw new Error(`Claude home directory must be absolute: ${home}`);
  }
  return home;
}

function configuredClaudeDirectory(env = process.env) {
  const configured = String(env.CLAUDE_CONFIG_DIR || '').trim();
  if (!configured) {
    return '';
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(`CLAUDE_CONFIG_DIR must be absolute: ${configured}`);
  }
  return path.normalize(configured);
}

export function claudeUserStatePath(env = process.env) {
  const configured = configuredClaudeDirectory(env);
  return configured
    ? path.join(configured, '.claude.json')
    : path.join(claudeHomeDirectory(env), '.claude.json');
}

export function claudeUserSettingsPath(env = process.env) {
  const configured = configuredClaudeDirectory(env);
  return configured
    ? path.join(configured, 'settings.json')
    : path.join(claudeHomeDirectory(env), '.claude', 'settings.json');
}

function parseJsonObject(source, target, label) {
  let value;
  try {
    value = JSON.parse(source.content);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${target}: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object: ${target}`);
  }
  return value;
}

function settingsEnvironment(settings, target) {
  if (settings.env === undefined || settings.env === null) {
    return null;
  }
  if (typeof settings.env !== 'object' || Array.isArray(settings.env)) {
    throw new Error(`Claude settings env must contain a JSON object: ${target}`);
  }
  return settings.env;
}

function conflictingSettingsEnvironmentNames(settings, target) {
  const settingsEnv = settingsEnvironment(settings, target);
  if (!settingsEnv) {
    return [];
  }
  return CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES.filter((name) =>
    Object.hasOwn(settingsEnv, name)
  );
}

export function inspectClaudeRoutingSettingsConflicts(
  env = process.env,
  cwd = process.cwd()
) {
  const requestedRoot = path.resolve(cwd);
  let projectRoot = requestedRoot;
  for (let candidate = requestedRoot; ; candidate = path.dirname(candidate)) {
    if (fs.existsSync(path.join(candidate, '.git'))) {
      projectRoot = candidate;
      break;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
  }
  const candidates = [
    { source: 'user', path: claudeUserSettingsPath(env) },
    { source: 'project', path: path.join(projectRoot, '.claude', 'settings.json') },
    { source: 'local', path: path.join(projectRoot, '.claude', 'settings.local.json') },
  ];
  const conflicts = [];
  const visited = new Set();
  for (const candidate of candidates) {
    if (visited.has(candidate.path)) {
      continue;
    }
    visited.add(candidate.path);
    const source = optionalFile(candidate.path);
    if (!source.stats) {
      continue;
    }
    const settings = parseJsonObject(source, candidate.path, 'Claude settings file');
    const names = conflictingSettingsEnvironmentNames(settings, candidate.path);
    if (names.length > 0) {
      conflicts.push({ ...candidate, names });
    }
  }
  return conflicts;
}

function hardenExistingFile(target, stats) {
  if (!stats || ownerOnlyModeIsEnforced(stats)) {
    return false;
  }
  fs.chmodSync(target, 0o600);
  const hardenedStats = fs.lstatSync(target);
  assertSafeRegularFile(target, hardenedStats);
  if (!ownerOnlyModeIsEnforced(hardenedStats)) {
    throw new Error(
      `Claude state storage does not enforce owner-only permissions: ${target}. ` +
        'On WSL, use the Linux filesystem or enable DrvFS metadata.'
    );
  }
  return true;
}

export function inspectClaudeThirdPartyModelSupport(env = process.env) {
  const target = claudeUserStatePath(env);
  const source = optionalFile(target);
  let stateEnabled = false;
  if (source.stats) {
    const value = parseJsonObject(source, target, 'Claude state file');
    stateEnabled =
      value.hasCompletedOnboarding === true && value.penguinModeOrgEnabled === true;
  }

  const settingsPath = claudeUserSettingsPath(env);
  const settingsSource = optionalFile(settingsPath);
  let conflictingSettingsEnvNames = [];
  if (settingsSource.stats) {
    const settings = parseJsonObject(settingsSource, settingsPath, 'Claude settings file');
    conflictingSettingsEnvNames = conflictingSettingsEnvironmentNames(settings, settingsPath);
  }

  return {
    conflictingSettingsEnvNames,
    // The launcher supplies a private, higher-precedence --settings file for
    // every session. Persistent user/project settings therefore do not need
    // to be changed just to use a third-party route.
    enabled: stateEnabled,
    exists: Boolean(source.stats),
    path: target,
    settingsPath,
    stateEnabled,
  };
}

export function prepareClaudeThirdPartyModelSupport(env = process.env) {
  const target = claudeUserStatePath(env);
  const source = optionalFile(target);
  let value = {};
  if (source.stats) {
    value = parseJsonObject(source, target, 'Claude state file');
  }

  const stateChanged =
    value.hasCompletedOnboarding !== true || value.penguinModeOrgEnabled !== true;
  let backupPath = null;
  if (stateChanged && source.stats) {
    backupPath = `${target}${BACKUP_SUFFIX}`;
    writePrivateAtomic(backupPath, source.content);
  }
  if (stateChanged) {
    const next = {
      ...value,
      penguinModeOrgEnabled: true,
      hasCompletedOnboarding: true,
    };
    writePrivateAtomic(target, `${JSON.stringify(next, null, 2)}\n`, source.stats);
  } else {
    hardenExistingFile(target, source.stats);
  }

  return {
    backupPath,
    changed: stateChanged,
    conflictingSettingsEnvNames: [],
    path: target,
    settingsBackupPath: null,
    settingsChanged: false,
    settingsPath: claudeUserSettingsPath(env),
    stateChanged,
  };
}
