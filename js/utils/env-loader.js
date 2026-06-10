/**
 * Centralized env loader (side-effect module).
 *
 * Loads, in order of decreasing precedence:
 *   1. Parent process env vars (always win; already set on process.env)
 *   2. Project .env in process.cwd()
 *   3. User-level defaults from ~/.claude-workflow.env
 *   4. Legacy user-level defaults from ~/.ultrathink.env
 *
 * dotenv's default behavior is "do not override existing keys", so calling
 * config() in this order naturally produces the precedence above.
 *
 * Import this module for its side effect from the universally-imported
 * config/constants.js so that every entry point (and every transitive
 * importer) sees a fully-resolved process.env before reading from it.
 */
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

dotenv.config();

for (const envFileName of ['.claude-workflow.env', '.ultrathink.env']) {
  const homeEnvPath = join(homedir(), envFileName);
  if (existsSync(homeEnvPath)) {
    dotenv.config({ path: homeEnvPath });
  }
}
