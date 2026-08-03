#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MANAGED_STATE_OWNER_BASENAME = '.claude-workflow-gateway.owner';
export const MANAGED_ENV_BASENAME = 'claude-workflow-gateway.env';

const OWNER_CONTENT = 'claude-workflow-gateway managed state v1\n';
const REGULAR_ARTIFACTS = new Set([
  MANAGED_ENV_BASENAME,
  'claude-workflow-gateway.pid',
  'claude-workflow-gateway.revision',
  'claude-workflow-gateway.start.lock',
  'claude-workflow-gateway.log',
]);
const REMOVABLE_ARTIFACTS = new Set([
  MANAGED_ENV_BASENAME,
  'claude-workflow-gateway.pid',
  'claude-workflow-gateway.revision',
]);
const LOCK_DIRECTORY_BASENAME = 'claude-workflow-gateway.start.lock.d';
const TRACE_DIRECTORY_BASENAME = 'gateway-trace';
const STATE_KINDS = new Set(['canonical', 'legacy', 'custom']);
const LEGACY_ENV_EXPORT_VALUES = new Map([
  ['ANTHROPIC_BASE_URL', new Set(['http://127.0.0.1:4318'])],
  ['ANTHROPIC_MODEL', new Set(['codex', 'claude-fable-5[1m]'])],
  ['ANTHROPIC_DEFAULT_FABLE_MODEL', new Set(['claude-fable-5[1m]'])],
  ['CLAUDE_CODE_SUBAGENT_MODEL', new Set(['codex-terra'])],
  ['ANTHROPIC_DEFAULT_SONNET_MODEL', new Set(['codex-terra'])],
  ['ANTHROPIC_DEFAULT_HAIKU_MODEL', new Set(['codex-terra'])],
  ['ANTHROPIC_DEFAULT_OPUS_MODEL', new Set(['codex-terra'])],
  ['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', new Set(['0'])],
]);

function fail(message) {
  throw new Error(`claude-workflow-gateway: ${message}`);
}

function assertNormalizedAbsolutePath(value, label) {
  if (!path.isAbsolute(value)) {
    fail(`${label} must be an absolute path: ${value}`);
  }
  if (path.resolve(value) !== value) {
    fail(`${label} must be normalized without aliases such as "." or "..": ${value}`);
  }
}

