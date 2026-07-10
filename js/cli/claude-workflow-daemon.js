#!/usr/bin/env node

/**
 * Shared claude-workflow gateway daemon.
 *
 * Runs the same workflow-routing gateway the `claude-workflow` launcher
 * spawns per session, but on a fixed localhost port so that plain, resumed,
 * and background Claude Code sessions can route through it via exported env
 * (see scripts/claude-workflow-daemon.sh and scripts/claude-workflow-gateway.bashrc).
 * On listen it publishes the env exports to
 * ${XDG_STATE_HOME:-~/.cache}/claude-workflow/claude-workflow-gateway.env
 * for shells to source.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createGatewayServer } from '../gateway/server.js';
import {
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
  envString,
  routeTargetSummary,
} from '../gateway/workflow-config.js';

const DEFAULT_DAEMON_PORT = 4318;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function log(message) {
  process.stderr.write(`claude-workflow-gateway: ${message}\n`);
}

// The daemon deliberately has its own port variable: ULTRATHINK_GATEWAY_PORT
// belongs to the per-session launcher, and sharing it would make the two
// fight over one port (launcher EADDRINUSE, or the daemon health check
// probing a transient launcher gateway). Keep this default in sync with
// scripts/claude-workflow-daemon.sh.
export function daemonPort() {
  const configured = envString('ULTRATHINK_GATEWAY_DAEMON_PORT');
  if (!configured) {
    return DEFAULT_DAEMON_PORT;
  }

  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `ULTRATHINK_GATEWAY_DAEMON_PORT must be an integer between 1 and 65535, got ${configured}`
    );
  }

  return parsed;
}

function envFilePath() {
  const configuredTarget = envString('CLAUDE_WORKFLOW_GATEWAY_ENV_FILE');
  if (configuredTarget) {
    if (!path.isAbsolute(configuredTarget)) {
      throw new Error('CLAUDE_WORKFLOW_GATEWAY_ENV_FILE must be an absolute path');
    }
    return configuredTarget;
  }

  const stateHome = envString('XDG_STATE_HOME') || path.join(os.homedir(), '.cache');
  if (!path.isAbsolute(stateHome)) {
    throw new Error('XDG_STATE_HOME must be an absolute path');
  }
  return path.join(stateHome, 'claude-workflow', 'claude-workflow-gateway.env');
}

export function quotePosixShellValue(value) {
  const text = String(value);
  if (text.includes('\0')) {
    throw new Error('workflow environment values must not contain NUL bytes');
  }

  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function serializeWorkflowEnvironment(clientEnv) {
  return `${Object.entries(clientEnv)
    .map(function toExport([key, value]) {
      if (!ENV_KEY_PATTERN.test(key)) {
        throw new Error(`invalid workflow environment variable name: ${key}`);
      }
      return `export ${key}=${quotePosixShellValue(value)}`;
    })
    .join('\n')}\n`;
}

function ensureEnvironmentDirectory(directory, hardenExistingDirectory) {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`workflow environment directory must be a real directory: ${directory}`);
  }
  if (!existed || hardenExistingDirectory) {
    fs.chmodSync(directory, 0o700);
    stats = fs.lstatSync(directory);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(
        `workflow environment directory does not enforce owner-only permissions: ${directory}. ` +
          'On WSL, use the Linux filesystem or enable DrvFS metadata.'
      );
    }
  } else if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `custom workflow environment directory must not be accessible by group or other users: ${directory}`
    );
  }
}

export function writeWorkflowEnvironmentFile(
  targetPath,
  clientEnv,
  { hardenExistingDirectory = true } = {}
) {
  const target = path.resolve(targetPath);
  const directory = path.dirname(target);
  ensureEnvironmentDirectory(directory, hardenExistingDirectory);

  const tempPath = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor = null;
  let published = false;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, serializeWorkflowEnvironment(clientEnv), 'utf8');
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, target);
    published = true;
    fs.chmodSync(target, 0o600);
    const targetStats = fs.lstatSync(target);
    if (!targetStats.isFile() || targetStats.isSymbolicLink() || (targetStats.mode & 0o077) !== 0) {
      throw new Error(
        `workflow environment file does not enforce owner-only permissions: ${target}. ` +
          'On WSL, use the Linux filesystem or enable DrvFS metadata.'
      );
    }
    return target;
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(published ? target : tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        // Preserve the original write error.
      }
    }
    throw error;
  }
}

function writeEnvFile(config, gatewayBaseUrl, subagentModelId) {
  const configuredTarget = envString('CLAUDE_WORKFLOW_GATEWAY_ENV_FILE');
  const target = envFilePath();
  const clientEnv = buildWorkflowClientEnv(config, gatewayBaseUrl, subagentModelId);
  return writeWorkflowEnvironmentFile(target, clientEnv, {
    // The default cache directory belongs exclusively to this daemon. An
    // explicit custom path may live in a broader user-managed directory, so
    // do not silently chmod that existing directory.
    hardenExistingDirectory: !configuredTarget,
  });
}

async function main() {
  const { config, mainModelId, rawSubagentModelId, subagentModelId, subagentRoute } =
    buildWorkflowGatewayConfig({
      port: daemonPort(),
      host: '127.0.0.1',
      dynamicToolsOnly: true,
    });

  const runtime = createGatewayServer(config);

  runtime.server.on('error', function onServerError(error) {
    if (error?.code === 'EADDRINUSE') {
      log(
        `port ${config.port} is already in use — another daemon instance or service holds it. ` +
          'Check scripts/claude-workflow-daemon.sh status, or set ULTRATHINK_GATEWAY_DAEMON_PORT.'
      );
    } else {
      log(`fatal server error: ${error.stack || error.message}`);
    }
    process.exitCode = 1;
  });

  runtime.server.on('listening', function onListening() {
    const address = runtime.server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const gatewayBaseUrl = `http://${config.host}:${port}`;
    log(`listening at ${gatewayBaseUrl}`);
    log(`main model ${mainModelId} (anthropic passthrough: ${config.anthropicPassthroughModels.join(', ')})`);
    log(`subagent model ${subagentModelId}`);
    if (subagentModelId !== rawSubagentModelId) {
      log(`subagent route ${rawSubagentModelId} -> ${routeTargetSummary(subagentRoute)}`);
    }

    try {
      const target = writeEnvFile(config, gatewayBaseUrl, subagentModelId);
      log(`env exports written to ${target}`);
    } catch (error) {
      // The env file is the daemon's contract with shell sessions; serving
      // while it is missing would silently strand every plain session on
      // direct Anthropic. Fail loudly instead.
      log(`could not write env file: ${error.stack || error.message}`);
      void runtime.close().finally(function exitAfterCleanup() {
        process.exit(1);
      });
    }
  });

  async function closeAndExit(signal) {
    log(`received ${signal}, shutting down`);
    try {
      await runtime.close();
    } catch {
      // Best-effort cleanup only.
    }
    process.exit(0);
  }

  process.on('SIGINT', function onSigint() {
    void closeAndExit('SIGINT');
  });
  process.on('SIGTERM', function onSigterm() {
    void closeAndExit('SIGTERM');
  });
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  main().catch(function onError(error) {
    log(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
