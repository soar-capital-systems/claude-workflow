import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  daemonPort,
  managedWorkflowEnvironmentCleanupShell,
  quotePosixShellValue,
  serializeWorkflowEnvironment,
  writeWorkflowEnvironmentFile,
} from '../js/cli/claude-workflow-daemon.js';
import { createGatewayTracer } from '../js/gateway/trace.js';
import { assertSafeUserEnvironmentFile } from '../js/utils/env-loader.js';
import {
  CLAUDE_TERMINAL_TITLE_ENV_NAME,
  MANAGED_GATEWAY_AUTH_ENV_NAME,
  MANAGED_TERMINAL_TITLE_ENV_NAME,
  MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME,
  MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME,
  MANAGED_WORKFLOW_ENV_VALUE_PREFIX,
  PREVIOUS_TERMINAL_TITLE_ENV_NAME,
  PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME,
  PREVIOUS_WORKFLOW_ENV_EXPORTED_NAMES_ENV_NAME,
  PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME,
  PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX,
  environmentWithoutGatewayAndAnthropicCredentials,
  environmentWithoutGatewayCredentials,
} from '../js/utils/child-env.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_LOADER_URL = pathToFileURL(path.join(REPO_ROOT, 'js', 'utils', 'env-loader.js')).href;
const PROJECT_MARKER = 'SECURITY_HARDENING_PROJECT_ENV_MARKER';
const PROJECT_ENV_OPT_IN = 'CLAUDE_WORKFLOW_LOAD_PROJECT_ENV';

function embeddedManagedEnvironmentCleanup(source) {
  const start = source.indexOf('_claude_workflow_gateway_restore_environment() {');
  assert.notEqual(start, -1);
  const endMarker =
    'unset -f _claude_workflow_gateway_restore_environment 2>/dev/null || :';
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1);
  return source.slice(start, end + endMarker.length);
}