function assertOwnedByCurrentUser(stats, label) {
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user`);
  }
}

function assertPrivate(stats, label) {
  if ((stats.mode & 0o077) !== 0) {
    fail(
      `${label} must not be accessible by group or other users. ` +
        'On WSL, use the Linux filesystem or enable DrvFS metadata.'
    );
  }
}

function lstatRequired(target, label) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`${label} does not exist: ${target}`);
    }
    throw error;
  }
  return stats;
}

function assertRealPrivateDirectory(target, label) {
  const stats = lstatRequired(target, label);
  if (stats.isSymbolicLink()) {
    fail(`${label} must not be a symlink: ${target}`);
  }
  if (!stats.isDirectory()) {
    fail(`${label} must be a real directory: ${target}`);
  }
  assertOwnedByCurrentUser(stats, label);
  assertPrivate(stats, label);
  return stats;
}

function assertPrivateRegularFile(target, label) {
  const stats = lstatRequired(target, label);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail(`${label} must be a regular file: ${target}`);
  }
  assertOwnedByCurrentUser(stats, label);
  assertPrivate(stats, label);
  return stats;
}

function ownerPath(stateDirectory) {
  return path.join(stateDirectory, MANAGED_STATE_OWNER_BASENAME);
}

export function validateManagedStatePaths(stateDirectory, environmentFile) {
  assertNormalizedAbsolutePath(stateDirectory, 'managed state directory');
  assertNormalizedAbsolutePath(environmentFile, 'CLAUDE_WORKFLOW_GATEWAY_ENV_FILE');
  const expectedEnvironmentFile = path.join(stateDirectory, MANAGED_ENV_BASENAME);
  if (environmentFile !== expectedEnvironmentFile) {
    fail(
      `CLAUDE_WORKFLOW_GATEWAY_ENV_FILE must be exactly ${expectedEnvironmentFile} ` +
        '(inside the managed state directory)'
    );
  }
  return {
    environmentFile,
    stateDirectory,
  };
}

export function verifyManagedState(stateDirectory) {
  assertNormalizedAbsolutePath(stateDirectory, 'managed state directory');
  assertRealPrivateDirectory(stateDirectory, 'managed state directory');
  const marker = ownerPath(stateDirectory);
  assertPrivateRegularFile(marker, 'managed state ownership marker');
  const content = fs.readFileSync(marker, 'utf8');
  if (content !== OWNER_CONTENT) {
    fail(`managed state ownership marker is not recognized: ${marker}`);
  }
  return stateDirectory;
}

function validateLockDirectoryForMigration(lockDirectory) {
  assertRealPrivateDirectory(lockDirectory, 'legacy start lock directory');
  const entries = fs.readdirSync(lockDirectory);
  if (entries.length > 1 || (entries.length === 1 && entries[0] !== 'pid')) {
    fail(`legacy start lock directory contains unrecognized entries: ${lockDirectory}`);
  }
  if (entries.length === 1) {
    const pidPath = path.join(lockDirectory, 'pid');
    assertPrivateRegularFile(pidPath, 'legacy start lock pid');
    if (!/^[1-9][0-9]*\n?$/u.test(fs.readFileSync(pidPath, 'utf8'))) {
      fail(`legacy start lock pid is invalid: ${pidPath}`);
    }
  }
}

function validateTraceDirectoryForMigration(traceDirectory) {
  assertRealPrivateDirectory(traceDirectory, 'legacy trace directory');
  const entries = fs.readdirSync(traceDirectory);
  if (entries.length > 64) {
    fail(`legacy trace directory contains too many entries to migrate safely: ${traceDirectory}`);
  }
  for (const entry of entries) {
    if (entry === '.gateway-trace.lock') {
      const lockDirectory = path.join(traceDirectory, entry);
      assertRealPrivateDirectory(lockDirectory, 'legacy trace lock directory');
      if (fs.readdirSync(lockDirectory).length !== 0) {
        fail(`legacy trace lock directory is not empty: ${lockDirectory}`);
      }
      continue;
    }
    if (!/^gateway-trace\.jsonl(?:\.[1-9][0-9]*)?$/u.test(entry)) {
      fail(`legacy trace directory contains an unrecognized entry: ${entry}`);
    }
    assertPrivateRegularFile(
      path.join(traceDirectory, entry),
      `legacy trace artifact ${entry}`
    );
    const tracePath = path.join(traceDirectory, entry);
    const traceStats = fs.statSync(tracePath);
    if (traceStats.size > 0) {
      const descriptor = fs.openSync(tracePath, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(traceStats.size, 4096));
        fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        if (!buffer.toString('utf8').trimStart().startsWith('{')) {
          fail(`legacy trace artifact has no gateway JSON signature: ${tracePath}`);
        }
      } finally {
        fs.closeSync(descriptor);
      }
    }
  }
}

function validateMigrationRegularArtifact(target, entry) {
  const stats = assertPrivateRegularFile(target, `legacy managed artifact ${entry}`);
  if (entry === 'claude-workflow-gateway.start.lock') {
    if (stats.size !== 0) {
      fail(`legacy flock artifact must be empty: ${target}`);
    }
    return;
  }
  if (entry === 'claude-workflow-gateway.log') {
    if (stats.size === 0) {
      return;
    }
    const descriptor = fs.openSync(target, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stats.size, 256));
      fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (!buffer.toString('utf8').startsWith('claude-workflow-gateway:')) {
        fail(`legacy daemon log has no managed gateway signature: ${target}`);
      }
    } finally {
      fs.closeSync(descriptor);
    }
    return;
  }
  if (stats.size > 1024 * 1024) {
    fail(`legacy managed artifact is unexpectedly large: ${target}`);
  }
  const content = fs.readFileSync(target, 'utf8');
  switch (entry) {
    case 'claude-workflow-gateway.pid':
      if (!/^[1-9][0-9]*\n?$/u.test(content)) {
        fail(`legacy daemon pid is invalid: ${target}`);
      }
      break;
    case 'claude-workflow-gateway.revision':
      if (!/^[a-f0-9]{64}\n?$/u.test(content)) {
        fail(`legacy daemon revision is invalid: ${target}`);
      }
      break;
    case MANAGED_ENV_BASENAME:
      validateLegacyEnvironmentArtifact(content, target);
      break;
    default:
      break;
  }
}

function validateLegacyEnvironmentArtifact(content, target) {
  if (
    content.includes('_claude_workflow_gateway_restore_environment') &&
    content.includes('ANTHROPIC_BASE_URL')
  ) {
    return;
  }

  const lines = content.trim().split(/\r?\n/u);
  const exported = new Map();
  for (const line of lines) {
    const match = line.match(/^export ([A-Z][A-Z0-9_]*)='([^']*)'$/u);
    const allowedValues = match ? LEGACY_ENV_EXPORT_VALUES.get(match[1]) : null;
    if (!match || !allowedValues?.has(match[2]) || exported.has(match[1])) {
      fail(`legacy workflow environment has no recognized managed signature: ${target}`);
    }
    exported.set(match[1], match[2]);
  }
  if (
    exported.get('ANTHROPIC_BASE_URL') !== 'http://127.0.0.1:4318' ||
    ![
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ].some((name) => exported.get(name) === 'codex-terra')
  ) {
    fail(`legacy workflow environment has no recognized managed signature: ${target}`);
  }
}

function validateMigrationContents(stateDirectory) {
  const entries = fs.readdirSync(stateDirectory);
  if (entries.length > 16) {
    fail(`legacy managed state contains too many entries to migrate safely: ${stateDirectory}`);
  }
  for (const entry of entries) {
    if (entry === MANAGED_STATE_OWNER_BASENAME) {
      continue;
    }
    const target = path.join(stateDirectory, entry);
    if (REGULAR_ARTIFACTS.has(entry)) {
      validateMigrationRegularArtifact(target, entry);
      continue;
    }
    if (entry === LOCK_DIRECTORY_BASENAME) {
      validateLockDirectoryForMigration(target);
      continue;
    }
    if (entry === TRACE_DIRECTORY_BASENAME) {
      validateTraceDirectoryForMigration(target);
      continue;
    }
    fail(`unowned state directory contains an unrecognized entry: ${target}`);
  }
}

function createOwnershipMarker(stateDirectory) {
  const marker = ownerPath(stateDirectory);
  const tempMarker = path.join(
    path.dirname(stateDirectory),
    `.${MANAGED_STATE_OWNER_BASENAME}.${process.pid}.${crypto
      .randomBytes(8)
      .toString('hex')}.tmp`
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempMarker, 'wx', 0o600);
    fs.writeFileSync(descriptor, OWNER_CONTENT, 'utf8');
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(tempMarker, marker);
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }
    fs.unlinkSync(tempMarker);
    try {
      const directoryDescriptor = fs.openSync(stateDirectory, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {
      // Some filesystems do not support fsync on directories.
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original claim failure.
      }
    }
    try {
      fs.unlinkSync(tempMarker);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        // Preserve the original publication failure.
      }
    }
    throw error;
  }
  return verifyManagedState(stateDirectory);
}

export function claimManagedState(
  stateDirectory,
  { kind = 'custom', allowMigration = kind !== 'custom' } = {}
) {
  assertNormalizedAbsolutePath(stateDirectory, 'managed state directory');
  if (!STATE_KINDS.has(kind)) {
    fail(`unrecognized managed state kind: ${kind}`);
  }

  let created = false;
  try {
    fs.mkdirSync(stateDirectory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      if (error?.code === 'ENOENT') {
        fs.mkdirSync(path.dirname(stateDirectory), { recursive: true, mode: 0o700 });
        try {
          fs.mkdirSync(stateDirectory, { mode: 0o700 });
          created = true;
        } catch (retryError) {
          if (retryError?.code !== 'EEXIST') {
            throw retryError;
          }
        }
      } else {
        throw error;
      }
    }
  }

  const directoryStats = assertRealPrivateDirectory(
    stateDirectory,
    'managed state directory'
  );
  if (created) {
    fs.chmodSync(stateDirectory, 0o700);
    assertPrivate(fs.lstatSync(stateDirectory), 'managed state directory');
  }

  try {
    return verifyManagedState(stateDirectory);
  } catch (error) {
    if (fs.existsSync(ownerPath(stateDirectory))) {
      throw error;
    }
  }

  const entries = fs.readdirSync(stateDirectory);
  if (entries.includes(MANAGED_STATE_OWNER_BASENAME)) {
    return verifyManagedState(stateDirectory);
  }
  if (!created && kind === 'custom' && entries.length !== 0) {
    fail(
      `custom state directory is nonempty and has no ownership marker: ${stateDirectory}`
    );
  }
  if (!created && kind !== 'custom') {
    if (!allowMigration) {
      fail(`managed state ownership marker is missing: ${ownerPath(stateDirectory)}`);
    }
    validateMigrationContents(stateDirectory);
  }

  const claimed = createOwnershipMarker(stateDirectory);
  assertOwnedByCurrentUser(directoryStats, 'managed state directory');
  return claimed;
}

export function verifyOrMigrateManagedState(stateDirectory, kind) {
  if (kind === 'custom') {
    return claimManagedState(stateDirectory, { kind, allowMigration: false });
  }
  return claimManagedState(stateDirectory, { kind, allowMigration: true });
}

function managedArtifactPath(stateDirectory, basename, allowed) {
  verifyManagedState(stateDirectory);
  if (!allowed.has(basename)) {
    fail(`unrecognized managed artifact name: ${basename}`);
  }
  const target = path.join(stateDirectory, basename);
  if (path.dirname(target) !== stateDirectory) {
    fail(`managed artifact aliases are not allowed: ${basename}`);
  }
  return target;
}

export function verifyManagedArtifactForReplacement(stateDirectory, basename) {
  const target = managedArtifactPath(stateDirectory, basename, REGULAR_ARTIFACTS);
  try {
    assertPrivateRegularFile(target, `managed artifact ${basename}`);
  } catch (error) {
    if (error?.code === 'ENOENT' || / does not exist:/u.test(error?.message || '')) {
      return target;
    }
    throw error;
  }
  return target;
}

export function removeManagedArtifacts(stateDirectory, basenames) {
  verifyManagedState(stateDirectory);
  for (const basename of basenames) {
    const target = managedArtifactPath(stateDirectory, basename, REMOVABLE_ARTIFACTS);
    try {
      assertPrivateRegularFile(target, `managed artifact ${basename}`);
    } catch (error) {
      if (error?.code === 'ENOENT' || / does not exist:/u.test(error?.message || '')) {
        continue;
      }
      throw error;
    }
    fs.unlinkSync(target);
  }
}

export function readVerifiedLockPid(stateDirectory) {
  verifyManagedState(stateDirectory);
  const lockDirectory = path.join(stateDirectory, LOCK_DIRECTORY_BASENAME);
  validateLockDirectoryForMigration(lockDirectory);
  const pidPath = path.join(lockDirectory, 'pid');
  if (!fs.existsSync(pidPath)) {
    fail(`managed start lock has no pid: ${lockDirectory}`);
  }
  return Number(fs.readFileSync(pidPath, 'utf8').trim());
}

export function removeVerifiedLockDirectory(stateDirectory, expectedPid) {
  const actualPid = readVerifiedLockPid(stateDirectory);
  if (!Number.isInteger(expectedPid) || expectedPid <= 0 || actualPid !== expectedPid) {
    fail(`managed start lock pid changed; refusing removal`);
  }
  const lockDirectory = path.join(stateDirectory, LOCK_DIRECTORY_BASENAME);
  fs.unlinkSync(path.join(lockDirectory, 'pid'));
  fs.rmdirSync(lockDirectory);
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

function runCli() {
  const [command, stateDirectory, argument] = process.argv.slice(2);
  switch (command) {
    case 'validate-paths':
      validateManagedStatePaths(stateDirectory, argument);
      break;
    case 'claim':
      claimManagedState(stateDirectory, { kind: argument });
      break;
    case 'verify-or-migrate':
      verifyOrMigrateManagedState(stateDirectory, argument);
      break;
    case 'verify-replacement':
      verifyManagedArtifactForReplacement(stateDirectory, argument);
      break;
    case 'remove':
      removeManagedArtifacts(stateDirectory, process.argv.slice(4));
      break;
    case 'read-lock-pid':
      process.stdout.write(`${readVerifiedLockPid(stateDirectory)}\n`);
      break;
    case 'remove-lock':
      removeVerifiedLockDirectory(stateDirectory, Number(argument));
      break;
    default:
      fail('managed-state helper requires validate-paths, claim, verify-or-migrate, verify-replacement, remove, read-lock-pid, or remove-lock');
  }
}

if (isDirectExecution()) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
