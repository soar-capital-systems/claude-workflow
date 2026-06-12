#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { envFlag, isGatewayLoopbackHost, loadGatewayConfig } from '../gateway/config.js';
import {
  ROUTE_ENTRY_REASONING_KEYS,
  ROUTE_ENTRY_UPSTREAM_MODEL_KEYS,
  resolveModelRoute,
  routeEntryValue,
} from '../gateway/model-routing.js';
import { proxyExclusionEnvForHost } from '../gateway/proxy.js';
import { createGatewayServer } from '../gateway/server.js';

const SIGNAL_NUMBERS = {
  SIGINT: 2,
  SIGTERM: 15,
};
const CODEX_LOGIN_STATUS_TIMEOUT_MS = 10_000;
const WORKFLOW_CODEX_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAIN_MODEL_ID = 'claude-fable-5[1m]';
const DEFAULT_FABLE_PASSTHROUGH_PATTERN = 'claude-fable-5*';
const CODEX_LOGIN_FAILURE_PATTERN =
  /not\s+logged\s+in|logged\s+out|not\s+authenticated|not\s+signed\s+in/u;
const CODEX_LOGIN_SUCCESS_PATTERN = /logged in|authenticated|signed in/u;
const CLAUDE_OPTIONAL_VALUE_FLAGS = new Set(['--resume', '-r', '--from-pr']);
const CLAUDE_REQUIRED_VALUE_FLAGS = new Set(['--session-id']);
const CLAUDE_SESSION_FLAGS = new Set([
  '--continue',
  '-c',
  '--fork-session',
  ...CLAUDE_OPTIONAL_VALUE_FLAGS,
  ...CLAUDE_REQUIRED_VALUE_FLAGS,
]);

function usage() {
  return [
    'Usage:',
    '  claude-workflow',
    '  claude-workflow "Use a workflow to delegate a tiny subagent task."',
    '  claude-workflow --resume <session-id>',
    '  claude-workflow --continue',
    '',
    'Behavior:',
    '  - no arguments: starts normal interactive Claude Code on the configured main/frontier model through a local gateway',
    '  - each launch uses an OS-assigned localhost port unless ULTRATHINK_GATEWAY_PORT is set',
    '  - Workflow subagents default to a Codex/GPT-labeled model id mapped to a Codex route',
    '  - routed subagent responses also report Codex/GPT metadata in Claude Code UI by default',
    '  - other non-frontier Claude model ids also route to Codex by default',
    '  - with prompt text: runs a one-shot "claude -p" prompt through the same gateway',
    '  - --resume, -r, --continue, -c, --fork-session, --from-pr, and --session-id pass through to interactive Claude',
    '  - interactive and one-shot launches default to --dangerously-skip-permissions auto mode',
    '  - --yolo and --dangerously-skip-permissions keep auto mode explicit',
    '  - --no-yolo or CLAUDE_WORKFLOW_SKIP_PERMISSIONS=false restores permission prompts',
    '',
    'Requirements:',
    '  - claude CLI on PATH',
    '  - codex CLI on PATH and already logged in (for Codex-backed routed models)',
    '  - Claude Code local auth or gateway-compatible Anthropic auth for Anthropic passthrough',
    '  - optional overrides can live in ~/.claude-workflow.env, ~/.ultrathink.env, or .env',
  ].join('\n');
}

function envString(name, fallback = '') {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  return value.trim();
}

function displayRoutedModel() {
  if (envString('CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL')) {
    return envFlag('CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL', true);
  }

  return envFlag('ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL', true);
}

function defaultAnthropicPassthroughPattern(mainModelId) {
  if (String(mainModelId || '').startsWith('claude-fable-5')) {
    return DEFAULT_FABLE_PASSTHROUGH_PATTERN;
  }

  return `${mainModelId}*`;
}

function shouldPrintStack() {
  return envFlag('CLAUDE_WORKFLOW_DEBUG', envFlag('ULTRATHINK_WORKFLOWS_DEBUG', false));
}

function printError(message) {
  process.stderr.write(`claude-workflow: ${message}\n`);
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      continue;
    }

    const normalized = value.trim();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function modelIdPart(value) {
  if (typeof value !== 'string') {
    return 'model';
  }

  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');

  return normalized || 'model';
}

function routeProvider(route, fallback = 'codex') {
  return routeEntryValue(route, ['provider'], fallback);
}

function routeUpstreamModel(route, fallback) {
  return routeEntryValue(route, ROUTE_ENTRY_UPSTREAM_MODEL_KEYS, fallback);
}

