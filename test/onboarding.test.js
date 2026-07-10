import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isWindowsMountedPath,
  rewriteConfigurationText,
  runSetupCommand,
  writeUserConfiguration,
} from '../js/cli/onboarding.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'js', 'cli', 'claude-workflow.js');
const WORKFLOW_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_WORKFLOW_',
  'CODEX_',
  'DEEPSEEK_',
  'GLM_',
  'ULTRATHINK_',
  'ZAI_',
];

async function temporaryDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async function removeDirectory() {
    await fsp.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function isolatedEnvironment(home, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (WORKFLOW_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 15_000,
  });
}

function runCliAsync(args, options = {}) {
  return new Promise(function run(resolve, reject) {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr, stdout }));
  });
}

async function installFakeNativeTools(root) {
  const bin = path.join(root, 'fake bin');
  await fsp.mkdir(bin);
  const claude = path.join(bin, 'claude');
  const codex = path.join(bin, 'codex');
  await fsp.writeFile(
    claude,
    [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "--version" ]; then echo "2.1.206 (Claude Code)"; exit 0; fi',
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ] && [ "${3:-}" = "--json" ]; then echo \'{"loggedIn":true}\'; exit 0; fi',
      'if [ -n "${FAKE_CLAUDE_ARGS_FILE:-}" ]; then printf \'%s\\n\' "$@" > "$FAKE_CLAUDE_ARGS_FILE"; exit 0; fi',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  await fsp.writeFile(
    codex,
    [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "--version" ]; then echo "codex-cli ${FAKE_CODEX_VERSION:-0.144.1}"; exit 0; fi',
      'if [ "${1:-}" = "login" ] && [ "${2:-}" = "status" ]; then',
      '  if [ "${FAKE_CODEX_LOGGED_OUT:-}" = "1" ]; then echo "Not logged in"; exit 1; fi',
      '  echo "Logged in using ChatGPT"; exit 0',
      'fi',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  return bin;
}

test('configuration rewriting preserves unmanaged content and line endings', function () {
  const original = [
    '# personal note',
    'UNMANAGED=value',
    'export ULTRATHINK_GATEWAY_CODEX_MODEL=old-model',
    'ULTRATHINK_GATEWAY_CODEX_MODEL=duplicate',
    'CLAUDE_WORKFLOW_SKIP_PERMISSIONS=true',
    '',
  ].join('\r\n');
  const rewritten = rewriteConfigurationText(
    original,
    { ULTRATHINK_GATEWAY_CODEX_MODEL: 'gpt-5.6-sol' },
    ['CLAUDE_WORKFLOW_SKIP_PERMISSIONS']
  );

  assert.equal(
    rewritten,
    [
      '# personal note',
      'UNMANAGED=value',
      'ULTRATHINK_GATEWAY_CODEX_MODEL=gpt-5.6-sol',
      '',
    ].join('\r\n')
  );
});

test(
  'configuration writes are atomic, private, idempotent, and Unicode-path safe',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude workflow إعداد ');
    const target = path.join(root, 'home with spaces', '.claude-workflow.env');
    await fsp.mkdir(path.dirname(target));
    await fsp.writeFile(target, '# keep me\nUNMANAGED=yes\n', { mode: 0o644 });

    const first = writeUserConfiguration(target, {
      ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-5.6-terra',
      CLAUDE_WORKFLOW_SKIP_PERMISSIONS: 'false',
    });
    assert.equal(first.changed, true);
    assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
    assert.match(await fsp.readFile(target, 'utf8'), /^# keep me\nUNMANAGED=yes\n/u);

    const second = writeUserConfiguration(target, {
      ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-5.6-terra',
      CLAUDE_WORKFLOW_SKIP_PERMISSIONS: 'false',
    });
    assert.equal(second.changed, false);
    assert.deepEqual((await fsp.readdir(path.dirname(target))).sort(), ['.claude-workflow.env']);
  }
);

test(
  'configuration writer refuses symlink targets',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-symlink-');
    const real = path.join(root, 'real.env');
    const link = path.join(root, 'linked.env');
    await fsp.writeFile(real, 'UNMANAGED=safe\n');
    await fsp.symlink(real, link);
    assert.throws(
      () => writeUserConfiguration(link, { CLAUDE_WORKFLOW_SKIP_PERMISSIONS: 'true' }),
      /regular file, not a symlink/u
    );
    assert.equal(await fsp.readFile(real, 'utf8'), 'UNMANAGED=safe\n');
  }
);

test('WSL path detection distinguishes mounted Windows paths', function () {
  assert.equal(isWindowsMountedPath('/mnt/c/Users/example/node'), true);
  assert.equal(isWindowsMountedPath('/MNT/D/tools/codex.EXE'), true);
  assert.equal(isWindowsMountedPath('/home/example/.local/bin/codex'), false);
  assert.equal(isWindowsMountedPath('/mnt/wsl/shared/codex'), false);
});

test(
  'setup validates fake native tools without creating configuration',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });

    const result = runCli(['setup'], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Claude Workflow setup/u);
    assert.match(result.stdout, /Claude Code .*authenticated/u);
    assert.match(result.stdout, /Codex CLI .*authenticated/u);
    assert.match(result.stdout, /Ready\. Run `claude-workflow`/u);
    assert.equal(fs.existsSync(path.join(home, '.claude-workflow.env')), false);
  }
);

test(
  'shared setup validates the shell before starting the daemon',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-shell-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/usr/bin/fish',
    });
    const actions = [];

    assert.throws(
      () =>
        runSetupCommand(['--shared'], {
          env,
          stdout: { write() { return true; } },
          runGatewayAction(action) {
            actions.push(action);
          },
        }),
      /does not support shell fish/u
    );
    assert.deepEqual(actions, []);
  }
);

