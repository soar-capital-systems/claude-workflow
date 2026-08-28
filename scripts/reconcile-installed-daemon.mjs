#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { environmentWithoutManagedGatewayAuth } from '../js/utils/child-env.js';
import {
  isWsl,
  validateLocalInstall,
} from './validate-local-install.mjs';

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  process.exit(0);
}

const explicitReconcile =
  process.env.CLAUDE_WORKFLOW_RECONCILE_INSTALL === '1';
if (!explicitReconcile) {
  process.exit(0);
}

function environmentWithoutNpmLifecyclePath(env) {
  if (!env.npm_lifecycle_event || typeof env.PATH !== 'string') {
    return env;
  }

  return {
    ...env,
    PATH: env.PATH
      .split(path.delimiter)
      .filter(
        (entry) =>
          !/(?:^|[/\\])node_modules[/\\]\.bin$/u.test(entry) &&
          !/(?:^|[/\\])@npmcli[/\\]run-script[/\\]lib[/\\]node-gyp-bin$/u.test(entry)
      )
      .join(path.delimiter),
  };
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
if (isWsl(process.env)) {
  const packageRoot = path.dirname(scriptDirectory);
  const homeDirectory = process.env.HOME || process.env.USERPROFILE || '';
  const stateHome =
    process.env.XDG_STATE_HOME ||
    (homeDirectory ? path.join(homeDirectory, '.cache') : '');
  const unsafe = validateLocalInstall({
    env: process.env,
    candidates: [
      ['Installed package', packageRoot],
      ['Node.js', process.execPath],
      ['npm global prefix', process.env.npm_config_prefix || ''],
      ['npm cache', process.env.npm_config_cache || ''],
      ['Home directory', homeDirectory],
      [
        'Shared gateway state',
        process.env.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR ||
          (stateHome ? path.join(stateHome, 'claude-workflow') : ''),
      ],
    ],
  });
  if (unsafe.length !== 0) {
    const details = unsafe
      .map(({ label, path: unsafePath, mountPoint }) =>
        `${label}: ${unsafePath}${mountPoint ? ` (DrvFS mount ${mountPoint})` : ''}`
      )
      .join('\n  - ');
    console.error(
      'claude-workflow-gateway: refusing installation maintenance from Windows-mounted WSL storage.\n' +
        `  - ${details}\n` +
        'Install under /home/<user> with Linux-native Node.js/npm.'
    );
    process.exit(1);
  }
}
const manager = path.join(scriptDirectory, 'claude-workflow-daemon.sh');
const cleanDaemonEnvironment = environmentWithoutManagedGatewayAuth(
  environmentWithoutNpmLifecyclePath(process.env)
);
for (const action of ['migrate-shell-upgrade', 'reconcile']) {
  const result = spawnSync('bash', [manager, action], {
    env: action === 'reconcile' ? cleanDaemonEnvironment : process.env,
    stdio: 'inherit',
  });

  if (result.error?.code === 'ENOENT') {
    console.warn(
      'claude-workflow-gateway: bash is unavailable; skipped shell migration and daemon reconciliation'
    );
    process.exit(0);
  }
  if (result.error) {
    console.error(
      `claude-workflow-gateway: installation maintenance ${action} failed: ${result.error.message}`
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.exit(0);
