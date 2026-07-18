/**
 * Centralized env loader (side-effect module).
 *
 * Loads, in order of decreasing precedence:
 *   1. Parent process env vars (always win — already set on process.env)
 *   2. Project .env in process.cwd(), except for workflow launchers by default
 *   3. User-level defaults from ~/.claude-workflow.env
 *   4. Legacy user-level defaults from ~/.ultrathink.env
 *
 * dotenv's default behavior is "do not override existing keys", so calling
 * config() in this order naturally produces the precedence above.
 *
 * Import this module before gateway configuration is evaluated so every
 * entrypoint sees a fully resolved process.env.
 */
import dotenv from 'dotenv';
import { lstatSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

const PROJECT_ENV_OPT_IN = 'CLAUDE_WORKFLOW_LOAD_PROJECT_ENV';
const WORKFLOW_ENTRYPOINTS = new Set([
  'claude-workflow',
  'claude-workflow.js',
  'claude-workflow-daemon.js',
  'claude-workflow-gateway',
]);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isWorkflowEntrypoint(argv = process.argv) {
  const entrypoint = Array.isArray(argv) ? argv[1] : '';
  return typeof entrypoint === 'string' && WORKFLOW_ENTRYPOINTS.has(basename(entrypoint));
}

export function shouldLoadProjectEnv(argv = process.argv, env = process.env) {
  if (!isWorkflowEntrypoint(argv)) {
    return true;
  }

  // This value is read before dotenv touches the project. A repository cannot
  // opt itself in by placing the flag in its own .env file; the user must set
  // it in the parent process deliberately.
  const explicitOptIn = String(env?.[PROJECT_ENV_OPT_IN] || '')
    .trim()
    .toLowerCase();
  return TRUE_VALUES.has(explicitOptIn);
}

export function assertSafeUserEnvironmentFile(filePath) {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`user environment file must be a regular, non-symlink file: ${filePath}`);
  }
  if (
    typeof process.getuid === 'function' &&
    Number.isInteger(stats.uid) &&
    stats.uid !== process.getuid()
  ) {
    throw new Error(`user environment file must be owned by the current user: ${filePath}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `user environment file must be owner-only (run chmod 600): ${filePath}. ` +
        'On WSL, keep it in the Linux filesystem or enable DrvFS metadata.'
    );
  }
  return true;
}

if (shouldLoadProjectEnv()) {
  dotenv.config();
}

for (const envFileName of ['.claude-workflow.env', '.ultrathink.env']) {
  const homeEnvPath = join(homedir(), envFileName);
  if (assertSafeUserEnvironmentFile(homeEnvPath)) {
    dotenv.config({ path: homeEnvPath });
  }
}