function routeReasoningEffort(route, fallback = '') {
  return routeEntryValue(route, ROUTE_ENTRY_REASONING_KEYS, fallback);
}

function routedModelId(provider, upstreamModel, reasoningEffort, requestedModel) {
  const effort = reasoningEffort ? `-${modelIdPart(reasoningEffort)}` : '';
  return [
    `${modelIdPart(provider)}-${modelIdPart(upstreamModel)}${effort}`,
    modelIdPart(requestedModel),
  ].join('-via-');
}

function routeTargetSummary(route) {
  const provider = routeProvider(route);
  if (provider === 'anthropic') {
    return 'anthropic';
  }

  const model = routeUpstreamModel(route, 'default');
  const effort = routeReasoningEffort(route);
  return `${provider}:${model}${effort ? `/${effort}` : ''}`;
}

function isExecutableCommand(commandName) {
  if (path.isAbsolute(commandName) || commandName.includes(path.sep)) {
    try {
      fs.accessSync(commandName, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathValue = process.env.PATH || '';
  for (const candidate of pathValue.split(path.delimiter)) {
    if (!candidate) {
      continue;
    }

    try {
      fs.accessSync(path.join(candidate, commandName), fs.constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

function codexLoginReady(commandName) {
  const result = spawnSync(commandName, ['login', 'status'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: CODEX_LOGIN_STATUS_TIMEOUT_MS,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.toLowerCase();

  return (
    result.status === 0 &&
    !result.error &&
    !CODEX_LOGIN_FAILURE_PATTERN.test(output) &&
    CODEX_LOGIN_SUCCESS_PATTERN.test(output)
  );
}

function parseRequestedPort() {
  const configuredPort = envString('ULTRATHINK_GATEWAY_PORT');
  if (!configuredPort) {
    return 0;
  }

  const parsed = Number(configuredPort);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(
      `ULTRATHINK_GATEWAY_PORT must be an integer between 0 and 65535, got ${configuredPort}`
    );
  }

  return parsed;
}

function describeGatewayListenError(error, config) {
  if (error?.code === 'EADDRINUSE') {
    return new Error(
      `gateway port ${config.port} is already in use on ${config.host}. ` +
        'Unset ULTRATHINK_GATEWAY_PORT or set it to 0 so each claude-workflow instance gets its own free localhost port.'
    );
  }

  if (error?.code === 'EACCES') {
    return new Error(
      `gateway cannot bind ${config.host}:${config.port}; choose an unprivileged port or unset ULTRATHINK_GATEWAY_PORT.`
    );
  }

  return error;
}

function parseCliArgs(rawArgs) {
  const claudeArgs = [];
  const promptArgs = [];
  let skipPermissions = envFlag(
    'CLAUDE_WORKFLOW_SKIP_PERMISSIONS',
    envFlag('ULTRATHINK_WORKFLOWS_SKIP_PERMISSIONS', true)
  );
  let passthrough = false;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (passthrough) {
      promptArgs.push(arg);
      continue;
    }

    if (arg === '--') {
      passthrough = true;
      continue;
    }

    if (arg === '--yolo' || arg === '--dangerously-skip-permissions') {
      skipPermissions = true;
      continue;
    }

    if (arg === '--no-yolo') {
      skipPermissions = false;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const flagName = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    if (CLAUDE_SESSION_FLAGS.has(flagName)) {
      claudeArgs.push(arg);
      if (
        equalsIndex < 0 &&
        (CLAUDE_REQUIRED_VALUE_FLAGS.has(flagName) ||
          (CLAUDE_OPTIONAL_VALUE_FLAGS.has(flagName) && !rawArgs[index + 1]?.startsWith('-')))
      ) {
        const value = rawArgs[index + 1];
        if (typeof value === 'string') {
          claudeArgs.push(value);
          index += 1;
        }
      }
      continue;
    }

    promptArgs.push(arg);
  }

  return {
    claudeArgs,
    promptArgs,
    skipPermissions,
  };
}

function isHelpRequest(rawArgs) {
  return rawArgs.length === 1 && (rawArgs[0] === '--help' || rawArgs[0] === '-h');
}

function buildGatewayConfig() {
  const baseConfig = loadGatewayConfig();
  const mainModelId = envString('ULTRATHINK_GATEWAY_MAIN_MODEL_ID', DEFAULT_MAIN_MODEL_ID);
  const rawSubagentModelId = envString(
    'ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID',
    'claude-sonnet-4-7'
  );
  const subagentUpstreamModel = envString(
    'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL',
    baseConfig.codex.model
  );
  const subagentReasoningEffort = envString(
    'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT',
    'medium'
  );
  const subagentVerbosity = envString('ULTRATHINK_GATEWAY_SUBAGENT_VERBOSITY', 'high');
  const defaultMainRoute = {
    provider: 'anthropic',
    model: mainModelId,
    displayName: 'Claude Workflow Frontier Route',
  };
  const defaultSubagentRoute = {
    provider: 'codex',
    model: subagentUpstreamModel,
    reasoningEffort: subagentReasoningEffort,
    verbosity: subagentVerbosity,
    displayName: 'Codex Subagent Route',
  };
  const baseRouteMap = baseConfig.routeMap || {};
  const subagentRoute = baseRouteMap[rawSubagentModelId] || defaultSubagentRoute;
  const displayModels = displayRoutedModel();
  const subagentModelId = displayModels
    ? envString(
        'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID',
        routedModelId(
          routeProvider(subagentRoute),
          routeUpstreamModel(subagentRoute, subagentUpstreamModel),
          routeReasoningEffort(subagentRoute, subagentReasoningEffort),
          rawSubagentModelId
        )
      )
    : rawSubagentModelId;
  const routeMap = {
    [rawSubagentModelId]: defaultSubagentRoute,
    [subagentModelId]: subagentRoute,
    [mainModelId]: defaultMainRoute,
    ...baseRouteMap,
  };
  // Keep only the frontier main model family on Anthropic. Every other Claude id
  // (Opus, Sonnet, Haiku, ...) falls through to the Codex gpt-5.5 route unless
  // the operator pins their own passthrough list. Frontier dated variants
  // (e.g. claude-fable-5[1m]-20260601) stay on Anthropic via the trailing wildcard.
  const passthroughEnvProvided =
    envString('ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS') !== '' ||
    envString('ULTRATHINK_GATEWAY_PASSTHROUGH_MODEL_IDS') !== '';
  const anthropicPassthroughModels = passthroughEnvProvided
    ? baseConfig.anthropicPassthroughModels
    : [defaultAnthropicPassthroughPattern(mainModelId)];

  return {
    config: {
      ...baseConfig,
      host: envString('ULTRATHINK_GATEWAY_HOST', baseConfig.host || '127.0.0.1'),
      port: parseRequestedPort(),
      displayRoutedModel: displayModels,
      routeMap,
      anthropicPassthroughModels,
      codex: {
        ...baseConfig.codex,
        idleTimeoutMs: envString('ULTRATHINK_GATEWAY_CODEX_IDLE_TIMEOUT_MS')
          ? baseConfig.codex.idleTimeoutMs
          : WORKFLOW_CODEX_IDLE_TIMEOUT_MS,
      },
      exposedModels: dedupeStrings([
        mainModelId,
        rawSubagentModelId,
        subagentModelId,
        ...(baseConfig.exposedModels || []),
      ]),
    },
    mainModelId,
    subagentModelId,
    rawSubagentModelId,
    subagentRoute,
  };
}

function waitForServer(server) {
  if (server.listening) {
    return Promise.resolve();
  }

  return new Promise(function wait(resolve, reject) {
    function cleanup() {
      server.off('listening', onListening);
      server.off('error', onError);
    }

    function onListening() {
      cleanup();
      resolve();
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function resolvedGatewayPort(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Gateway did not expose a TCP port');
  }
  return address.port;
}

function buildClaudeEnvironment(config, gatewayBaseUrl, subagentModelId) {
  const claudeEnv = {
    ...proxyExclusionEnvForHost(config.host),
    ANTHROPIC_BASE_URL: gatewayBaseUrl,
    CLAUDE_CODE_SUBAGENT_MODEL: subagentModelId,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: envString(
      'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
      '0'
    ),
  };

  if (config.sharedSecret) {
    claudeEnv.ANTHROPIC_AUTH_TOKEN = config.sharedSecret;
    claudeEnv.ANTHROPIC_API_KEY = config.sharedSecret;
  }

  return claudeEnv;
}

function buildClaudeArgs(mainModelId, claudeArgs, promptArgs, skipPermissions) {
  if (claudeArgs.length > 0 || promptArgs.length === 0) {
    const nextArgs = ['--model', mainModelId, ...claudeArgs, ...promptArgs];
    if (skipPermissions) {
      nextArgs.unshift('--dangerously-skip-permissions');
    }
    return nextArgs;
  }

  const nextArgs = ['-p', '--model', mainModelId, promptArgs.join(' ')];
  if (skipPermissions) {
    nextArgs.splice(1, 0, '--dangerously-skip-permissions');
  }
  return nextArgs;
}

function assertPreflight(config, mainRoute) {
  if (!isGatewayLoopbackHost(config.host) && !config.sharedSecret) {
    throw new Error(
      `ULTRATHINK_GATEWAY_HOST=${config.host} is not loopback. Set ULTRATHINK_GATEWAY_SHARED_SECRET for non-local binds, or use 127.0.0.1 for local workflow launches.`
    );
  }

  const requiredCommands = [
    { command: 'claude', error: 'claude CLI not found on PATH' },
    {
      command: config.codex.command,
      error: `${config.codex.command} not found or not executable`,
    },
  ];

  for (const requirement of requiredCommands) {
    if (!isExecutableCommand(requirement.command)) {
      throw new Error(requirement.error);
    }
  }

  if (!codexLoginReady(config.codex.command)) {
    throw new Error(
      `${config.codex.command} is not logged in. Run \`${config.codex.command} login\` first.`
    );
  }

  if (config.sharedSecret && mainRoute.provider === 'anthropic' && !config.anthropic.apiKey) {
    throw new Error(
      'ULTRATHINK_GATEWAY_SHARED_SECRET is set, so the gateway cannot forward Claude OAuth upstream for Anthropic passthrough. Set ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) on the gateway, or unset ULTRATHINK_GATEWAY_SHARED_SECRET for local OAuth usage.'
    );
  }
}

function signalExitCode(signal) {
  return 128 + (SIGNAL_NUMBERS[signal] || 0);
}

function runClaude(args, extraEnv, onChild = null) {
  return new Promise(function run(resolve, reject) {
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: 'inherit',
    });

    onChild?.(child);
    child.on('error', reject);
    child.on('close', function onClose(code, signal) {
      if (signal) {
        resolve(signalExitCode(signal));
        return;
      }

      resolve(code ?? 0);
    });
  });
}

async function closeGateway(runtime) {
  if (!runtime) {
    return;
  }

  try {
    await runtime.close();
  } catch {
    // Best-effort cleanup only.
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { claudeArgs, promptArgs, skipPermissions } = parseCliArgs(rawArgs);

  if (isHelpRequest(rawArgs)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { config, mainModelId, rawSubagentModelId, subagentModelId, subagentRoute } =
    buildGatewayConfig();
  const mainRoute = resolveModelRoute(mainModelId, config);
  // Fail fast on launcher-managed subagent routes before starting Claude.
  resolveModelRoute(rawSubagentModelId, config);
  if (subagentModelId !== rawSubagentModelId) {
    resolveModelRoute(subagentModelId, config);
  }
  assertPreflight(config, mainRoute);

  let runtime = null;
  let claudeChild = null;
  let signalCleanup = null;
  try {
    runtime = createGatewayServer(config);
    try {
      await waitForServer(runtime.server);
    } catch (error) {
      throw describeGatewayListenError(error, config);
    }
    runtime.server.on('error', function onRuntimeServerError(error) {
      printError(`gateway server error: ${error.message}`);
    });

    signalCleanup = installSignalHandlers(
      function currentRuntime() {
        return runtime;
      },
      function currentClaudeChild() {
        return claudeChild;
      }
    );

    const gatewayBaseUrl = `http://${config.host}:${resolvedGatewayPort(runtime.server)}`;
    process.stderr.write(`claude-workflow: gateway ready at ${gatewayBaseUrl}\n`);
    process.stderr.write(`claude-workflow: main model ${mainModelId}\n`);
    process.stderr.write(`claude-workflow: subagent model ${subagentModelId}\n`);
    if (subagentModelId !== rawSubagentModelId) {
      process.stderr.write(
        `claude-workflow: subagent route ${rawSubagentModelId} -> ${routeTargetSummary(subagentRoute)}\n`
      );
    }

    const exitCode = await runClaude(
      buildClaudeArgs(mainModelId, claudeArgs, promptArgs, skipPermissions),
      buildClaudeEnvironment(config, gatewayBaseUrl, subagentModelId),
      function onChild(child) {
        claudeChild = child;
      }
    );
    process.exitCode = exitCode;
  } finally {
    signalCleanup?.();
    await closeGateway(runtime);
  }
}

function installSignalHandlers(runtimeProvider, childProvider) {
  let shuttingDown = false;

  function handleSignal(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const child = childProvider();
    if (child && !child.killed) {
      child.kill(signal);
    }

    closeGateway(runtimeProvider()).finally(function exitAfterCleanup() {
      process.exit(signalExitCode(signal));
    });
  }

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  return function removeSignalHandlers() {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  };
}

main().catch(function onError(error) {
  printError(error.message);
  if (shouldPrintStack() && error?.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
