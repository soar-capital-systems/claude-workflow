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
import {
  CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES,
  inspectClaudeThirdPartyModelSupport,
  prepareClaudeThirdPartyModelSupport,
} from '../js/utils/claude-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'js', 'cli', 'claude-workflow.js');
const WORKFLOW_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_WORKFLOW_',
  'CODEX_',
  'DEEPSEEK_',
  'GLM_',
  'KIMI_',
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
      'if [ -n "${FAKE_NATIVE_ENV_FILE:-}" ]; then printf \'claude:%s|%s|%s\\n\' "$*" "${ULTRATHINK_GATEWAY_KIMI_API_KEY+x}" "${KIMI_API_KEY+x}" >> "$FAKE_NATIVE_ENV_FILE"; fi',
      'if [ "${1:-}" = "--version" ]; then echo "2.1.206 (Claude Code)"; exit 0; fi',
      'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ] && [ "${3:-}" = "--json" ]; then if [ "${FAKE_CLAUDE_LOGGED_OUT:-}" = "1" ]; then echo \'{"loggedIn":false}\'; exit 1; fi; echo \'{"loggedIn":true}\'; exit 0; fi',
      'if [ -n "${FAKE_CLAUDE_SETTINGS_CAPTURE_FILE:-}" ]; then _cw_args=("$@"); for ((_cw_i=0; _cw_i<${#_cw_args[@]}; _cw_i++)); do if [ "${_cw_args[$_cw_i]}" = "--settings" ]; then _cw_i=$((_cw_i + 1)); cp "${_cw_args[$_cw_i]}" "$FAKE_CLAUDE_SETTINGS_CAPTURE_FILE"; break; fi; done; fi',
      'if [ -n "${FAKE_CLAUDE_ARGS_FILE:-}" ]; then printf \'%s\\n\' "$@" > "$FAKE_CLAUDE_ARGS_FILE"; if [ -z "${FAKE_CLAUDE_ENV_FILE:-}" ]; then exit 0; fi; fi',
      'if [ -n "${FAKE_CLAUDE_ENV_FILE:-}" ]; then printf \'%s\\n\' "${ULTRATHINK_GATEWAY_KIMI_API_KEY-unset}" "${KIMI_API_KEY-unset}" "${ANTHROPIC_MODEL-unset}" "${CLAUDE_CODE_EFFORT_LEVEL-unset}" "${CLAUDE_CODE_AUTO_COMPACT_WINDOW-unset}" "${CLAUDE_CODE_MAX_CONTEXT_TOKENS-unset}" "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN-unset}" "${ANTHROPIC_AUTH_TOKEN-unset}" "${ANTHROPIC_API_KEY-unset}" > "$FAKE_CLAUDE_ENV_FILE"; exit 0; fi',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  await fsp.writeFile(
    codex,
    [
      '#!/usr/bin/env bash',
      'if [ -n "${FAKE_NATIVE_ENV_FILE:-}" ]; then printf \'codex:%s|%s|%s\\n\' "$*" "${ULTRATHINK_GATEWAY_KIMI_API_KEY+x}" "${KIMI_API_KEY+x}" >> "$FAKE_NATIVE_ENV_FILE"; fi',
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

test(
  'Claude third-party-model preparation preserves state and never rewrites persistent settings',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-claude-state-');
    const target = path.join(home, '.claude.json');
    const original = '{\n  "theme": "dark"\n}\n';
    await fsp.writeFile(target, original, { mode: 0o644 });
    const settingsPath = path.join(home, '.claude', 'settings.json');
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    const originalSettings = `${JSON.stringify(
      {
        env: {
          ...Object.fromEntries(
            CLAUDE_WORKFLOW_MANAGED_SETTINGS_ENV_NAMES.map((name, index) => [
              name,
              `stale-routing-value-${index}`,
            ])
          ),
          UNRELATED_SETTING: 'preserved',
        },
        permissions: { allow: ['Read'] },
      },
      null,
      2
    )}\n`;
    await fsp.writeFile(settingsPath, originalSettings, { mode: 0o644 });
    const env = isolatedEnvironment(home);

    const prepared = prepareClaudeThirdPartyModelSupport(env);
    assert.equal(prepared.changed, true);
    assert.equal(prepared.stateChanged, true);
    assert.equal(prepared.settingsChanged, false);
    assert.equal(prepared.backupPath, `${target}.claude-workflow.bak`);
    assert.equal(prepared.settingsBackupPath, null);
    assert.equal(await fsp.readFile(prepared.backupPath, 'utf8'), original);
    const state = JSON.parse(await fsp.readFile(target, 'utf8'));
    assert.equal(state.theme, 'dark');
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.penguinModeOrgEnabled, true);
    assert.equal(await fsp.readFile(settingsPath, 'utf8'), originalSettings);
    assert.deepEqual(prepared.conflictingSettingsEnvNames, []);
    assert.equal(inspectClaudeThirdPartyModelSupport(env).enabled, true);
    assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(prepared.backupPath)).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(settingsPath)).mode & 0o777, 0o644);

    const repeated = prepareClaudeThirdPartyModelSupport(env);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.backupPath, null);
    assert.equal(repeated.settingsBackupPath, null);
    assert.equal(await fsp.readFile(`${target}.claude-workflow.bak`, 'utf8'), original);
    await assert.rejects(fsp.access(`${settingsPath}.claude-workflow.bak`));
  }
);