async function temporaryDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async function removeTemporaryDirectory() {
    await fsp.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function probeEnvironmentLoader(cwd, home, entrypoint, extraEnv = {}) {
  const probe = [
    `process.argv[1] = ${JSON.stringify(entrypoint)};`,
    `await import(${JSON.stringify(ENV_LOADER_URL)});`,
    `process.stdout.write(JSON.stringify({ marker: process.env.${PROJECT_MARKER} || '' }));`,
  ].join('\n');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ...extraEnv,
  };
  if (!Object.hasOwn(extraEnv, PROJECT_MARKER)) {
    delete env[PROJECT_MARKER];
  }
  if (!Object.hasOwn(extraEnv, PROJECT_ENV_OPT_IN)) {
    delete env[PROJECT_ENV_OPT_IN];
  }

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('child credential cleanup removes gateway upstream keys and only workflow-owned auth tokens', function () {
  const managed = 'test-managed-gateway-token';
  const cleaned = environmentWithoutGatewayCredentials({
    [MANAGED_GATEWAY_AUTH_ENV_NAME]: managed,
    [MANAGED_TERMINAL_TITLE_ENV_NAME]: '1',
    ANTHROPIC_AUTH_TOKEN: managed,
    ANTHROPIC_API_KEY: 'user-anthropic-key',
    [CLAUDE_TERMINAL_TITLE_ENV_NAME]: '1',
    DEEPSEEK_API_KEY: 'gateway-deepseek-key',
    GLM_API_KEY: 'gateway-glm-key',
    OPENAI_API_KEY: 'gateway-openai-key',
    ZAI_API_KEY: 'gateway-zai-key',
    ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'gateway-anthropic-key',
    KIMI_API_KEY: 'gateway-only-kimi-key',
    ULTRATHINK_GATEWAY_KIMI_API_KEY: 'preferred-gateway-only-kimi-key',
    ULTRATHINK_GATEWAY_SHARED_SECRET: 'gateway-only-shared-secret',
    PRESERVED_VALUE: 'yes',
  });

  assert.equal(Object.hasOwn(cleaned, MANAGED_GATEWAY_AUTH_ENV_NAME), false);
  assert.equal(Object.hasOwn(cleaned, MANAGED_TERMINAL_TITLE_ENV_NAME), false);
  assert.equal(Object.hasOwn(cleaned, 'ANTHROPIC_AUTH_TOKEN'), false);
  assert.equal(cleaned.ANTHROPIC_API_KEY, 'user-anthropic-key');
  assert.equal(Object.hasOwn(cleaned, CLAUDE_TERMINAL_TITLE_ENV_NAME), false);
  for (const name of ['DEEPSEEK_API_KEY', 'GLM_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY']) {
    assert.equal(Object.hasOwn(cleaned, name), false);
  }
  assert.equal(Object.hasOwn(cleaned, 'ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY'), false);
  assert.equal(Object.hasOwn(cleaned, 'KIMI_API_KEY'), false);
  assert.equal(Object.hasOwn(cleaned, 'ULTRATHINK_GATEWAY_KIMI_API_KEY'), false);
  assert.equal(Object.hasOwn(cleaned, 'ULTRATHINK_GATEWAY_SHARED_SECRET'), false);
  assert.equal(cleaned.PRESERVED_VALUE, 'yes');

  const userAuth = environmentWithoutGatewayCredentials({
    [MANAGED_GATEWAY_AUTH_ENV_NAME]: managed,
    ANTHROPIC_AUTH_TOKEN: 'user-auth-token',
  });
  assert.equal(userAuth.ANTHROPIC_AUTH_TOKEN, 'user-auth-token');

  const userTerminalTitle = environmentWithoutGatewayCredentials({
    [MANAGED_TERMINAL_TITLE_ENV_NAME]: '1',
    [CLAUDE_TERMINAL_TITLE_ENV_NAME]: '0',
  });
  assert.equal(userTerminalTitle[CLAUDE_TERMINAL_TITLE_ENV_NAME], '0');
  assert.equal(Object.hasOwn(userTerminalTitle, MANAGED_TERMINAL_TITLE_ENV_NAME), false);
  const restoredTerminalTitle = environmentWithoutGatewayCredentials({
    [MANAGED_TERMINAL_TITLE_ENV_NAME]: '1',
    [PREVIOUS_TERMINAL_TITLE_ENV_NAME]: '0',
    [PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME]: '1',
    [CLAUDE_TERMINAL_TITLE_ENV_NAME]: '1',
  });
  assert.equal(restoredTerminalTitle[CLAUDE_TERMINAL_TITLE_ENV_NAME], '0');
  assert.equal(Object.hasOwn(restoredTerminalTitle, MANAGED_TERMINAL_TITLE_ENV_NAME), false);
  assert.equal(Object.hasOwn(restoredTerminalTitle, PREVIOUS_TERMINAL_TITLE_ENV_NAME), false);
  assert.equal(
    Object.hasOwn(restoredTerminalTitle, PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME),
    false
  );
  const unmarkedTerminalTitle = environmentWithoutGatewayCredentials({
    [CLAUDE_TERMINAL_TITLE_ENV_NAME]: '1',
  });
  assert.equal(unmarkedTerminalTitle[CLAUDE_TERMINAL_TITLE_ENV_NAME], '1');

  const managedOverlay = environmentWithoutGatewayCredentials({
    [MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME]:
      'ANTHROPIC_BASE_URL CLAUDE_CODE_AUTO_COMPACT_WINDOW ANTHROPIC_MODEL',
    [MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME]:
      'ANTHROPIC_BASE_URL ANTHROPIC_MODEL',
    [PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME]:
      'ANTHROPIC_BASE_URL CLAUDE_CODE_AUTO_COMPACT_WINDOW ANTHROPIC_MODEL',
    [`${MANAGED_WORKFLOW_ENV_VALUE_PREFIX}ANTHROPIC_BASE_URL`]:
      'http://127.0.0.1:4318',
    [`${MANAGED_WORKFLOW_ENV_VALUE_PREFIX}ANTHROPIC_MODEL`]: 'codex',
    [`${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}ANTHROPIC_BASE_URL`]:
      'https://api.anthropic.com',
    [`${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}CLAUDE_CODE_AUTO_COMPACT_WINDOW`]:
      'user-window',
    [`${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}ANTHROPIC_MODEL`]: 'user-model',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4318',
    ANTHROPIC_MODEL: 'user-mutated-model',
    PRESERVED_VALUE: 'yes',
  });
  assert.equal(managedOverlay.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(managedOverlay.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 'user-window');
  assert.equal(managedOverlay.ANTHROPIC_MODEL, 'user-mutated-model');
  assert.equal(managedOverlay.PRESERVED_VALUE, 'yes');
  assert.equal(
    Object.keys(managedOverlay).some(
      (name) =>
        name.startsWith(MANAGED_WORKFLOW_ENV_VALUE_PREFIX) ||
        name.startsWith(PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX)
    ),
    false
  );

  const nativeChild = environmentWithoutGatewayAndAnthropicCredentials({
    ANTHROPIC_AUTH_TOKEN: 'user-auth-token',
    ANTHROPIC_API_KEY: 'user-api-key',
    ANTHROPIC_BETAS: 'unsupported-beta',
    ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: unsafe',
    PRESERVED_VALUE: 'yes',
  });
  assert.equal(Object.hasOwn(nativeChild, 'ANTHROPIC_AUTH_TOKEN'), false);
  assert.equal(Object.hasOwn(nativeChild, 'ANTHROPIC_API_KEY'), false);
  assert.equal(Object.hasOwn(nativeChild, 'ANTHROPIC_BETAS'), false);
  assert.equal(Object.hasOwn(nativeChild, 'ANTHROPIC_CUSTOM_HEADERS'), false);
  assert.equal(nativeChild.PRESERVED_VALUE, 'yes');
});

test(
  'shared workflow env clears only its own direct-Codex terminal-title setting',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-title-ownership-');
    const directPath = path.join(root, 'direct.env');
    const routedPath = path.join(root, 'routed.env');
    await fsp.writeFile(
      directPath,
      serializeWorkflowEnvironment({ [CLAUDE_TERMINAL_TITLE_ENV_NAME]: '1' })
    );
    await fsp.writeFile(routedPath, serializeWorkflowEnvironment({}));

    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          `unset ${CLAUDE_TERMINAL_TITLE_ENV_NAME} ${MANAGED_TERMINAL_TITLE_ENV_NAME} ${PREVIOUS_TERMINAL_TITLE_ENV_NAME} ${PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME}`,
          '. "$1"',
          `printf '%s|%s|%s|%s\\n' "\${${CLAUDE_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${MANAGED_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_ENV_NAME}-<unset>}"`,
          '. "$2"',
          `printf '%s|%s|%s|%s\\n' "\${${CLAUDE_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${MANAGED_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_ENV_NAME}-<unset>}"`,
          '. "$1"',
          `export ${CLAUDE_TERMINAL_TITLE_ENV_NAME}=user-choice`,
          '. "$2"',
          `printf '%s|%s|%s|%s\\n' "\${${CLAUDE_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${MANAGED_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_ENV_NAME}-<unset>}"`,
          `export ${CLAUDE_TERMINAL_TITLE_ENV_NAME}=1`,
          '. "$1"',
          '. "$2"',
          `printf '%s|%s|%s|%s\\n' "\${${CLAUDE_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${MANAGED_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_ENV_NAME}-<unset>}"`,
          `export ${CLAUDE_TERMINAL_TITLE_ENV_NAME}=0`,
          '. "$1"',
          '. "$2"',
          `printf '%s|%s|%s|%s\\n' "\${${CLAUDE_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${MANAGED_TERMINAL_TITLE_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME}-<unset>}" "\${${PREVIOUS_TERMINAL_TITLE_ENV_NAME}-<unset>}"`,
        ].join('\n'),
        '_',
        directPath,
        routedPath,
      ],
      { encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      '1|<unset>|<unset>|<unset>',
      '<unset>|<unset>|<unset>|<unset>',
      'user-choice|<unset>|<unset>|<unset>',
      '1|<unset>|<unset>|<unset>',
      '0|<unset>|<unset>|<unset>',
    ]);
  }
);

