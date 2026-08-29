import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeWorkflowEnvironmentFile } from '../js/cli/claude-workflow-daemon.js';
import {
  MANAGED_STATE_OWNER_BASENAME,
  claimManagedState,
} from '../js/cli/claude-workflow-managed-state.js';

const DAEMON_SCRIPT = path.resolve('scripts/claude-workflow-daemon.sh');
const ENV_BASENAME = 'claude-workflow-gateway.env';
const PID_BASENAME = 'claude-workflow-gateway.pid';
const REVISION_BASENAME = 'claude-workflow-gateway.revision';
const POSIX_ONLY = { skip: process.platform === 'win32' };
const MANAGED_STATE_HELPER = fileURLToPath(
  new URL('../js/cli/claude-workflow-managed-state.js', import.meta.url)
);

function runManager(action, env) {
  const result = spawnSync('/bin/bash', [DAEMON_SCRIPT, action], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

async function temporaryRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async function cleanup() {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('arbitrary env paths and alias collisions are rejected without mutation', POSIX_ONLY, async function (t) {
  const root = await temporaryRoot(t, 'claude-workflow-managed-paths-');
  const stateDirectory = path.join(root, 'state');
  const externalSentinel = path.join(root, 'external.env');
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  await fs.writeFile(externalSentinel, 'external-sentinel\n', { mode: 0o644 });

  assert.throws(
    () => writeWorkflowEnvironmentFile(externalSentinel, { VALUE: 'unsafe' }),
    /must be exactly/u
  );
  assert.equal(await fs.readFile(externalSentinel, 'utf8'), 'external-sentinel\n');
  assert.equal((await fs.stat(externalSentinel)).mode & 0o777, 0o644);

  const externalStop = runManager('stop', {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: externalSentinel,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDirectory,
  });
  assert.equal(externalStop.status, 1);
  assert.match(externalStop.stderr, /must be exactly/u);
  assert.equal(await fs.readFile(externalSentinel, 'utf8'), 'external-sentinel\n');

  const revisionSentinel = path.join(stateDirectory, REVISION_BASENAME);
  await fs.writeFile(revisionSentinel, 'revision-sentinel\n', { mode: 0o600 });
  const reservedAlias = runManager('stop', {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: revisionSentinel,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDirectory,
  });
  assert.equal(reservedAlias.status, 1);
  assert.match(reservedAlias.stderr, /must be exactly/u);
  assert.equal(await fs.readFile(revisionSentinel, 'utf8'), 'revision-sentinel\n');

  const aliasedState = `${stateDirectory}/../state`;
  const normalizedAlias = runManager('stop', {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: `${aliasedState}/${ENV_BASENAME}`,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: aliasedState,
  });
  assert.equal(normalizedAlias.status, 1);
  assert.equal(await fs.readFile(revisionSentinel, 'utf8'), 'revision-sentinel\n');
});

test('derived XDG state paths normalize trailing slashes', POSIX_ONLY, async function (t) {
  const root = await temporaryRoot(t, 'claude-workflow-xdg-trailing-slash-');
  const home = path.join(root, 'home');
  const stateHome = path.join(root, 'state-home');
  await fs.mkdir(home);
  await fs.mkdir(stateHome);
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: `${stateHome}/`,
  };
  delete env.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR;
  delete env.CLAUDE_WORKFLOW_GATEWAY_ENV_FILE;
  const reconciled = runManager('reconcile', env);
  assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
  assert.match(reconciled.stdout, /no running owned daemon to reconcile/u);
  assert.doesNotMatch(reconciled.stderr, /must be normalized/u);
});

test('unowned custom collisions are refused without chmod or deletion', POSIX_ONLY, async function (t) {
  const root = await temporaryRoot(t, 'claude-workflow-custom-collision-');
  for (const mode of [0o755, 0o700]) {
    const stateDirectory = path.join(root, `state-${mode.toString(8)}`);
    const envFile = path.join(stateDirectory, ENV_BASENAME);
    const pidFile = path.join(stateDirectory, PID_BASENAME);
    const revisionFile = path.join(stateDirectory, REVISION_BASENAME);
    await fs.mkdir(stateDirectory, { mode });
    await fs.chmod(stateDirectory, mode);
    await fs.writeFile(envFile, 'env-sentinel\n', { mode: 0o600 });
    await fs.writeFile(pidFile, 'pid-sentinel\n', { mode: 0o600 });
    await fs.writeFile(revisionFile, 'revision-sentinel\n', { mode: 0o600 });

    const stopped = runManager('stop', {
      ...process.env,
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDirectory,
    });
    assert.equal(stopped.status, 1);
    assert.equal((await fs.stat(stateDirectory)).mode & 0o777, mode);
    assert.equal(await fs.readFile(envFile, 'utf8'), 'env-sentinel\n');
    assert.equal(await fs.readFile(pidFile, 'utf8'), 'pid-sentinel\n');
    assert.equal(await fs.readFile(revisionFile, 'utf8'), 'revision-sentinel\n');
  }
});

test('claimed custom state supports atomic publication and verified stop cleanup', POSIX_ONLY, async function (t) {
  const root = await temporaryRoot(t, 'claude-workflow-claimed-state-');
  const stateDirectory = path.join(root, 'state');
  const envFile = path.join(stateDirectory, ENV_BASENAME);
  const pidFile = path.join(stateDirectory, PID_BASENAME);
  const revisionFile = path.join(stateDirectory, REVISION_BASENAME);

  await fs.mkdir(stateDirectory, { mode: 0o700 });
  writeWorkflowEnvironmentFile(envFile, { VALUE: 'first' });
  writeWorkflowEnvironmentFile(envFile, { VALUE: 'second' });
  await fs.writeFile(pidFile, 'not-a-daemon\n', { mode: 0o600 });
  await fs.writeFile(revisionFile, 'managed-revision\n', { mode: 0o600 });

  const stopped = runManager('stop', {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDirectory,
  });
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.match(stopped.stdout, /not running/u);
  await assert.rejects(fs.access(envFile));
  await assert.rejects(fs.access(pidFile));
  await assert.rejects(fs.access(revisionFile));
  assert.equal(
    await fs.readFile(path.join(stateDirectory, MANAGED_STATE_OWNER_BASENAME), 'utf8'),
    'claude-workflow-gateway managed state v1\n'
  );
  assert.equal((await fs.stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(stateDirectory, MANAGED_STATE_OWNER_BASENAME))).mode &
      0o777,
    0o600
  );
});

test('concurrent custom-state claims publish one complete ownership marker', POSIX_ONLY, async function (t) {
  const root = await temporaryRoot(t, 'claude-workflow-concurrent-claim-');
  const stateDirectory = path.join(root, 'state');
  await fs.mkdir(stateDirectory, { mode: 0o700 });

  const claims = Array.from({ length: 8 }, () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        MANAGED_STATE_HELPER,
        'claim',
        stateDirectory,
        'custom',
      ]);
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stderr }));
    })
  );
  const results = await Promise.all(claims);
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(
    await fs.readFile(path.join(stateDirectory, MANAGED_STATE_OWNER_BASENAME), 'utf8'),
    'claude-workflow-gateway managed state v1\n'
  );
  assert.deepEqual(
    (await fs.readdir(stateDirectory)).sort(),
    [MANAGED_STATE_OWNER_BASENAME]
  );
});