test(
  'Claude third-party-model preparation refuses a symlink state file',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-claude-state-link-');
    const real = path.join(home, 'real.json');
    const target = path.join(home, '.claude.json');
    await fsp.writeFile(real, '{"preserved":true}\n');
    await fsp.symlink(real, target);
    assert.throws(
      () => prepareClaudeThirdPartyModelSupport(isolatedEnvironment(home)),
      /regular file, not a symlink/u
    );
    assert.equal(await fsp.readFile(real, 'utf8'), '{"preserved":true}\n');
  }
);

test(
  'Claude third-party-model preparation leaves a symlinked settings file untouched',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-claude-settings-link-');
    const settingsDirectory = path.join(home, '.claude');
    const real = path.join(home, 'real-settings.json');
    const settingsPath = path.join(settingsDirectory, 'settings.json');
    await fsp.mkdir(settingsDirectory);
    await fsp.writeFile(real, '{"env":{"ANTHROPIC_MODEL":"stale"}}\n');
    await fsp.symlink(real, settingsPath);
    const prepared = prepareClaudeThirdPartyModelSupport(isolatedEnvironment(home));
    assert.equal(prepared.stateChanged, true);
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), true);
    assert.equal(
      await fsp.readFile(real, 'utf8'),
      '{"env":{"ANTHROPIC_MODEL":"stale"}}\n'
    );
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
  'shared setup refuses repository routing settings that outrank shell exports',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-routing-conflict-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'repo');
    const nested = path.join(project, 'packages', 'app');
    const settingsPath = path.join(project, '.claude', 'settings.local.json');
    await fsp.mkdir(home);
    await fsp.mkdir(path.join(project, '.git'), { recursive: true });
    await fsp.mkdir(path.dirname(settingsPath));
    await fsp.mkdir(nested, { recursive: true });
    const settingsText = '{"env":{"ANTHROPIC_BASE_URL":"https://custom.invalid","ANTHROPIC_MODEL":"custom"}}\n';
    await fsp.writeFile(settingsPath, settingsText);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SHELL: '/bin/bash',
    });
    const actions = [];

    assert.throws(
      () =>
        runSetupCommand(['--shared'], {
          cwd: nested,
          env,
          stdout: { write() { return true; } },
          runGatewayAction(action) {
            actions.push(action);
          },
        }),
      /shared mode cannot safely override.*ANTHROPIC_BASE_URL.*ANTHROPIC_MODEL/u
    );
    assert.deepEqual(actions, []);
    assert.equal(await fsp.readFile(settingsPath, 'utf8'), settingsText);
  }
);

