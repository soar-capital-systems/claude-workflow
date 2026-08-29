import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const INSTALLER = path.resolve('.github/scripts/install-latest-upstream-clis.sh');
const POSIX_ONLY = { skip: process.platform === 'win32' };

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'upstream-cli-install-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeExecutable(target, lines) {
  await fs.writeFile(target, `${lines.join('\n')}\n`, { mode: 0o755 });
  await fs.chmod(target, 0o755);
}

function commandHasArgument(line, expected) {
  return line.trim().split(/\s+/u).includes(expected);
}

async function fakeToolchain(
  t,
  { successfulCodexAttempt, failedCodexInstalls = 0, claudeOutput = '2.1.251 (Claude Code)' }
) {
  const root = await temporaryDirectory(t);
  const bin = path.join(root, 'bin');
  const templates = path.join(root, 'templates');
  const log = path.join(root, 'npm.log');
  const count = path.join(root, 'codex-install-count');
  await fs.mkdir(bin);
  await fs.mkdir(templates);

  await writeExecutable(path.join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == "view" ]]; then',
    '  printf "view %s\\n" "$*" >>"${FAKE_NPM_LOG}"',
    '  case "${2:-}" in',
    '    @anthropic-ai/claude-code@latest) echo "2.1.251" ;;',
    '    @openai/codex@latest) echo "0.151.0" ;;',
    '    *) exit 2 ;;',
    '  esac',
    '  exit 0',
    'fi',
    'if [[ "${1:-}" == "prefix" && "${2:-}" == "--global" ]]; then',
    '  echo "${FAKE_NPM_PREFIX}"',
    '  exit 0',
    'fi',
    'if [[ "${1:-}" == "list" ]]; then',
    '  printf "list %s\\n" "$*" >>"${FAKE_NPM_LOG}"',
    '  case "$*" in',
    '    *"@anthropic-ai/claude-code@2.1.251"*|*"@openai/codex@0.151.0"*) exit 0 ;;',
    '    *) exit 1 ;;',
    '  esac',
    'fi',
    'if [[ "${1:-}" == "install" && "$*" == *"@openai/codex@"* ]]; then',
    '  current="$(cat "${FAKE_INSTALL_COUNT}" 2>/dev/null || echo 0)"',
    '  current=$((current + 1))',
    '  echo "${current}" >"${FAKE_INSTALL_COUNT}"',
    '  printf "codex-install %s\\n" "$*" >>"${FAKE_NPM_LOG}"',
    '  if ((current <= FAKE_CODEX_FAILED_INSTALLS)); then exit 1; fi',
    '  ln -sf "${FAKE_CODEX_TEMPLATE}" "${FAKE_NPM_PREFIX}/bin/codex"',
    'elif [[ "${1:-}" == "install" ]]; then',
    '  printf "claude-install %s\\n" "$*" >>"${FAKE_NPM_LOG}"',
    '  ln -sf "${FAKE_CLAUDE_TEMPLATE}" "${FAKE_NPM_PREFIX}/bin/claude"',
    'elif [[ "${1:-}" == "uninstall" ]]; then',
    '  printf "codex-uninstall %s\\n" "$*" >>"${FAKE_NPM_LOG}"',
    '  rm -f "${FAKE_NPM_PREFIX}/bin/codex"',
    'fi',
  ]);
  const claudeTemplate = path.join(templates, 'claude');
  const codexTemplate = path.join(templates, 'codex');
  await writeExecutable(claudeTemplate, [
    '#!/usr/bin/env bash',
    'echo "${FAKE_CLAUDE_OUTPUT}"',
  ]);
  await writeExecutable(codexTemplate, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'current="$(cat "${FAKE_INSTALL_COUNT}" 2>/dev/null || echo 0)"',
    'if ((current < FAKE_CODEX_SUCCESS_ATTEMPT)); then',
    '  echo "missing native Codex package" >&2',
    '  exit 1',
    'fi',
    'echo "codex-cli 0.151.0"',
  ]);

  return {
    count,
    log,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CODEX_SUCCESS_ATTEMPT: String(successfulCodexAttempt),
      FAKE_CODEX_FAILED_INSTALLS: String(failedCodexInstalls),
      FAKE_CODEX_TEMPLATE: codexTemplate,
      FAKE_CLAUDE_OUTPUT: claudeOutput,
      FAKE_CLAUDE_TEMPLATE: claudeTemplate,
      FAKE_INSTALL_COUNT: count,
      FAKE_NPM_LOG: log,
      FAKE_NPM_PREFIX: root,
      CLAUDE_WORKFLOW_UPSTREAM_INSTALL_ATTEMPTS: '3',
      CLAUDE_WORKFLOW_UPSTREAM_RETRY_DELAY_SECONDS: '0',
    },
  };
}

test('latest-upstream installer retries one exact Codex version with fresh caches', POSIX_ONLY, async function (t) {
  const fixture = await fakeToolchain(t, { successfulCodexAttempt: 2 });
  const result = spawnSync('bash', [INSTALLER], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: fixture.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /codex-cli 0\.151\.0/u);
  const lines = (await fs.readFile(fixture.log, 'utf8')).trim().split('\n');
  const installs = lines.filter((line) => line.startsWith('codex-install '));
  assert.equal(installs.length, 2);
  assert.equal(
    installs.every((line) => commandHasArgument(line, '@openai/codex@0.151.0')),
    true
  );
  assert.equal(installs.every((line) => line.includes('--include=optional')), true);
  const caches = installs.map((line) => line.match(/--cache ([^ ]+)/u)?.[1]);
  assert.equal(caches.every(Boolean), true);
  assert.equal(new Set(caches).size, installs.length);
  assert.equal(lines.filter((line) => line.startsWith('codex-uninstall ')).length, 2);
  assert.equal(lines.filter((line) => line.startsWith('view ')).length, 2);
  assert.equal(lines.filter((line) => line.startsWith('list ')).length, 3);
});

test('latest-upstream installer fails instead of falling back after its bounded attempts', POSIX_ONLY, async function (t) {
  const fixture = await fakeToolchain(t, { successfulCodexAttempt: 99 });
  const result = spawnSync('bash', [INSTALLER], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: fixture.env,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remained unavailable after 3 attempts/u);
  const lines = (await fs.readFile(fixture.log, 'utf8')).trim().split('\n');
  const installs = lines.filter((line) => line.startsWith('codex-install '));
  assert.equal(installs.length, 3);
  assert.equal(
    installs.every((line) => commandHasArgument(line, '@openai/codex@0.151.0')),
    true
  );
  assert.equal(lines.filter((line) => line.startsWith('view ')).length, 2);
});

test('latest-upstream installer retries a failed npm install under errexit', POSIX_ONLY, async function (t) {
  const fixture = await fakeToolchain(t, {
    failedCodexInstalls: 1,
    successfulCodexAttempt: 2,
  });
  const result = spawnSync('bash', [INSTALLER], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: fixture.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const log = await fs.readFile(fixture.log, 'utf8');
  assert.equal((log.match(/^codex-install /gmu) || []).length, 2);
});

test('latest-upstream installer rejects a non-exact Claude version', POSIX_ONLY, async function (t) {
  const fixture = await fakeToolchain(t, {
    claudeOutput: '2.1.2510 (Claude Code)',
    successfulCodexAttempt: 1,
  });
  const result = spawnSync('bash', [INSTALLER], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: fixture.env,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected version/u);
  const log = await fs.readFile(fixture.log, 'utf8');
  assert.doesNotMatch(log, /^codex-install /mu);
});