test(
  'shared workflow env restores the complete managed overlay in Bash and zsh',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-overlay-ownership-');
    const directPath = path.join(root, 'direct.env');
    const routedPath = path.join(root, 'routed.env');
    const cleanupPath = path.join(root, 'cleanup.env');
    const directEnvironment = serializeWorkflowEnvironment({
      ANTHROPIC_API_KEY: 'gateway-secret-one',
      ANTHROPIC_AUTH_TOKEN: 'gateway-secret-one',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4318',
      ANTHROPIC_MODEL: 'codex',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: null,
      [CLAUDE_TERMINAL_TITLE_ENV_NAME]: '1',
      EMPTY_MANAGED_VALUE: '',
      [MANAGED_GATEWAY_AUTH_ENV_NAME]: 'gateway-secret-one',
      NO_PROXY: 'gateway-one',
      no_proxy: 'gateway-one',
    });
    const routedEnvironment = serializeWorkflowEnvironment({
      ANTHROPIC_API_KEY: 'gateway-secret-two',
      ANTHROPIC_AUTH_TOKEN: 'gateway-secret-two',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4319',
      ANTHROPIC_MODEL: 'claude-fable-5[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      EMPTY_MANAGED_VALUE: null,
      [MANAGED_GATEWAY_AUTH_ENV_NAME]: 'gateway-secret-two',
      NO_PROXY: 'gateway-two',
      no_proxy: 'gateway-two',
    });
    await fsp.writeFile(directPath, directEnvironment);
    await fsp.writeFile(routedPath, routedEnvironment);
    await fsp.writeFile(cleanupPath, serializeWorkflowEnvironment({}));
    assert.equal(directEnvironment.includes('user-api-key'), false);
    assert.equal(directEnvironment.includes('user-auth-token'), false);

    const probe = [
      'export ANTHROPIC_API_KEY=user-api-key',
      'export ANTHROPIC_AUTH_TOKEN=user-auth-token',
      'export ANTHROPIC_BASE_URL=https://api.anthropic.com',
      'export ANTHROPIC_MODEL=user-model',
      'export CLAUDE_CODE_AUTO_COMPACT_WINDOW=user-window',
      `export ${CLAUDE_TERMINAL_TITLE_ENV_NAME}=0`,
      'export NO_PROXY=user-upper',
      'export no_proxy=user-lower',
      'unset EMPTY_MANAGED_VALUE',
      '. "$1"',
      'test "$ANTHROPIC_MODEL" = codex',
      'test -z "${CLAUDE_CODE_AUTO_COMPACT_WINDOW+x}"',
      `test "$${CLAUDE_TERMINAL_TITLE_ENV_NAME}" = 1`,
      `"$4" -e 'for (const name of ["${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}ANTHROPIC_API_KEY", "${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}ANTHROPIC_AUTH_TOKEN"]) { if (Object.hasOwn(process.env, name)) process.exit(1); }'`,
      '. "$2"',
      'test "$ANTHROPIC_MODEL" = "claude-fable-5[1m]"',
      'test "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" = 1000000',
      `test "$${CLAUDE_TERMINAL_TITLE_ENV_NAME}" = 0`,
      '. "$3"',
      `"$4" -e '${[
        'const internal = Object.keys(process.env).filter((name) =>',
        '  name.startsWith("CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_") ||',
        '  name.startsWith("CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_") ||',
        '  name === "CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES" ||',
        '  name === "CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES" ||',
        '  name === "CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES" ||',
        '  name === "CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_EXPORTED_NAMES"',
        ');',
        'process.stdout.write(JSON.stringify({',
        '  apiKey: process.env.ANTHROPIC_API_KEY,',
        '  authToken: process.env.ANTHROPIC_AUTH_TOKEN,',
        '  baseUrl: process.env.ANTHROPIC_BASE_URL,',
        '  model: process.env.ANTHROPIC_MODEL,',
        '  window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,',
        `  title: process.env.${CLAUDE_TERMINAL_TITLE_ENV_NAME},`,
        '  noProxy: process.env.NO_PROXY,',
        '  lowerNoProxy: process.env.no_proxy,',
        '  emptyManagedSet: Object.hasOwn(process.env, "EMPTY_MANAGED_VALUE"),',
        '  internal,',
        '}));',
      ].join(' ')}'`,
      'printf "\\n"',
      '. "$1"',
      'export ANTHROPIC_MODEL=user-mutated-model',
      '. "$3"',
      'printf "%s\\n" "$ANTHROPIC_MODEL"',
    ].join('\n');

    const shells = [{ command: 'bash', args: ['--noprofile', '--norc', '-c'] }];
    const zsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' });
    if (zsh.status === 0) {
      shells.push({ command: zsh.stdout.trim(), args: ['-f', '-c'] });
    }

    for (const shell of shells) {
      const result = spawnSync(
        shell.command,
        [...shell.args, probe, '_', directPath, routedPath, cleanupPath, process.execPath],
        { encoding: 'utf8' }
      );
      assert.equal(result.status, 0, `${shell.command}: ${result.stderr}`);
      const [restoredJson, mutatedModel] = result.stdout.trim().split('\n');
      assert.deepEqual(JSON.parse(restoredJson), {
        apiKey: 'user-api-key',
        authToken: 'user-auth-token',
        baseUrl: 'https://api.anthropic.com',
        model: 'user-model',
        window: 'user-window',
        title: '0',
        noProxy: 'user-upper',
        lowerNoProxy: 'user-lower',
        emptyManagedSet: false,
        internal: [],
      });
      assert.equal(mutatedModel, 'user-mutated-model');
    }
  }
);

