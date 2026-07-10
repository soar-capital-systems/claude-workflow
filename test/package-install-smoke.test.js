import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
  });
  if (options.expectedStatus === undefined) {
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-package-'));
try {
  const packResult = run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporaryRoot,
  ]);
  const packMetadata = JSON.parse(packResult.stdout)[0];
  const packedPaths = new Set(packMetadata.files.map(function filePath(file) {
    return file.path;
  }));
  for (const requiredPath of [
    '.env.example',
    'CHANGELOG.md',
    'SECURITY.md',
    'SUPPORT.md',
    'docs/LARGE_FILES_AND_DIFFS.md',
    'scripts/claude-workflow-daemon.sh',
  ]) {
    assert.equal(packedPaths.has(requiredPath), true, `tarball is missing ${requiredPath}`);
  }

  const consumer = path.join(temporaryRoot, 'consumer');
  const home = path.join(temporaryRoot, 'home');
  const state = path.join(temporaryRoot, 'state');
  await fs.mkdir(consumer);
  await fs.mkdir(home);
  await fs.writeFile(
    path.join(consumer, 'package.json'),
    '{"name":"claude-workflow-install-smoke","private":true}',
    'utf8'
  );
  const tarball = path.join(temporaryRoot, packMetadata.filename);
  run(
    'npm',
    [
      'install',
      '--prefer-offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball,
    ],
    { cwd: consumer }
  );

  const gatewayBin = path.join(
    consumer,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'claude-workflow-gateway.cmd' : 'claude-workflow-gateway'
  );
  const statusResult = run(gatewayBin, ['status'], {
    cwd: consumer,
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: path.join(home, '.state'),
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: state,
      ULTRATHINK_GATEWAY_DAEMON_PORT: '65534',
    },
    expectedStatus: 1,
    timeout: 5_000,
  });
  assert.equal(statusResult.status, 1, statusResult.stderr);
  assert.match(`${statusResult.stdout}\n${statusResult.stderr}`, /not running/u);

  const globalPrefix = path.join(temporaryRoot, 'global-prefix');
  const globalHome = path.join(temporaryRoot, 'global-home');
  const globalState = path.join(temporaryRoot, 'global-state');
  await fs.mkdir(globalHome);
  run('npm', [
    'install',
    '--global',
    '--install-links',
    '--prefer-offline',
    '--no-audit',
    '--no-fund',
    '--prefix',
    globalPrefix,
    ROOT,
  ]);

  if (process.platform !== 'win32') {
    const globalPackage = path.join(
      globalPrefix,
      'lib',
      'node_modules',
      'claude-workflow'
    );
    assert.equal(
      (await fs.lstat(globalPackage)).isSymbolicLink(),
      false,
      'documented global install must not depend on the source checkout'
    );
  }

  const globalBinDirectory =
    process.platform === 'win32' ? globalPrefix : path.join(globalPrefix, 'bin');
  const workflowBin = path.join(
    globalBinDirectory,
    process.platform === 'win32' ? 'claude-workflow.cmd' : 'claude-workflow'
  );
  const globalGatewayBin = path.join(
    globalBinDirectory,
    process.platform === 'win32'
      ? 'claude-workflow-gateway.cmd'
      : 'claude-workflow-gateway'
  );
  run(workflowBin, ['--help']);
  const globalStatusResult = run(globalGatewayBin, ['status'], {
    env: {
      ...process.env,
      HOME: globalHome,
      XDG_STATE_HOME: path.join(globalHome, '.state'),
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: globalState,
      ULTRATHINK_GATEWAY_DAEMON_PORT: '65533',
    },
    expectedStatus: 1,
    timeout: 5_000,
  });
  assert.equal(globalStatusResult.status, 1, globalStatusResult.stderr);
  assert.match(`${globalStatusResult.stdout}\n${globalStatusResult.stderr}`, /not running/u);

  process.stdout.write('Packed and self-contained global install smoke tests passed.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
