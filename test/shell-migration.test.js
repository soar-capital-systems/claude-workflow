import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANAGER = path.join(ROOT, 'scripts', 'claude-workflow-daemon.sh');
const CLEANUP_HOOK = path.join(ROOT, 'scripts', 'claude-workflow-gateway.bashrc');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'shell-migration');

async function temporaryDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fsp.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function shellMatrix() {
  const shells = [
    { command: 'bash', args: ['--noprofile', '--norc', '-c'], name: 'bash' },
  ];
  const zsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' });
  if (zsh.status === 0 && zsh.stdout.trim()) {
    shells.push({ command: zsh.stdout.trim(), args: ['-f', '-c'], name: 'zsh' });
  }
  return shells;
}

function runShell(shell, probe, args = [], env = process.env) {
  return spawnSync(shell.command, [...shell.args, probe, '_', ...args], {
    encoding: 'utf8',
    env,
  });
}

function managerEnvironment(home, shell = '/bin/bash') {
  return {
    ...process.env,
    HOME: home,
    SHELL: shell,
  };
}

test(
  'install-shell and uninstall-shell replace both historical marker formats with cleanup-only transition blocks',
  { skip: process.platform === 'win32' },
  async function (t) {
    for (const [fixtureName, expected] of [
      ['current-marker.bashrc', 'current'],
      ['ultrathink-marker.bashrc', 'ultrathink'],
    ]) {
      const home = await temporaryDirectory(t, `claude-workflow-${expected}-marker-`);
      const rcPath = path.join(home, '.bashrc');
      await fsp.copyFile(path.join(FIXTURES, fixtureName), rcPath);

      for (const action of ['install-shell', 'uninstall-shell']) {
        const result = spawnSync('bash', [MANAGER, action], {
          encoding: 'utf8',
          env: managerEnvironment(home),
        });
        assert.equal(result.status, 0, `${action}: ${result.stderr || result.stdout}`);
        const migrated = await fsp.readFile(rcPath, 'utf8');
        assert.equal((await fsp.stat(rcPath)).mode & 0o777, 0o644);
        assert.equal(
          (migrated.match(/# >>> claude-workflow shell cleanup >>>/gu) || []).length,
          1
        );
        assert.equal(migrated.includes('>>> claude-workflow gateway >>>'), false);
        assert.equal(migrated.includes('>>> ultrathink claude-workflow gateway >>>'), false);
        assert.equal(migrated.includes('claude-workflow-gateway ensure'), false);
        assert.equal(migrated.includes('CLAUDE_WORKFLOW_GATEWAY_ENV_FILE'), false);
        assert.match(migrated, new RegExp(`PRESERVED_BEFORE=${expected}`, 'u'));
        assert.match(migrated, new RegExp(`PRESERVED_AFTER=${expected}`, 'u'));
        assert.equal(
          fs.existsSync(path.join(home, '.cache', 'claude-workflow')),
          false,
          `${action} must not create or start gateway state`
        );
        if (fixtureName === 'current-marker.bashrc') {
          assert.ok(
            migrated.indexOf('# >>> claude-workflow shell cleanup >>>') <
              migrated.indexOf('return 0'),
            'the transition must retain the historical block position'
          );
        }
      }
    }
  }
);

test(
  'migration refuses malformed managed markers without changing the shell rc',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-malformed-marker-');
    const rcPath = path.join(home, '.bashrc');
    const malformed =
      'export PRESERVED=1\n# >>> claude-workflow gateway >>>\nexport IMPORTANT_AFTER=1\n';
    await fsp.writeFile(rcPath, malformed, { encoding: 'utf8', mode: 0o640 });
    const result = spawnSync('bash', [MANAGER, 'migrate-shell'], {
      encoding: 'utf8',
      env: managerEnvironment(home),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /malformed shell hook markers/u);
    assert.equal(await fsp.readFile(rcPath, 'utf8'), malformed);
    assert.equal((await fsp.stat(rcPath)).mode & 0o777, 0o640);
  }
);

test(
  'cleanup transition restores inherited managed overlays in Bash and zsh strict modes',
  { skip: process.platform === 'win32' },
  function () {
    const priorSecret = 'user-secret-must-not-be-traced';
    const managedSecret = 'managed-secret-must-not-be-traced';
    const inherited = {
      ...process.env,
      ANTHROPIC_API_KEY: managedSecret,
      ANTHROPIC_AUTH_TOKEN: managedSecret,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4318',
      ANTHROPIC_MODEL: 'codex',
      CLAUDE_CODE_SUBAGENT_MODEL: 'codex-terra',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN: managedSecret,
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES:
        'ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL CLAUDE_CODE_SUBAGENT_MODEL',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES:
        'ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL CLAUDE_CODE_SUBAGENT_MODEL',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES: 'ANTHROPIC_BASE_URL',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_EXPORTED_NAMES: 'ANTHROPIC_BASE_URL',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_ANTHROPIC_API_KEY: managedSecret,
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_ANTHROPIC_AUTH_TOKEN: managedSecret,
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_ANTHROPIC_BASE_URL: 'http://127.0.0.1:4318',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_ANTHROPIC_MODEL: 'codex',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_CLAUDE_CODE_SUBAGENT_MODEL: 'codex-terra',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_ANTHROPIC_BASE_URL:
        'https://api.anthropic.com',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_ANTHROPIC_API_KEY: priorSecret,
    };
    const probe = [
      'set -eu',
      'set -x',
      '. "$1"',
      'case $- in *x*) ;; *) exit 20 ;; esac',
      'set +x',
      'test "$ANTHROPIC_BASE_URL" = https://api.anthropic.com',
      'test -z "${ANTHROPIC_API_KEY+x}"',
      'test -z "${ANTHROPIC_AUTH_TOKEN+x}"',
      'test -z "${ANTHROPIC_MODEL+x}"',
      'test -z "${CLAUDE_CODE_SUBAGENT_MODEL+x}"',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES+x}"',
      'printf "SURVIVED\\n"',
    ].join('\n');

    for (const shell of shellMatrix()) {
      const result = runShell(shell, probe, [CLEANUP_HOOK], inherited);
      assert.equal(result.status, 0, `${shell.name}: ${result.stderr || result.stdout}`);
      assert.equal(result.stdout.trim(), 'SURVIVED');
      assert.equal(result.stderr.includes(priorSecret), false, shell.name);
      assert.equal(result.stderr.includes(managedSecret), false, shell.name);
    }
  }
);

test(
  'markerless 4318 plus codex-terra signature is cleared without clobbering unrelated provider settings',
  { skip: process.platform === 'win32' },
  async function () {
    const markerlessFixture = path.join(FIXTURES, 'markerless.env');
    const cleanEnvironment = {
      HOME: process.env.HOME || os.tmpdir(),
      PATH: process.env.PATH || '',
    };
    const cleanupProbe = [
      'set -eu',
      '. "$1"',
      '. "$2"',
      'test -z "${ANTHROPIC_BASE_URL+x}"',
      'test -z "${ANTHROPIC_MODEL+x}"',
      'test -z "${CLAUDE_CODE_SUBAGENT_MODEL+x}"',
      'test -z "${ANTHROPIC_DEFAULT_SONNET_MODEL+x}"',
      'test -z "${ANTHROPIC_DEFAULT_HAIKU_MODEL+x}"',
      'test -z "${ANTHROPIC_DEFAULT_OPUS_MODEL+x}"',
      'test -z "${ANTHROPIC_DEFAULT_FABLE_MODEL+x}"',
      'test -z "${CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY+x}"',
    ].join('\n');
    const preserveProbe = [
      'set -eu',
      'export ANTHROPIC_BASE_URL=https://provider.example',
      'export ANTHROPIC_MODEL=provider-model',
      'export CLAUDE_CODE_SUBAGENT_MODEL=codex-terra',
      'export ANTHROPIC_DEFAULT_SONNET_MODEL=provider-sonnet',
      '. "$1"',
      'test "$ANTHROPIC_BASE_URL" = https://provider.example',
      'test "$ANTHROPIC_MODEL" = provider-model',
      'test "$CLAUDE_CODE_SUBAGENT_MODEL" = codex-terra',
      'test "$ANTHROPIC_DEFAULT_SONNET_MODEL" = provider-sonnet',
      'export ANTHROPIC_BASE_URL=http://127.0.0.1:4318',
      'unset CLAUDE_CODE_SUBAGENT_MODEL',
      '. "$1"',
      'test "$ANTHROPIC_BASE_URL" = http://127.0.0.1:4318',
      'test "$ANTHROPIC_MODEL" = provider-model',
    ].join('\n');

    for (const shell of shellMatrix()) {
      const cleanup = runShell(
        shell,
        cleanupProbe,
        [markerlessFixture, CLEANUP_HOOK],
        cleanEnvironment
      );
      assert.equal(cleanup.status, 0, `${shell.name}: ${cleanup.stderr || cleanup.stdout}`);
      const preserve = runShell(shell, preserveProbe, [CLEANUP_HOOK], cleanEnvironment);
      assert.equal(preserve.status, 0, `${shell.name}: ${preserve.stderr || preserve.stdout}`);
    }
  }
);

test(
  'managed restoration preserves legitimate prior values matching the markerless signature',
  { skip: process.platform === 'win32' },
  function () {
    const exactSignature = {
      ...process.env,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4318',
      CLAUDE_CODE_SUBAGENT_MODEL: 'codex-terra',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES:
        'ANTHROPIC_BASE_URL CLAUDE_CODE_SUBAGENT_MODEL',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES:
        'ANTHROPIC_BASE_URL CLAUDE_CODE_SUBAGENT_MODEL',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES:
        'ANTHROPIC_BASE_URL CLAUDE_CODE_SUBAGENT_MODEL',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_EXPORTED_NAMES:
        'ANTHROPIC_BASE_URL CLAUDE_CODE_SUBAGENT_MODEL',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_ANTHROPIC_BASE_URL:
        'http://127.0.0.1:4318',
      CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_CLAUDE_CODE_SUBAGENT_MODEL:
        'codex-terra',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_ANTHROPIC_BASE_URL:
        'http://127.0.0.1:4318',
      CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_CLAUDE_CODE_SUBAGENT_MODEL:
        'codex-terra',
    };
    const probe = [
      'set -eu',
      '. "$1"',
      'test "$ANTHROPIC_BASE_URL" = http://127.0.0.1:4318',
      'test "$CLAUDE_CODE_SUBAGENT_MODEL" = codex-terra',
      'test -z "${CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES+x}"',
    ].join('\n');

    for (const shell of shellMatrix()) {
      const result = runShell(shell, probe, [CLEANUP_HOOK], exactSignature);
      assert.equal(result.status, 0, `${shell.name}: ${result.stderr || result.stdout}`);
    }
  }
);

test(
  'install reconciliation is global-only and migrates historical hooks on upgrade',
  { skip: process.platform === 'win32' },
  async function (t) {
    const script = path.join(ROOT, 'scripts', 'reconcile-installed-daemon.mjs');
    const localHome = await temporaryDirectory(t, 'claude-workflow-local-postinstall-');
    const localRc = path.join(localHome, '.bashrc');
    const historicalHook = await fsp.readFile(
      path.join(FIXTURES, 'current-marker.bashrc'),
      'utf8'
    );
    await fsp.writeFile(localRc, historicalHook);
    const localInstall = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...managerEnvironment(localHome),
        npm_config_global: 'false',
      },
    });
    assert.equal(localInstall.status, 0, localInstall.stderr || localInstall.stdout);
    assert.equal(await fsp.readFile(localRc, 'utf8'), historicalHook);

    const globalHome = await temporaryDirectory(t, 'claude-workflow-global-postinstall-');
    const globalRc = path.join(globalHome, '.bashrc');
    await fsp.writeFile(globalRc, historicalHook);
    const globalInstall = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...managerEnvironment(globalHome),
        npm_config_global: 'true',
      },
    });
    assert.equal(globalInstall.status, 0, globalInstall.stderr || globalInstall.stdout);
    const migrated = await fsp.readFile(globalRc, 'utf8');
    assert.match(migrated, /# >>> claude-workflow shell cleanup >>>/u);
    assert.equal(migrated.includes('claude-workflow-gateway ensure'), false);
    assert.equal(
      fs.existsSync(path.join(globalHome, '.cache', 'claude-workflow')),
      false,
      'global postinstall must not start or claim a stopped daemon'
    );

    const alternateShellHome = await temporaryDirectory(
      t,
      'claude-workflow-alternate-shell-postinstall-'
    );
    const alternateShellRc = path.join(alternateShellHome, '.bashrc');
    await fsp.writeFile(alternateShellRc, historicalHook);
    const alternateShellInstall = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...managerEnvironment(alternateShellHome, '/usr/bin/fish'),
        npm_config_global: 'true',
      },
    });
    assert.equal(
      alternateShellInstall.status,
      0,
      alternateShellInstall.stderr || alternateShellInstall.stdout
    );
    assert.match(
      await fsp.readFile(alternateShellRc, 'utf8'),
      /# >>> claude-workflow shell cleanup >>>/u
    );

    const freshHome = await temporaryDirectory(t, 'claude-workflow-fresh-postinstall-');
    const freshEnvironment = managerEnvironment(freshHome);
    for (const name of Object.keys(freshEnvironment)) {
      if (
        name.startsWith('CLAUDE_WORKFLOW_GATEWAY_MANAGED_') ||
        name.startsWith('CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_')
      ) {
        delete freshEnvironment[name];
      }
    }
    for (const name of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
    ]) {
      delete freshEnvironment[name];
    }
    const freshInstall = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...freshEnvironment,
        npm_config_global: 'true',
      },
    });
    assert.equal(freshInstall.status, 0, freshInstall.stderr || freshInstall.stdout);
    assert.equal(
      fs.existsSync(path.join(freshHome, '.bashrc')),
      false,
      'a fresh global install must not add an unnecessary shell hook'
    );
  }
);