test(
  'shared workflow env preserves export attributes and the allexport shell option',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-overlay-attributes-');
    const directPath = path.join(root, 'direct.env');
    const cleanupPath = path.join(root, 'cleanup.env');
    await fsp.writeFile(
      directPath,
      serializeWorkflowEnvironment({
        ANTHROPIC_API_KEY: 'gateway-secret',
        ANTHROPIC_AUTH_TOKEN: 'gateway-secret',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4318',
        ANTHROPIC_MODEL: 'codex',
        [MANAGED_GATEWAY_AUTH_ENV_NAME]: 'gateway-secret',
      })
    );
    await fsp.writeFile(cleanupPath, serializeWorkflowEnvironment({}));

    const probe = [
      'set -eu',
      '_claude_workflow_is_exported() {',
      '  case $- in *a*) _CLAUDE_WORKFLOW_TEST_RESTORE_ALLEXPORT=1; set +a ;; *) _CLAUDE_WORKFLOW_TEST_RESTORE_ALLEXPORT=0 ;; esac',
      '  _CLAUDE_WORKFLOW_TEST_DECLARATION="$(typeset -p "$1" 2>/dev/null)" || _CLAUDE_WORKFLOW_TEST_DECLARATION=""',
      '  _CLAUDE_WORKFLOW_TEST_EXPORTED=1',
      '  case "$_CLAUDE_WORKFLOW_TEST_DECLARATION" in',
      '    export\\ *) ;;',
      '    declare\\ *|typeset\\ *)',
      '      _CLAUDE_WORKFLOW_TEST_ATTRIBUTES="${_CLAUDE_WORKFLOW_TEST_DECLARATION#* }"',
      '      _CLAUDE_WORKFLOW_TEST_ATTRIBUTES="${_CLAUDE_WORKFLOW_TEST_ATTRIBUTES%% *}"',
      '      case "$_CLAUDE_WORKFLOW_TEST_ATTRIBUTES" in -*x*) ;; *) _CLAUDE_WORKFLOW_TEST_EXPORTED=0 ;; esac',
      '      ;;',
      '    *) _CLAUDE_WORKFLOW_TEST_EXPORTED=0 ;;',
      '  esac',
      '  _CLAUDE_WORKFLOW_TEST_RESULT=$_CLAUDE_WORKFLOW_TEST_EXPORTED',
      '  unset _CLAUDE_WORKFLOW_TEST_DECLARATION _CLAUDE_WORKFLOW_TEST_ATTRIBUTES _CLAUDE_WORKFLOW_TEST_EXPORTED',
      '  if [ "$_CLAUDE_WORKFLOW_TEST_RESTORE_ALLEXPORT" = 1 ]; then set -a; fi',
      '  unset _CLAUDE_WORKFLOW_TEST_RESTORE_ALLEXPORT',
      '  if [ "$_CLAUDE_WORKFLOW_TEST_RESULT" = 1 ]; then unset _CLAUDE_WORKFLOW_TEST_RESULT; return 0; fi',
      '  unset _CLAUDE_WORKFLOW_TEST_RESULT',
      '  return 1',
      '}',
      'ANTHROPIC_API_KEY=local-api-key',
      'ANTHROPIC_AUTH_TOKEN=local-auth-token',
      'ANTHROPIC_MODEL="x local model"',
      'export ANTHROPIC_BASE_URL=https://api.anthropic.com',
      'set -a',
      '. "$1"',
      'case $- in *a*) ;; *) exit 20 ;; esac',
      `"$3" -e 'for (const name of ["${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}ANTHROPIC_API_KEY", "${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}ANTHROPIC_AUTH_TOKEN", "${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}ANTHROPIC_MODEL"]) { if (Object.hasOwn(process.env, name)) process.exit(1); }'`,
      '. "$2"',
      'case $- in *a*) ;; *) exit 21 ;; esac',
      'test "$ANTHROPIC_API_KEY" = local-api-key',
      'test "$ANTHROPIC_AUTH_TOKEN" = local-auth-token',
      'test "$ANTHROPIC_MODEL" = "x local model"',
      'test "$ANTHROPIC_BASE_URL" = https://api.anthropic.com',
      'if _claude_workflow_is_exported ANTHROPIC_API_KEY; then exit 22; fi',
      'if _claude_workflow_is_exported ANTHROPIC_AUTH_TOKEN; then exit 23; fi',
      'if _claude_workflow_is_exported ANTHROPIC_MODEL; then exit 24; fi',
      'if ! _claude_workflow_is_exported ANTHROPIC_BASE_URL; then exit 25; fi',
      `"$3" -e '${[
        'const internal = Object.keys(process.env).filter((name) =>',
        '  name.startsWith("CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_") ||',
        '  name.startsWith("CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_") ||',
        '  name === "CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES" ||',
        '  name === "CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES" ||',
        '  name === "CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES" ||',
        '  name === "CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_EXPORTED_NAMES"',
        ');',
        'if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_MODEL) process.exit(1);',
        'if (process.env.ANTHROPIC_BASE_URL !== "https://api.anthropic.com") process.exit(2);',
        'if (internal.length !== 0) process.exit(3);',
      ].join(' ')}'`,
      '. "$1"',
      'export -n ANTHROPIC_MODEL 2>/dev/null || typeset -g +x ANTHROPIC_MODEL',
      '. "$2"',
      'test "$ANTHROPIC_MODEL" = codex',
      'if _claude_workflow_is_exported ANTHROPIC_MODEL; then exit 26; fi',
      'case $- in *a*) ;; *) exit 27 ;; esac',
      'unset -f _claude_workflow_is_exported 2>/dev/null || :',
    ].join('\n');

    const shells = [{ command: 'bash', args: ['--noprofile', '--norc', '-c'] }];
    const zsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' });
    if (zsh.status === 0) {
      shells.push({ command: zsh.stdout.trim(), args: ['-f', '-c'] });
    }

    for (const shell of shells) {
      const result = spawnSync(
        shell.command,
        [...shell.args, probe, '_', directPath, cleanupPath, process.execPath],
        { encoding: 'utf8' }
      );
      assert.equal(result.status, 0, `${shell.command}: ${result.stderr}`);
    }
  }
);

