#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function filesUnder(directory, extension) {
  const files = [];
  if (!fs.existsSync(directory)) {
    return files;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(target, extension));
    } else if (entry.isFile() && target.endsWith(extension)) {
      files.push(target);
    }
  }
  return files;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
  }
}

for (const file of [...filesUnder(path.join(ROOT, 'js'), '.js'), ...filesUnder(path.join(ROOT, 'test'), '.js')]) {
  run(process.execPath, ['--check', file]);
}

for (const file of [
  path.join(ROOT, 'scripts', 'claude-workflow-daemon.sh'),
  path.join(ROOT, 'scripts', 'claude-workflow-gateway.bashrc'),
]) {
  run('bash', ['-n', file]);
}

const zshProbe = spawnSync('zsh', ['--version'], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: 'pipe',
});
if (!zshProbe.error && zshProbe.status === 0) {
  run('zsh', ['-n', path.join(ROOT, 'scripts', 'claude-workflow-gateway.bashrc')]);
}

process.stdout.write('JavaScript and shell syntax checks passed.\n');
