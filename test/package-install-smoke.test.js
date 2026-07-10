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
  process.stdout.write('Packed install and npm bin manager smoke test passed.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