test(
  'shared workflow env preserves xtrace without tracing credential values',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-overlay-xtrace-');
    const directPath = path.join(root, 'direct.env');
    const cleanupPath = path.join(root, 'cleanup.env');
    const helperPath = path.join(root, 'cleanup-helper.env');
    const priorSecret = 'prior-shell-secret-xtrace-audit';
    const gatewaySecret = 'managed-gateway-secret-xtrace-audit';
    await fsp.writeFile(
      directPath,
      serializeWorkflowEnvironment({
        ANTHROPIC_API_KEY: gatewaySecret,
        ANTHROPIC_AUTH_TOKEN: gatewaySecret,
        ANTHROPIC_MODEL: 'codex',
        [MANAGED_GATEWAY_AUTH_ENV_NAME]: gatewaySecret,
      })
    );
    await fsp.writeFile(cleanupPath, serializeWorkflowEnvironment({}));
    await fsp.writeFile(helperPath, `${managedWorkflowEnvironmentCleanupShell()}\n`);

    const serializedProbe = [
      `ANTHROPIC_API_KEY=${priorSecret}`,
      'set -x',
      '. "$1"',
      'case $- in *x*) ;; *) exit 30 ;; esac',
      '. "$2"',
      'case $- in *x*) ;; *) exit 31 ;; esac',
      'set +x',
      `test "$ANTHROPIC_API_KEY" = ${priorSecret}`,
    ].join('\n');
    const helperProbe = [
      `ANTHROPIC_API_KEY=${gatewaySecret}`,
      `CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES=ANTHROPIC_API_KEY`,
      `CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES=ANTHROPIC_API_KEY`,
      `CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES=ANTHROPIC_API_KEY`,
      `CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_ANTHROPIC_API_KEY=${gatewaySecret}`,
      `CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_ANTHROPIC_API_KEY=${priorSecret}`,
      'export ANTHROPIC_API_KEY CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES',
      'export CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES',
      'export CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES',
      'export CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_ANTHROPIC_API_KEY',
      'set -x',
      '. "$1"',
      'case $- in *x*) ;; *) exit 32 ;; esac',
      'set +x',
      `test "$ANTHROPIC_API_KEY" = ${priorSecret}`,
    ].join('\n');

    const shells = [{ command: 'bash', args: ['--noprofile', '--norc', '-c'] }];
    const zsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' });
    if (zsh.status === 0) {
      shells.push({ command: zsh.stdout.trim(), args: ['-f', '-c'] });
    }

    for (const shell of shells) {
      for (const [probe, args] of [
        [serializedProbe, [directPath, cleanupPath]],
        [helperProbe, [helperPath]],
      ]) {
        const result = spawnSync(shell.command, [...shell.args, probe, '_', ...args], {
          encoding: 'utf8',
        });
        assert.equal(result.status, 0, `${shell.command}: ${result.stderr}`);
        assert.equal(result.stderr.includes(priorSecret), false, shell.command);
        assert.equal(result.stderr.includes(gatewaySecret), false, shell.command);
      }
    }
  }
);