test(
  'shared setup rejects repository environment loading',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shared-project-env-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const actions = [];
    assert.throws(
      () =>
        runSetupCommand(['--shared'], {
          env: isolatedEnvironment(home, {
            CLAUDE_WORKFLOW_LOAD_PROJECT_ENV: 'true',
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            SHELL: '/bin/bash',
          }),
          stdout: { write() { return true; } },
          runGatewayAction(action) {
            actions.push(action);
          },
        }),
      /shared mode cannot load a repository \.env/u
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
  'Kimi setup does not require an Anthropic login',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-setup-kimi-auth-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_LOGGED_OUT: '1',
      ULTRATHINK_GATEWAY_KIMI_API_KEY: 'test-kimi-setup-key',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'k3[1m]',
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
    });

    const withoutPreparation = runCli(['setup'], { env, timeout: 5_000 });
    assert.equal(withoutPreparation.status, 1);
    assert.match(
      `${withoutPreparation.stdout}\n${withoutPreparation.stderr}`,
      /setup --prepare-claude/u
    );

    const result = runCli(['setup', '--prepare-claude'], { env, timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /provider authentication via gateway/u);
    assert.match(result.stdout, /third-party model support enabled/u);
    const claudeState = JSON.parse(await fsp.readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claudeState.hasCompletedOnboarding, true);
    assert.equal(claudeState.penguinModeOrgEnabled, true);
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
  'config selects Kimi K3 1M/max without storing or resetting its credential',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-config-kimi-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = isolatedEnvironment(home);

    const update = runCli(['config', '--main', 'kimi'], { env });
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /ULTRATHINK_GATEWAY_KIMI_API_KEY/u);

    const configPath = path.join(home, '.claude-workflow.env');
    const content = await fsp.readFile(configPath, 'utf8');
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_PROVIDER=kimi/u);
    assert.match(content, /ULTRATHINK_GATEWAY_MAIN_MODEL_ID=k3\[1m\]/u);
    assert.doesNotMatch(content, /ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL=/u);
    assert.doesNotMatch(content, /ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT=/u);
    assert.doesNotMatch(content, /ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS=/u);
    assert.doesNotMatch(content, /KIMI_API_KEY=/u);

    const moderate = runCli(['config', '--main', 'k3'], { env });
    assert.equal(moderate.status, 0, moderate.stderr);
    const moderateContent = await fsp.readFile(configPath, 'utf8');
    assert.match(moderateContent, /ULTRATHINK_GATEWAY_MAIN_MODEL_ID=k3$/mu);
    assert.match(moderateContent, /ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS=262144/u);

    const oneMillion = runCli(['config', '--main', 'kimi'], { env });
    assert.equal(oneMillion.status, 0, oneMillion.stderr);
    const oneMillionContent = await fsp.readFile(configPath, 'utf8');
    assert.match(oneMillionContent, /ULTRATHINK_GATEWAY_MAIN_MODEL_ID=k3\[1m\]/u);
    assert.doesNotMatch(oneMillionContent, /ULTRATHINK_GATEWAY_KIMI_CONTEXT_TOKENS=/u);

    const fakeKey = 'test-kimi-config-key';
    await fsp.appendFile(
      configPath,
      `ULTRATHINK_GATEWAY_KIMI_API_KEY=${fakeKey}\n`,
      'utf8'
    );
    const show = runCli(['config'], {
      env: { ...env, ULTRATHINK_GATEWAY_KIMI_API_KEY: fakeKey },
    });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Main\s+Kimi K3 -> kimi \(k3\[1m\]\)/u);

    const reset = runCli(['config', '--reset'], { env });
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(
      (await fsp.readFile(configPath, 'utf8')).trim(),
      `ULTRATHINK_GATEWAY_KIMI_API_KEY=${fakeKey}`
    );
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

test(
  'launcher rejects a caller-supplied Claude settings override',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-settings-override-');
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const result = runCli(['--', '--settings', path.join(root, 'unsafe.json')], {
      env: isolatedEnvironment(home, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      }),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reserved by claude-workflow/u);
  }
);