test(
  'shared setup validates a dangling shell-rc symlink target before starting',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-symlink-');
    const home = path.join(root, 'home');
    const blockingFile = path.join(root, 'not-a-directory');
    await fsp.mkdir(home);
    await fsp.writeFile(blockingFile, 'block');
    await fsp.symlink(path.join(blockingFile, '.bashrc'), path.join(home, '.bashrc'));
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
    });
    const actions = [];

    assert.throws(
      () =>
        runSetupCommand(['--shared'], {
          env,
          stdout: { write() { return true; } },
          runGatewayAction(action) {
            actions.push(action);
          },
        }),
      /non-directory ancestor/u
    );
    assert.deepEqual(actions, []);
  }
);

test(
  'Linux setup rejects WSL home paths on mounted Windows storage',
  { skip: process.platform !== 'linux' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-wsl-platform-');
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment('/mnt/c/Users/example', {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
      WSL_DISTRO_NAME: 'Ubuntu',
    });

    const result = runCli(['setup'], { env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[error\] Platform WSL/u);
    assert.match(result.stdout, /Home directory, Gateway state resolves to Windows or \/mnt storage/u);
  }
);

test(
  'Linux setup resolves WSL state paths through intermediate symlinks',
  { skip: process.platform !== 'linux' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-wsl-state-link-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    await fsp.symlink('/mnt/c/Users/example/workflow-state', path.join(home, 'state-link'));
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
      WSL_DISTRO_NAME: 'Ubuntu',
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: path.join(home, 'state-link', 'gateway'),
    });

    const result = runCli(['setup'], { env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\[error\] Platform WSL/u);
    assert.match(result.stdout, /Gateway state resolves to Windows or \/mnt storage/u);
  }
);

test(
  'setup fails promptly with actionable logged-out guidance',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-logged-out-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CODEX_LOGGED_OUT: '1',
    });

    const result = runCli(['setup'], { env, timeout: 5_000 });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /Run `codex login`/u);
    assert.equal(fs.existsSync(path.join(home, '.claude-workflow.env')), false);
  }
);

test(
  'setup rejects unsupported Codex versions before authentication',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-old-codex-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CODEX_VERSION: '0.143.99',
    });

    const result = runCli(['setup'], { env });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /requires Codex CLI 0\.144\.1 or newer/u);
  }
);

test(
  'shared setup starts the daemon before installing its shell hook',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-setup-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    const actions = [];
    let output = '';

    runSetupCommand(['--shared'], {
      env,
      stdout: {
        write(chunk) {
          output += String(chunk);
          return true;
        },
      },
      runGatewayAction(action) {
        actions.push(action);
      },
    });

    assert.deepEqual(actions, ['start', 'install-shell']);
    assert.match(output, /Shared gateway enabled/u);
  }
);

test(
  'config supports short names, reports effective values, and resets managed settings',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-command-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home);

    const update = runCli(
      ['config', '--main', 'fable', '--agents', 'sol', '--effort', 'high', '--permissions', 'prompt'],
      { env }
    );
    assert.equal(update.status, 0, update.stderr);
    const configPath = path.join(home, '.claude-workflow.env');
    const content = await fsp.readFile(configPath, 'utf8');
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_MODEL_ID=claude-fable-5\[1m\]/u);
    assert.match(content, /ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL=gpt-5\.6-sol/u);
    assert.match(content, /ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT=high/u);
    assert.match(content, /CLAUDE_WORKFLOW_SKIP_PERMISSIONS=false/u);
    assert.equal((await fsp.stat(configPath)).mode & 0o777, 0o600);

    const show = runCli(['config'], { env });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Agents\s+Sol -> codex \(gpt-5\.6-sol\)/u);
    assert.match(show.stdout, /Reasoning\s+high/u);
    assert.match(show.stdout, /Permissions\s+prompt/u);

    const reset = runCli(['config', '--reset'], { env });
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(await fsp.readFile(configPath, 'utf8'), '');
  }
);

test(
  'concurrent config commands merge independent updates without leftover locks',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-concurrency-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home);
    const commands = [];
    for (let index = 0; index < 8; index += 1) {
      commands.push(runCliAsync(['config', '--agents', 'Vendor/CaseSensitive-ID'], { env }));
      commands.push(runCliAsync(['config', '--permissions', 'prompt'], { env }));
    }

    const results = await Promise.all(commands);
    for (const result of results) {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }

    const content = await fsp.readFile(path.join(home, '.claude-workflow.env'), 'utf8');
    assert.match(content, /ULTRATHINK_GATEWAY_CODEX_MODEL=Vendor\/CaseSensitive-ID/u);
    assert.match(content, /CLAUDE_WORKFLOW_SKIP_PERMISSIONS=false/u);
    assert.deepEqual((await fsp.readdir(home)).sort(), ['.claude-workflow.env']);
  }
);

test(
  'run dispatches a prompt that begins with a reserved command name',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-run-command-');
    const home = path.join(root, 'home');
    const argsFile = path.join(root, 'claude args.txt');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
    });

    const result = runCli(['run', 'setup', 'the', 'repository'], { env });
    assert.equal(result.status, 0, result.stderr);
    const claudeArgs = (await fsp.readFile(argsFile, 'utf8')).trim().split('\n');
    assert.ok(claudeArgs.includes('-p'));
    assert.equal(claudeArgs.at(-1), 'setup the repository');
  }
);