test('documented user credential files are ignored by Git', async function () {
  const patterns = new Set(
    (await fsp.readFile(path.join(REPO_ROOT, '.gitignore'), 'utf8'))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  assert.equal(patterns.has('.claude-workflow.env'), true);
  assert.equal(patterns.has('.ultrathink.env'), true);
});

test('published shell hooks share the generated managed-overlay cleanup', async function () {
  const expected = managedWorkflowEnvironmentCleanupShell();
  for (const relativePath of [
    'scripts/claude-workflow-gateway.bashrc',
    'scripts/claude-workflow-daemon.sh',
  ]) {
    const source = await fsp.readFile(path.join(REPO_ROOT, relativePath), 'utf8');
    assert.equal(embeddedManagedEnvironmentCleanup(source), expected, relativePath);
  }
});

test(
  'user environment files must be private regular files',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-user-env-security-');
    const safe = path.join(root, 'safe.env');
    const shared = path.join(root, 'shared.env');
    const link = path.join(root, 'linked.env');
    await fsp.writeFile(safe, 'SAFE=value\n', { mode: 0o600 });
    await fsp.writeFile(shared, 'UNSAFE=value\n', { mode: 0o644 });
    await fsp.symlink(safe, link);

    assert.equal(assertSafeUserEnvironmentFile(path.join(root, 'missing.env')), false);
    assert.equal(assertSafeUserEnvironmentFile(safe), true);
    assert.throws(() => assertSafeUserEnvironmentFile(shared), /owner-only/u);
    assert.throws(() => assertSafeUserEnvironmentFile(link), /regular, non-symlink/u);
  }
);

