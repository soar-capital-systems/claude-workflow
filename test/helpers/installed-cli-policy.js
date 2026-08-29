import { spawnSync } from 'node:child_process';

const REQUIRED_ENV_NAME = 'CLAUDE_WORKFLOW_REQUIRE_INSTALLED_CLIS';
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isRequired(env) {
  return TRUE_VALUES.has(String(env?.[REQUIRED_ENV_NAME] || '').trim().toLowerCase());
}

function unavailableReason(displayName, command, result) {
  if (result.error) {
    const code = result.error.code ? ` (${result.error.code})` : '';
    return `${displayName} is unavailable: ${command} --version could not start${code}`;
  }
  const detail = String(result.stderr || result.stdout || '').trim();
  return `${displayName} is unavailable: ${command} --version exited ${String(result.status)}` +
    (detail ? `: ${detail}` : '');
}

export function installedCliPolicy({
  command,
  displayName,
  args = ['--version'],
  env = process.env,
  timeout = 5_000,
}) {
  if (!command || !displayName) {
    throw new TypeError('installedCliPolicy requires command and displayName');
  }

  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    timeout,
    windowsHide: true,
  });
  const available = !result.error && result.status === 0;
  const version = String(result.stdout || result.stderr || '').trim();
  const required = isRequired(env);
  const reason = available ? false : unavailableReason(displayName, command, result);

  if (required && !available) {
    throw new Error(
      `${reason}. ${REQUIRED_ENV_NAME}=1 requires installed CLI contract tests to run.`
    );
  }

  return Object.freeze({
    available,
    required,
    skip: reason,
    version,
  });
}

export const INSTALLED_CLI_REQUIRED_ENV_NAME = REQUIRED_ENV_NAME;
