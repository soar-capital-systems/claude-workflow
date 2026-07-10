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
import { existsSync } from 'fs';
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

if (shouldLoadProjectEnv()) {
  dotenv.config();
}

for (const envFileName of ['.claude-workflow.env', '.ultrathink.env']) {
  const homeEnvPath = join(homedir(), envFileName);
  if (existsSync(homeEnvPath)) {
    dotenv.config({ path: homeEnvPath });
  }
}