test('workflow entrypoints ignore a repository .env unless the parent opts in', async function (t) {
  const root = await temporaryDirectory(t, 'claude-workflow-env-security-');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  await fsp.mkdir(project);
  await fsp.mkdir(home);
  await fsp.writeFile(
    path.join(project, '.env'),
    `${PROJECT_MARKER}=from-project\n${PROJECT_ENV_OPT_IN}=true\n`,
    'utf8'
  );

  for (const entrypoint of [
    '/usr/local/bin/claude-workflow',
    '/opt/app/js/cli/claude-workflow.js',
    '/usr/local/bin/claude-workflow-gateway',
    '/opt/app/js/cli/claude-workflow-daemon.js',
  ]) {
    assert.deepEqual(probeEnvironmentLoader(project, home, entrypoint), { marker: '' });
  }

  assert.deepEqual(
    probeEnvironmentLoader(project, home, '/usr/local/bin/claude-workflow', {
      [PROJECT_ENV_OPT_IN]: 'true',
    }),
    { marker: 'from-project' }
  );
  assert.deepEqual(probeEnvironmentLoader(project, home, '/opt/app/js/index.js'), {
    marker: 'from-project',
  });

  await fsp.writeFile(
    path.join(home, '.ultrathink.env'),
    `${PROJECT_MARKER}=from-legacy-home\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  await fsp.writeFile(
    path.join(home, '.claude-workflow.env'),
    `${PROJECT_MARKER}=from-workflow-home\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  assert.deepEqual(probeEnvironmentLoader(project, home, '/usr/local/bin/claude-workflow'), {
    marker: 'from-workflow-home',
  });
  assert.deepEqual(
    probeEnvironmentLoader(project, home, '/usr/local/bin/claude-workflow', {
      [PROJECT_MARKER]: 'from-parent',
    }),
    { marker: 'from-parent' }
  );
});

test(
  'workflow env files are shell-safe, atomic, and private',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shell-security-');
    const stateDirectory = path.join(root, 'state');
    const target = path.join(stateDirectory, 'gateway.env');
    const commandSubstitutionMarker = path.join(root, 'command-substitution-ran');
    const backtickMarker = path.join(root, 'backtick-ran');
    await fsp.mkdir(stateDirectory, { mode: 0o755 });
    await fsp.writeFile(target, 'stale=true\n', { mode: 0o644 });

    const dangerousValue =
      `literal ' quote $HOME $(touch ${commandSubstitutionMarker}) ` +
      `\`touch ${backtickMarker}\`\nsecond line`;
    assert.equal(quotePosixShellValue("a'b"), `'a'"'"'b'`);
    assert.throws(() => quotePosixShellValue('bad\0value'), /NUL/u);
    assert.throws(
      () => serializeWorkflowEnvironment({ 'BAD-NAME': 'value' }),
      /invalid workflow environment variable name/u
    );

    const writtenPath = writeWorkflowEnvironmentFile(target, {
      DANGEROUS_VALUE: dangerousValue,
      EMPTY_VALUE: '',
      REMOVED_VALUE: null,
      SIMPLE_VALUE: 'safe',
    });
    assert.equal(writtenPath, path.resolve(target));
    assert.equal((await fsp.stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await fsp.readdir(stateDirectory)).sort(),
      ['gateway.env'],
      'atomic writer must not leave temporary files behind'
    );

    const shellResult = spawnSync(
      'bash',
      [
        '-c',
        `export REMOVED_VALUE=stale; export ${MANAGED_GATEWAY_AUTH_ENV_NAME}=owned-token; export ANTHROPIC_AUTH_TOKEN=owned-token; export ANTHROPIC_API_KEY=user-key; . "$1"; "$2" -e 'process.stdout.write(JSON.stringify({ dangerous: process.env.DANGEROUS_VALUE, empty: process.env.EMPTY_VALUE, removed: process.env.REMOVED_VALUE || null, simple: process.env.SIMPLE_VALUE, marker: process.env.${MANAGED_GATEWAY_AUTH_ENV_NAME} || null, authToken: process.env.ANTHROPIC_AUTH_TOKEN || null, apiKey: process.env.ANTHROPIC_API_KEY || null }))'`,
        '_',
        target,
        process.execPath,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(shellResult.status, 0, shellResult.stderr);
    assert.deepEqual(JSON.parse(shellResult.stdout), {
      dangerous: dangerousValue,
      empty: '',
      removed: null,
      simple: 'safe',
      marker: null,
      authToken: null,
      apiKey: 'user-key',
    });
    assert.equal(fs.existsSync(commandSubstitutionMarker), false);
    assert.equal(fs.existsSync(backtickMarker), false);

    const failedPublishTarget = path.join(stateDirectory, 'failed-publish.env');
    const originalChmodSync = fs.chmodSync;
    fs.chmodSync = function failPublishedFileChmod(targetPath, mode) {
      if (path.resolve(targetPath) === path.resolve(failedPublishTarget)) {
        throw new Error('simulated chmod failure');
      }
      return originalChmodSync(targetPath, mode);
    };
    try {
      assert.throws(
        () => writeWorkflowEnvironmentFile(failedPublishTarget, { VALUE: 'safe' }),
        /simulated chmod failure/u
      );
    } finally {
      fs.chmodSync = originalChmodSync;
    }
    assert.equal(
      fs.existsSync(failedPublishTarget),
      false,
      'a post-rename hardening failure must remove the published env file'
    );

    const unsafeCustomDirectory = path.join(root, 'unsafe-custom-state');
    await fsp.mkdir(unsafeCustomDirectory, { mode: 0o755 });
    await fsp.chmod(unsafeCustomDirectory, 0o755);
    assert.throws(
      () =>
        writeWorkflowEnvironmentFile(
          path.join(unsafeCustomDirectory, 'gateway.env'),
          { VALUE: 'safe' },
          { hardenExistingDirectory: false }
        ),
      /must not be accessible by group or other users/u
    );
  }
);

test('managed daemon rejects an undiscoverable ephemeral port', { concurrency: false }, function () {
  const previous = process.env.ULTRATHINK_GATEWAY_DAEMON_PORT;
  process.env.ULTRATHINK_GATEWAY_DAEMON_PORT = '0';
  try {
    assert.throws(() => daemonPort(), /between 1 and 65535/u);
  } finally {
    if (previous === undefined) {
      delete process.env.ULTRATHINK_GATEWAY_DAEMON_PORT;
    } else {
      process.env.ULTRATHINK_GATEWAY_DAEMON_PORT = previous;
    }
  }
});

test(
  'gateway traces rotate within byte/count limits and harden filesystem modes',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'gateway-trace-security-');
    const traceDirectory = path.join(root, 'trace');
    const activeTrace = path.join(traceDirectory, 'gateway-trace.jsonl');
    await fsp.mkdir(traceDirectory, { mode: 0o700 });
    await fsp.writeFile(
      activeTrace,
      `${JSON.stringify({ ts: new Date().toISOString(), event: 'legacy' })}\n`,
      { mode: 0o644 }
    );

    const tracer = createGatewayTracer({
      traceDir: traceDirectory,
      traceMaxBytes: 1024,
      traceMaxFiles: 3,
    });
    for (let index = 0; index < 12; index += 1) {
      await tracer.log('security.rotation', {
        index,
        payload: `entry-${index}-${'x'.repeat(300)}`,
      });
    }
    await tracer.close();
    assert.equal(tracer.lastError, null);
    assert.equal((await fsp.stat(traceDirectory)).mode & 0o777, 0o700);

    const traceFiles = (await fsp.readdir(traceDirectory))
      .filter((name) => name.startsWith('gateway-trace.jsonl'))
      .sort();
    assert.ok(traceFiles.includes('gateway-trace.jsonl.1'), 'rotation should create a backup');
    assert.ok(traceFiles.length <= 3, `expected at most 3 trace files, got ${traceFiles}`);
    for (const name of traceFiles) {
      const filePath = path.join(traceDirectory, name);
      const stats = await fsp.stat(filePath);
      assert.equal(stats.mode & 0o777, 0o600, `${name} must be private`);
      assert.ok(stats.size <= 1024, `${name} exceeded the configured byte cap`);
      const lines = (await fsp.readFile(filePath, 'utf8')).trim().split('\n').filter(Boolean);
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `${name} contains a partial JSONL record`);
      }
    }
  }
);