test(
  'global installation remains installable when bash is unavailable',
  { skip: process.platform !== 'linux' },
  async function (t) {
    const script = path.join(ROOT, 'scripts', 'reconcile-installed-daemon.mjs');
    const home = await temporaryDirectory(t, 'claude-workflow-no-bash-postinstall-');
    const emptyPath = path.join(home, 'empty-path');
    await fsp.mkdir(emptyPath);
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: emptyPath,
        SHELL: '/bin/bash',
        npm_config_global: 'true',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /bash is unavailable/u);
  }
);

test(
  'cleanup-only source hook never invokes a skewed manager even with the removed legacy opt-in set',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-manager-skew-');
    const bin = path.join(root, 'bin');
    const calls = path.join(root, 'manager-calls');
    await fsp.mkdir(bin);
    const managerPath = path.join(bin, 'claude-workflow-gateway');
    await fsp.copyFile(path.join(FIXTURES, 'skewed-manager'), managerPath);
    await fsp.chmod(managerPath, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      CLAUDE_WORKFLOW_ENABLE_LEGACY_SHARED_SHELL_HOOK: '1',
      CLAUDE_WORKFLOW_TEST_CURRENT_SOURCE_HOOK: CLEANUP_HOOK,
      CLAUDE_WORKFLOW_TEST_MANAGER_CALLS: calls,
    };
    const probe = 'set -eu; . "$1"; printf "DIRECT\\n"';
    const sourceFixture = path.join(FIXTURES, 'current-source-hook.bashrc');

    for (const shell of shellMatrix()) {
      const result = runShell(shell, probe, [sourceFixture], env);
      assert.equal(result.status, 0, `${shell.name}: ${result.stderr || result.stdout}`);
      assert.equal(result.stdout.trim(), 'DIRECT');
    }
    assert.equal(fs.existsSync(calls), false);
  }
);