test(
  'Kimi credentials stay gateway-only while Claude receives the 1M/max profile',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-kimi-child-env-');
    const home = path.join(root, 'home');
    const envFile = path.join(root, 'claude env.txt');
    const nativeEnvFile = path.join(root, 'native child env.txt');
    const argsFile = path.join(root, 'claude args.txt');
    const settingsCapture = path.join(root, 'private settings.json');
    const project = path.join(root, 'repo');
    await fsp.mkdir(home);
    await fsp.mkdir(path.join(project, '.claude'), { recursive: true });
    const persistentSettings = '{"env":{"ANTHROPIC_BASE_URL":"https://stale.invalid","ANTHROPIC_MODEL":"stale","CLAUDE_CODE_EFFORT_LEVEL":"low"}}\n';
    await fsp.writeFile(path.join(project, '.claude', 'settings.json'), persistentSettings);
    const bin = await installFakeNativeTools(root);
    const fakeKey = 'test-kimi-child-secret';
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_ENV_FILE: envFile,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
      FAKE_CLAUDE_SETTINGS_CAPTURE_FILE: settingsCapture,
      FAKE_NATIVE_ENV_FILE: nativeEnvFile,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'kimi',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'k3[1m]',
      ULTRATHINK_GATEWAY_KIMI_API_KEY: fakeKey,
      KIMI_API_KEY: 'test-kimi-ambient-secret',
    });
    prepareClaudeThirdPartyModelSupport(env);

    const result = runCli(['Reply with exactly OK.'], { cwd: project, env });
    assert.equal(result.status, 0, result.stderr);
    const values = (await fsp.readFile(envFile, 'utf8')).trim().split('\n');
    assert.deepEqual(values.slice(0, 6), [
      'unset',
      'unset',
      'k3[1m]',
      'max',
      '1048576',
      '1048576',
    ]);
    assert.notEqual(values[6], 'unset');
    assert.equal(values[7], values[6]);
    assert.equal(values[8], values[6]);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(fakeKey), false);
    const args = (await fsp.readFile(argsFile, 'utf8')).trim().split('\n');
    assert.ok(args.includes('--settings'));
    assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), [
      '--effort',
      'max',
    ]);
    const privateSettings = JSON.parse(await fsp.readFile(settingsCapture, 'utf8'));
    assert.equal(privateSettings.env.ANTHROPIC_MODEL, 'k3[1m]');
    assert.equal(privateSettings.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
    assert.equal(privateSettings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1048576');
    assert.equal(privateSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576');
    assert.equal(privateSettings.env.CLAUDE_CODE_SUBAGENT_MODEL, 'codex-terra');
    assert.equal(privateSettings.env.ULTRATHINK_GATEWAY_KIMI_API_KEY, '');
    assert.equal(privateSettings.env.KIMI_API_KEY, '');
    for (const name of [
      'ANTHROPIC_BETAS',
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_DISABLE_1M_CONTEXT',
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
      'CLAUDE_CODE_DISABLE_THINKING',
      'CLAUDE_CODE_USE_MANTLE',
    ]) {
      assert.equal(privateSettings.env[name], '');
    }
    assert.equal(privateSettings.env.ANTHROPIC_AUTH_TOKEN, values[6]);
    assert.equal(privateSettings.env.ANTHROPIC_API_KEY, values[6]);
    assert.equal(
      await fsp.readFile(path.join(project, '.claude', 'settings.json'), 'utf8'),
      persistentSettings
    );

    const doctor = runCli(['doctor'], { env });
    assert.equal(doctor.status, 0, doctor.stderr);
    const nativeChildRecords = (await fsp.readFile(nativeEnvFile, 'utf8'))
      .trim()
      .split('\n');
    assert.equal(nativeChildRecords.some((record) => record.startsWith('claude:')), true);
    assert.equal(nativeChildRecords.some((record) => record.startsWith('codex:')), true);
    for (const record of nativeChildRecords) {
      assert.match(record, /\|\|$/u);
    }
  }
);

test(
  'switching from Kimi to Fable removes stale Kimi client settings',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-fable-child-env-');
    const home = path.join(root, 'home');
    const envFile = path.join(root, 'claude env.txt');
    const settingsCapture = path.join(root, 'private settings.json');
    await fsp.mkdir(home);
    const bin = await installFakeNativeTools(root);
    const env = isolatedEnvironment(home, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CLAUDE_ENV_FILE: envFile,
      FAKE_CLAUDE_SETTINGS_CAPTURE_FILE: settingsCapture,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1048576',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN: 'stale-managed-token',
      ANTHROPIC_AUTH_TOKEN: 'stale-managed-token',
      ANTHROPIC_API_KEY: 'stale-managed-token',
    });

    const result = runCli(['Reply with exactly OK.'], { env });
    assert.equal(result.status, 0, result.stderr);
    const values = (await fsp.readFile(envFile, 'utf8')).trim().split('\n');
    assert.deepEqual(values, [
      'unset',
      'unset',
      'claude-fable-5[1m]',
      'unset',
      'unset',
      'unset',
      'unset',
      'unset',
      'unset',
    ]);
    const privateSettings = JSON.parse(await fsp.readFile(settingsCapture, 'utf8'));
    assert.equal(privateSettings.env.ANTHROPIC_MODEL, 'claude-fable-5[1m]');
    assert.equal(Object.hasOwn(privateSettings.env, 'ANTHROPIC_AUTH_TOKEN'), false);
    assert.equal(Object.hasOwn(privateSettings.env, 'ANTHROPIC_API_KEY'), false);
  }
);