test(
  'gateway tracing rejects an existing shared directory without changing its mode',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'gateway-trace-shared-directory-');
    const traceDirectory = path.join(root, 'shared');
    await fsp.mkdir(traceDirectory, { mode: 0o755 });
    await fsp.chmod(traceDirectory, 0o755);

    const tracer = createGatewayTracer({ traceDir: traceDirectory });
    await tracer.log('security.must-not-write');
    await tracer.close();

    assert.match(
      tracer.lastError?.message || '',
      /must not be accessible by group or other users/u
    );
    assert.equal((await fsp.stat(traceDirectory)).mode & 0o777, 0o755);
    assert.equal(fs.existsSync(path.join(traceDirectory, 'gateway-trace.jsonl')), false);
  }
);

test('an oversized trace event is replaced by a bounded metadata record', async function (t) {
  const root = await temporaryDirectory(t, 'gateway-trace-entry-security-');
  const tracer = createGatewayTracer({
    traceDir: root,
    traceMaxBytes: 512,
    traceMaxFiles: 1,
  });
  await tracer.log('security.oversized', { payload: 'x'.repeat(10_000) });
  await tracer.close();

  const traceText = await fsp.readFile(tracer.traceFilePath, 'utf8');
  assert.ok(Buffer.byteLength(traceText) <= 512);
  const entry = JSON.parse(traceText);
  assert.equal(entry.event, 'security.oversized');
  assert.equal(entry.trace_entry_truncated, true);
  assert.ok(entry.original_bytes > 10_000);
});

test('a trace queue recovers a lock abandoned by a killed writer', async function (t) {
  const root = await temporaryDirectory(t, 'gateway-trace-stale-lock-');
  const lockDirectory = path.join(root, '.gateway-trace.lock');
  await fsp.mkdir(lockDirectory, { mode: 0o700 });
  const staleTime = new Date(Date.now() - 31_000);
  await fsp.utimes(lockDirectory, staleTime, staleTime);

  const tracer = createGatewayTracer({
    traceDir: root,
    traceMaxBytes: 512,
    traceMaxFiles: 1,
  });
  await tracer.log('security.stale-lock-recovered');
  await tracer.close();

  assert.equal(tracer.lastError, null);
  assert.equal(fs.existsSync(lockDirectory), false);
  const entry = JSON.parse(await fsp.readFile(tracer.traceFilePath, 'utf8'));
  assert.equal(entry.event, 'security.stale-lock-recovered');
});

test('concurrent tracers coordinate rotation in one directory', async function (t) {
  const root = await temporaryDirectory(t, 'gateway-trace-concurrent-');
  const config = { traceDir: root, traceMaxBytes: 1024, traceMaxFiles: 3 };
  const first = createGatewayTracer(config);
  const second = createGatewayTracer(config);
  await Promise.all(
    Array.from({ length: 80 }, function writeEntry(_, index) {
      const tracer = index % 2 === 0 ? first : second;
      return tracer.log('security.concurrent', {
        index,
        payload: 'x'.repeat(180),
      });
    })
  );
  await Promise.all([first.close(), second.close()]);
  assert.equal(first.lastError, null);
  assert.equal(second.lastError, null);

  const traceFiles = (await fsp.readdir(root)).filter((name) =>
    name.startsWith('gateway-trace.jsonl')
  );
  assert.ok(traceFiles.length <= 3);
  for (const name of traceFiles) {
    const lines = (await fsp.readFile(path.join(root, name), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  }
});
