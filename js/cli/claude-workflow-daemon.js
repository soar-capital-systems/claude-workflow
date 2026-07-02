#!/usr/bin/env node

/**
 * Shared claude-workflow gateway daemon.
 *
 * Runs the same workflow-routing gateway the `claude-workflow` launcher
 * spawns per session, but on a fixed localhost port so that plain, resumed,
 * and background Claude Code sessions can route through it via exported env
 * (see scripts/claude-workflow-daemon.sh and scripts/claude-workflow-gateway.bashrc).
 * On listen it publishes the env exports to
 * ~/.cache/ultrathink/claude-workflow-gateway.env for shells to source.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { createGatewayServer } from '../gateway/server.js';
import {
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
  envString,
  routeTargetSummary,
} from '../gateway/workflow-config.js';

const DEFAULT_DAEMON_PORT = 4318;

function log(message) {
  process.stderr.write(`claude-workflow-gateway: ${message}\n`);
}

// The daemon deliberately has its own port variable: ULTRATHINK_GATEWAY_PORT
// belongs to the per-session launcher, and sharing it would make the two
// fight over one port (launcher EADDRINUSE, or the daemon health check
// probing a transient launcher gateway). Keep this default in sync with
// scripts/claude-workflow-daemon.sh.
function daemonPort() {
  const configured = envString('ULTRATHINK_GATEWAY_DAEMON_PORT');
  if (!configured) {
    return DEFAULT_DAEMON_PORT;
  }

  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(
      `ULTRATHINK_GATEWAY_DAEMON_PORT must be an integer between 0 and 65535, got ${configured}`
    );
  }

  return parsed;
}

function envFilePath() {
  return (
    envString('CLAUDE_WORKFLOW_GATEWAY_ENV_FILE') ||
    path.join(os.homedir(), '.cache', 'ultrathink', 'claude-workflow-gateway.env')
  );
}

function writeEnvFile(config, gatewayBaseUrl, subagentModelId) {
  const target = envFilePath();
  const clientEnv = buildWorkflowClientEnv(config, gatewayBaseUrl, subagentModelId);
  const lines = Object.entries(clientEnv).map(function toExport([key, value]) {
    return `export ${key}=${JSON.stringify(String(value))}`;
  });

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  return target;
}

async function main() {
  const { config, mainModelId, rawSubagentModelId, subagentModelId, subagentRoute } =
    buildWorkflowGatewayConfig({ port: daemonPort() });

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

main().catch(function onError(error) {
  log(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
