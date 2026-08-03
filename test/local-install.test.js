import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isDrvFsMount,
  mountForPath,
  parseMountInfo,
  unsafeWslInstallPaths,
} from '../scripts/validate-local-install.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MOUNT_INFO = [
  '21 1 0:20 / / rw,relatime - ext4 /dev/sda rw',
  '32 21 0:31 / /mnt/c rw,noatime - 9p drvfs rw,aname=drvfs;path=C:\\\\;uid=1000',
  '33 21 0:32 / /work/windows rw,noatime - drvfs D:\\\\work rw,metadata',
  '',
].join('\n');

test('WSL filesystem inspection recognizes conventional and custom DrvFS mounts', function () {
  const mounts = parseMountInfo(MOUNT_INFO);
  const conventional = mountForPath('/mnt/c/Users/example/project', mounts);
  const custom = mountForPath('/work/windows/project', mounts);
  const native = mountForPath('/home/example/project', mounts);

  assert.equal(conventional?.mountPoint, '/mnt/c');
  assert.equal(custom?.mountPoint, '/work/windows');
  assert.equal(native?.mountPoint, '/');
  assert.equal(isDrvFsMount(conventional), true);
  assert.equal(isDrvFsMount(custom), true);
  assert.equal(isDrvFsMount(native), false);
});

test('WSL local-install validation rejects project, tool, and home paths on DrvFS', function () {
  const unsafe = unsafeWslInstallPaths(
    [
      ['Project directory', '/work/windows/ultrathink'],
      ['Node.js', '/home/example/.nvm/node'],
      ['npm', '/mnt/c/Program Files/nodejs/npm'],
      ['npm global prefix', '/work/windows/npm-global'],
      ['npm cache', '/home/example/.npm'],
      ['Home directory', '/home/example'],
    ],
    MOUNT_INFO
  );

  assert.deepEqual(
    unsafe.map(({ label, mountPoint }) => [label, mountPoint]),
    [
      ['Project directory', '/work/windows'],
      ['npm', '/mnt/c'],
      ['npm global prefix', '/work/windows'],
    ]
  );
});

test('WSL local-install validation follows dependency-directory symlinks', function () {
  const root = fs.mkdtempSync('/tmp/claude-workflow-wsl-links-');
  try {
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.symlinkSync('/mnt/c/dependencies', path.join(project, 'node_modules'));
    const unsafe = unsafeWslInstallPaths(
      [['Project dependencies', path.join(project, 'node_modules')]],
      MOUNT_INFO
    );
    assert.deepEqual(
      unsafe.map(({ label, mountPoint }) => [label, mountPoint]),
      [['Project dependencies', '/mnt/c']]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const setupLocalPath = path.join(PROJECT_ROOT, 'scripts/setup-local.sh');

test(
  'setup-local validates WSL filesystem safety before npm can mutate the install',
  { skip: !fs.existsSync(setupLocalPath) },
  function () {
    const setup = fs.readFileSync(setupLocalPath, 'utf8');
    const validationIndex = setup.indexOf('scripts/validate-local-install.mjs');
    const installIndex = setup.indexOf('npm install)');
    const buildIndex = setup.indexOf('npm run build)');
    const linkIndex = setup.indexOf('npm link)');

    assert.notEqual(validationIndex, -1);
    assert.equal(validationIndex < installIndex, true);
    assert.equal(validationIndex < buildIndex, true);
    assert.equal(validationIndex < linkIndex, true);
  }
);