test('a claim revalidates ownership published after its initial missing-marker check', POSIX_ONLY, async function (t) {
  const root = await temporaryRoot(t, 'claude-workflow-interleaved-claim-');
  const stateDirectory = path.join(root, 'state');
  const marker = path.join(stateDirectory, MANAGED_STATE_OWNER_BASENAME);
  await fs.mkdir(stateDirectory, { mode: 0o700 });

  const originalLstatSync = fsSync.lstatSync;
  let publishedDuringMissingCheck = false;
  fsSync.lstatSync = function lstatSyncWithInterleavedPublication(target, ...args) {
    try {
      return originalLstatSync.call(fsSync, target, ...args);
    } catch (error) {
      if (
        !publishedDuringMissingCheck &&
        target === marker &&
        error?.code === 'ENOENT'
      ) {
        fsSync.writeFileSync(
          marker,
          'claude-workflow-gateway managed state v1\n',
          { flag: 'wx', mode: 0o600 }
        );
        publishedDuringMissingCheck = true;
      }
      throw error;
    }
  };

  try {
    assert.equal(
      claimManagedState(stateDirectory, { kind: 'custom' }),
      stateDirectory
    );
  } finally {
    fsSync.lstatSync = originalLstatSync;
  }

  assert.equal(publishedDuringMissingCheck, true);
  assert.equal(
    await fs.readFile(marker, 'utf8'),
    'claude-workflow-gateway managed state v1\n'
  );
});