test(
  'migrated historical hooks cannot run or abort startup under strict shell modes',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-strict-migration-');
    const rcPath = path.join(home, '.bashrc');
    await fsp.copyFile(path.join(FIXTURES, 'current-marker.bashrc'), rcPath);
    const migration = spawnSync('bash', [MANAGER, 'uninstall-shell'], {
      encoding: 'utf8',
      env: managerEnvironment(home),
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);

    for (const shell of shellMatrix()) {
      const result = runShell(
        shell,
        'set -eux; . "$1"; case $- in *x*) ;; *) exit 30 ;; esac; set +x; test "$PRESERVED_AFTER" = current',
        [rcPath],
        {
          ...process.env,
          CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: path.join(home, 'missing.env'),
        }
      );
      assert.equal(result.status, 0, `${shell.name}: ${result.stderr || result.stdout}`);
    }
  }
);

test(
  'setup migration action creates a cleanup transition when the active rc is absent',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-absent-rc-migration-');
    const result = spawnSync('bash', [MANAGER, 'migrate-shell'], {
      encoding: 'utf8',
      env: managerEnvironment(home),
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const rc = await fsp.readFile(path.join(home, '.bashrc'), 'utf8');
    assert.match(rc, /# >>> claude-workflow shell cleanup >>>/u);
    assert.equal(rc.includes('claude-workflow-gateway ensure'), false);
  }
);

test(
  'shell migration is independent of daemon state configuration',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-independent-migration-');
    const result = spawnSync('bash', [MANAGER, 'migrate-shell'], {
      encoding: 'utf8',
      env: {
        ...managerEnvironment(home),
        CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: 'invalid-relative-state',
        CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: 'invalid-relative-env',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(await fsp.readFile(path.join(home, '.bashrc'), 'utf8'), /shell cleanup/u);
  }
);

test(
  'shell migration fails closed when inherited routing has no selected rc',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-unselected-rc-');
    const result = spawnSync('bash', [MANAGER, 'migrate-shell'], {
      encoding: 'utf8',
      env: {
        ...managerEnvironment(home, '/bin/fish'),
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4318',
        CLAUDE_CODE_SUBAGENT_MODEL: 'codex-terra',
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no Bash\/zsh rc was selected/u);
    assert.match(result.stderr, /CLAUDE_WORKFLOW_SHELL_RC/u);
    assert.equal(fs.existsSync(path.join(home, '.bashrc')), false);
  }
);

test(
  'shell migration rejects symlink cycles and unsafe backup collisions without mutation',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-shell-path-safety-');
    const firstLink = path.join(home, 'first-link');
    const secondLink = path.join(home, 'second-link');
    await fsp.symlink(secondLink, firstLink);
    await fsp.symlink(firstLink, secondLink);
    const cycle = spawnSync('bash', [MANAGER, 'migrate-shell'], {
      encoding: 'utf8',
      env: {
        ...managerEnvironment(home),
        CLAUDE_WORKFLOW_SHELL_RC: firstLink,
      },
    });
    assert.equal(cycle.status, 1);
    assert.match(cycle.stderr, /symlink cycle/u);

    const rcPath = path.join(home, '.bashrc');
    const sentinel = path.join(home, 'sentinel');
    await fsp.writeFile(rcPath, 'export PRESERVED=yes\n', { mode: 0o640 });
    await fsp.writeFile(sentinel, 'do-not-overwrite\n');
    await fsp.symlink(sentinel, `${rcPath}.claude-workflow.bak`);
    const collision = spawnSync('bash', [MANAGER, 'migrate-shell'], {
      encoding: 'utf8',
      env: managerEnvironment(home),
    });
    assert.equal(collision.status, 1);
    assert.match(collision.stderr, /unsafe shell rc backup collision/u);
    assert.equal(await fsp.readFile(rcPath, 'utf8'), 'export PRESERVED=yes\n');
    assert.equal(await fsp.readFile(sentinel, 'utf8'), 'do-not-overwrite\n');
    assert.equal((await fsp.stat(rcPath)).mode & 0o777, 0o640);
  }
);

test(
  'setup migration selects zsh ZDOTDIR without starting gateway state',
  { skip: process.platform === 'win32' },
  async function (t) {
    const home = await temporaryDirectory(t, 'claude-workflow-zsh-rc-migration-');
    const zDotDirectory = path.join(home, 'zsh config');
    const result = spawnSync('bash', [MANAGER, 'migrate-shell'], {
      encoding: 'utf8',
      env: {
        ...managerEnvironment(home, '/bin/zsh'),
        ZDOTDIR: zDotDirectory,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const rc = await fsp.readFile(path.join(zDotDirectory, '.zshrc'), 'utf8');
    assert.match(rc, /# >>> claude-workflow shell cleanup >>>/u);
    assert.equal(fs.existsSync(path.join(home, '.cache', 'claude-workflow')), false);
  }
);