for (const stateKind of ['canonical', 'legacy']) {
  test(`prior-version ${stateKind} state migrates only after validation`, POSIX_ONLY, async function (t) {
    const root = await temporaryRoot(t, `claude-workflow-${stateKind}-migration-`);
    const home = path.join(root, 'home');
    const stateDirectory =
      stateKind === 'canonical'
        ? path.join(home, '.cache', 'claude-workflow')
        : path.join(home, '.cache', 'ultrathink');
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(stateDirectory, 0o700);
    await fs.writeFile(
      path.join(stateDirectory, ENV_BASENAME),
      stateKind === 'canonical'
        ? "export ANTHROPIC_BASE_URL='http://127.0.0.1:4318'\n" +
            "export CLAUDE_CODE_SUBAGENT_MODEL='codex-terra'\n" +
            "export ANTHROPIC_DEFAULT_SONNET_MODEL='codex-terra'\n" +
            "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY='0'\n"
        : '_claude_workflow_gateway_restore_environment() { :; }\n' +
            "export ANTHROPIC_BASE_URL='http://127.0.0.1:4318'\n",
      { mode: 0o600 }
    );
    await fs.writeFile(path.join(stateDirectory, PID_BASENAME), '987654321\n', {
      mode: 0o600,
    });
    await fs.writeFile(
      path.join(stateDirectory, REVISION_BASENAME),
      `${'a'.repeat(64)}\n`,
      { mode: 0o600 }
    );
    await fs.writeFile(
      path.join(stateDirectory, 'claude-workflow-gateway.log'),
      'claude-workflow-gateway: legacy log\n',
      { mode: 0o600 }
    );
    const traceDirectory = path.join(stateDirectory, 'gateway-trace');
    const traceLockDirectory = path.join(traceDirectory, '.gateway-trace.lock');
    await fs.mkdir(traceLockDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(traceDirectory, 0o700);
    await fs.chmod(traceLockDirectory, 0o700);

    const env = { ...process.env, HOME: home };
    delete env.XDG_STATE_HOME;
    delete env.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR;
    delete env.CLAUDE_WORKFLOW_GATEWAY_ENV_FILE;
    const stopped = runManager('stop', env);
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.match(stopped.stdout, /not running/u);
    assert.equal(
      await fs.readFile(path.join(stateDirectory, MANAGED_STATE_OWNER_BASENAME), 'utf8'),
      'claude-workflow-gateway managed state v1\n'
    );
    assert.equal(
      await fs.readFile(path.join(stateDirectory, 'claude-workflow-gateway.log'), 'utf8'),
      'claude-workflow-gateway: legacy log\n'
    );
    assert.equal((await fs.stat(traceLockDirectory)).isDirectory(), true);
    await assert.rejects(fs.access(path.join(stateDirectory, ENV_BASENAME)));
    await assert.rejects(fs.access(path.join(stateDirectory, PID_BASENAME)));
    await assert.rejects(fs.access(path.join(stateDirectory, REVISION_BASENAME)));
  });
}

test('canonical migration refuses unknown collisions', POSIX_ONLY, async function (t) {
  const root = await temporaryRoot(t, 'claude-workflow-canonical-collision-');
  const home = path.join(root, 'home');
  const stateDirectory = path.join(home, '.cache', 'claude-workflow');
  const sentinel = path.join(stateDirectory, 'user-sentinel');
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  await fs.writeFile(sentinel, 'keep\n', { mode: 0o600 });

  const env = { ...process.env, HOME: home };
  delete env.XDG_STATE_HOME;
  delete env.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR;
  delete env.CLAUDE_WORKFLOW_GATEWAY_ENV_FILE;
  const stopped = runManager('stop', env);
  assert.equal(stopped.status, 1);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep\n');
  await assert.rejects(
    fs.access(path.join(stateDirectory, MANAGED_STATE_OWNER_BASENAME))
  );

  await fs.unlink(sentinel);
  const fixedNameCollision = path.join(stateDirectory, ENV_BASENAME);
  await fs.writeFile(fixedNameCollision, 'user-owned env collision\n', { mode: 0o600 });
  const fixedNameStop = runManager('stop', env);
  assert.equal(fixedNameStop.status, 1);
  assert.equal(
    await fs.readFile(fixedNameCollision, 'utf8'),
    'user-owned env collision\n'
  );
  await assert.rejects(
    fs.access(path.join(stateDirectory, MANAGED_STATE_OWNER_BASENAME))
  );
});

test('unverified fallback lock directories are never recursively removed', POSIX_ONLY, async function (t) {
  const root = await temporaryRoot(t, 'claude-workflow-lock-collision-');
  const stateDirectory = path.join(root, 'state');
  const lockDirectory = path.join(
    stateDirectory,
    'claude-workflow-gateway.start.lock.d'
  );
  const nestedSentinel = path.join(lockDirectory, 'nested', 'sentinel');
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  claimManagedState(stateDirectory, { kind: 'custom' });
  await fs.mkdir(path.dirname(nestedSentinel), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(lockDirectory, 'pid'), '987654321\n', { mode: 0o600 });
  await fs.writeFile(nestedSentinel, 'keep\n', { mode: 0o600 });

  const toolPath = path.join(root, 'tool-path');
  await fs.mkdir(toolPath, { mode: 0o700 });
  for (const [name, target] of [
    ['node', process.execPath],
    ['dirname', '/usr/bin/dirname'],
    ['tr', '/usr/bin/tr'],
  ]) {
    await fs.symlink(target, path.join(toolPath, name));
  }

  const started = runManager('start', {
    ...process.env,
    PATH: toolPath,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDirectory,
    ULTRATHINK_GATEWAY_DAEMON_PORT: '4319',
  });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /not a verified managed lock/u);
  assert.equal(await fs.readFile(nestedSentinel, 'utf8'), 'keep\n');
});
