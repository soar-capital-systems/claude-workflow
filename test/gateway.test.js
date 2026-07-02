#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { translateAnthropicMessagesRequestWithOptions } from '../js/gateway/anthropic-format.js';
import { loadGatewayConfig } from '../js/gateway/config.js';
import { buildCodexDynamicToolRegistry, CodexSessionManager } from '../js/gateway/codex-provider.js';
import { GatewayError, resolveModelRoute } from '../js/gateway/model-routing.js';
import {
  noProxyMatchesUrl,
  proxyExclusionEnvForHost,
  proxyUrlForTarget,
} from '../js/gateway/proxy.js';
import {
  createGatewayApp,
  createGatewayServer,
  summarizeRequestBody,
  summarizeGatewayTraceContext,
  withAbortSignal,
  writeSseEvent,
} from '../js/gateway/server.js';
import { assert, ok, runTest } from './lifecycle/_helpers.js';

function sleep(ms) {
  return new Promise(function wait(resolve) {
    setTimeout(resolve, ms);
  });
}

async function freePort() {
  return new Promise(function resolvePort(resolve, reject) {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function onListen() {
      const address = server.address();
      server.close(function onClose() {
        resolve(address.port);
      });
    });
  });
}

async function waitForListening(server) {
  if (server.listening) {
    return;
  }

  await new Promise(function resolveListen(resolve, reject) {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function closeServer(server) {
  await new Promise(function close(resolve) {
    server.close(resolve);
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function jsonHeaders(extraHeaders = {}) {
  return {
    'content-type': 'application/json',
    ...extraHeaders,
  };
}

async function makeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

async function makeCodexLoginStatusCommand(filePath, statusText = 'Logged in', exitCode = 0) {
  await makeExecutable(
    filePath,
    '#!/bin/bash\n' +
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then\n' +
      `  echo ${JSON.stringify(statusText)}\n` +
      `  exit ${exitCode}\n` +
      'fi\n' +
      'exit 0\n'
  );
}

async function makeClaudeShouldNotRunCommand(filePath) {
  await makeExecutable(
    filePath,
    '#!/bin/bash\n' +
      'echo "CLAUDE SHOULD NOT RUN" >&2\n' +
      'exit 99\n'
  );
}

async function runProcess(command, args, env, options = {}) {
  return new Promise(function wait(resolve, reject) {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', function onStdout(chunk) {
      stdout += chunk.toString();
    });
    child.stderr.on('data', function onStderr(chunk) {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', function onClose(code, signal) {
      let exitCode = code ?? 0;
      if (signal) {
        exitCode = 128;
      }

      resolve({
        code: exitCode,
        stdout,
        stderr,
      });
    });
  });
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await sleep(25);
    }
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }
    await sleep(25);
  }

  throw new Error(`Timed out waiting for process ${String(pid)} to exit`);
}

function parseSsePayloads(text) {
  return text
    .split(/\r?\n\r?\n/u)
    .map(function trimEvent(eventText) {
      return eventText.trim();
    })
    .filter(Boolean)
    .map(function parseEvent(eventText) {
      const event = {
        name: '',
        payload: null,
      };

      for (const line of eventText.split(/\r?\n/u)) {
        if (line.startsWith('event: ')) {
          event.name = line.slice('event: '.length);
          continue;
        }
        if (line.startsWith('data: ')) {
          const data = line.slice('data: '.length);
          if (data === '[DONE]') {
            event.payload = '[DONE]';
          } else {
            event.payload = JSON.parse(data);
          }
        }
      }

      return event;
    });
}

const CODEX_REQUEST_MODEL = 'claude-sonnet-4-7';
const CODEX_UPSTREAM_MODEL = 'gpt-5.5';
const WORKFLOW_DISPLAY_SUBAGENT_MODEL = 'codex-gpt-5.5-medium-via-claude-sonnet-4-7';
const CLEAN_PROXY_ENV = Object.freeze({
  HTTP_PROXY: '',
  http_proxy: '',
  HTTPS_PROXY: '',
  https_proxy: '',
  ALL_PROXY: '',
  all_proxy: '',
  NO_PROXY: '',
  no_proxy: '',
});
const CLEAN_WORKFLOW_ENV = Object.freeze({
  CLAUDE_WORKFLOW_MAIN_PROVIDER: '',
  CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID: '',
  DEEPSEEK_API_KEY: '',
  DEEPSEEK_BASE_URL: '',
  DEEPSEEK_DEFAULT_MODEL_ID: '',
  ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: '',
  ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY: '',
  ULTRATHINK_GATEWAY_DEEPSEEK_BASE_URL: '',
  ULTRATHINK_GATEWAY_DEEPSEEK_MODEL: '',
  ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_MAIN_MODEL_ID: '',
  ULTRATHINK_GATEWAY_MAIN_PROVIDER: '',
  ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL: '',
  ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID: '',
  ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT: '',
  ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: '',
  ULTRATHINK_GATEWAY_SUBAGENT_VERBOSITY: '',
  ULTRATHINK_DEEPSEEK_REASONING_EFFORT: '',
  ULTRATHINK_THINKING_LEVEL: '',
});

function cleanProxyEnv(overrides = {}) {
  return {
    ...CLEAN_PROXY_ENV,
    ...overrides,
  };
}

Object.assign(process.env, cleanProxyEnv());

function routedResponseModel(route) {
  const effort = route.reasoningEffort ? `/${route.reasoningEffort}` : '';
  return `${route.provider}:${route.upstreamModel}${effort} via ${route.requestedModel}`;
}

function codexRoute(overrides = {}) {
  return {
    requestedModel: CODEX_REQUEST_MODEL,
    upstreamModel: CODEX_UPSTREAM_MODEL,
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    reasoningEffort: 'medium',
    ...overrides,
  };
}

function gatewayConfig(overrides = {}) {
  const baseConfig = {
    host: '127.0.0.1',
    port: 0,
    sharedSecret: '',
    requestTimeoutMs: 10_000,
    routeMap: {},
    anthropicPassthroughModels: ['claude-opus-4-8*'],
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: true,
      command: 'codex',
      cwd: process.cwd(),
      model: CODEX_UPSTREAM_MODEL,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      reasoningEffort: 'medium',
      verbosity: 'high',
      idleTimeoutMs: 60_000,
      forkIdleTimeoutMs: 30_000,
      maxSessions: 16,
    },
    openai: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      model: CODEX_UPSTREAM_MODEL,
      reasoningEffort: 'low',
      verbosity: 'low',
    },
    deepseek: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
    anthropic: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      version: '2023-06-01',
    },
  };

  return {
    ...baseConfig,
    ...overrides,
    codex: {
      ...baseConfig.codex,
      ...overrides.codex,
    },
    openai: {
      ...baseConfig.openai,
      ...overrides.openai,
    },
    deepseek: {
      ...baseConfig.deepseek,
      ...overrides.deepseek,
    },
    anthropic: {
      ...baseConfig.anthropic,
      ...overrides.anthropic,
    },
  };
}

function lookupWeatherTool() {
  return {
    name: 'lookup_weather',
    description: 'Fetch weather.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
      },
      required: ['city'],
    },
  };
}

function deepSeekFableGatewayConfig(gatewayPort, deepSeekPort, overrides = {}) {
  const configOverrides = overrides.config || {};
  const deepSeekOverrides = overrides.deepseek || {};
  const routeOverrides = overrides.route || {};

  return gatewayConfig({
    ...configOverrides,
    port: gatewayPort,
    exposedModels: ['claude-fable-5[1m]'],
    routeMap: {
      'claude-fable-5[1m]': {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        ...routeOverrides,
      },
    },
    anthropicPassthroughModels: ['claude-fable-5*'],
    deepseek: {
      apiKey: 'deepseek-key',
      baseUrl: `http://127.0.0.1:${deepSeekPort}`,
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      thinking: { type: 'enabled' },
      ...deepSeekOverrides,
    },
  });
}

function deepSeekReasoningHeaders(sessionId) {
  return jsonHeaders({
    'x-claude-code-session-id': sessionId,
    'x-claude-code-agent-id': 'agent-weather',
  });
}

function assertDeepSeekReasoningReplay(capturedBodies) {
  const assistantMessage = capturedBodies[1].messages.find(function findAssistant(message) {
    return message.role === 'assistant';
  });
  assert.equal(assistantMessage.reasoning_content, 'Need weather.');
  assert.equal(assistantMessage.tool_calls[0].id, 'call_weather');
}

function gatewayRequest(headers = {}) {
  return {
    get(name) {
      return headers[name] || '';
    },
  };
}

function claudeSessionRequest(sessionId, extraHeaders = {}) {
  return gatewayRequest({
    'x-claude-code-session-id': sessionId,
    ...extraHeaders,
  });
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

function finalBoundary(usage = emptyUsage()) {
  return {
    type: 'boundary',
    outcome: {
      type: 'final',
      usage,
    },
  };
}

function finalOutcome(usage = emptyUsage()) {
  return {
    type: 'final',
    text: '',
    usage,
  };
}

function codexUserRequest(content) {
  return {
    model: CODEX_REQUEST_MODEL,
    messages: [{ role: 'user', content }],
    tools: [],
  };
}

function isForkSessionKey(sessionKey) {
  return sessionKey.includes(':fork:');
}

function forkBaseSessionKey(sessionKey) {
  const forkIndex = sessionKey.indexOf(':fork:');
  if (forkIndex === -1) {
    return sessionKey;
  }

  return sessionKey.slice(0, forkIndex);
}

function resolveSessionOverrides(sessionKey, options) {
  if (typeof options.sessionOverrides === 'function') {
    return options.sessionOverrides(sessionKey) || {};
  }

  return options.sessionOverrides || {};
}

function stubCodexSession(sessionKey, overrides = {}) {
  return {
    baseSessionKey: forkBaseSessionKey(sessionKey),
    sessionKey,
    pendingToolCall: null,
    activeBoundary: null,
    routingReservation: null,
    lastUsedAt: Date.now(),
    assertCompatible() {},
    touch() {},
    isDisposableIdle() {
      return !this.routingReservation && !this.pendingToolCall;
    },
    isForkSession() {
      return this.sessionKey !== this.baseSessionKey;
    },
    async advance() {
      return finalOutcome();
    },
    async stream(body, onEvent) {
      onEvent(finalBoundary());
      return { ok: true, body };
    },
    async close() {},
    ...overrides,
  };
}

function stubCodexSessionManager(onCreate, options = {}) {
  return new CodexSessionManager(
    {
      codex: {
        idleTimeoutMs: 60_000,
        forkIdleTimeoutMs: 30_000,
        maxSessions: 16,
        ...(options.codex || {}),
      },
    },
    {
      createSession(route, req, requestBody, sessionKey) {
        const session = stubCodexSession(sessionKey, resolveSessionOverrides(sessionKey, options));
        onCreate?.(sessionKey, session);
        return session;
      },
    }
  );
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

function captureTracer() {
  const entries = [];

  function scopedTracer(scopeFields = {}) {
    return {
      log(event, details = {}) {
        entries.push({
          event,
          details: {
            ...scopeFields,
            ...details,
          },
        });
      },
      scope(childFields = {}) {
        return scopedTracer({
          ...scopeFields,
          ...childFields,
        });
      },
    };
  }

  return {
    entries,
    tracer: scopedTracer(),
  };
}

async function withTemporaryEnv(updates, run) {
  const previous = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
  }

  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }

    return await run();
  } finally {
    restoreEnv(previous);
  }
}

function observedTimeoutForSession(observedTimeouts, predicate) {
  const entry = Array.from(observedTimeouts.entries()).find(function findMatchingTimeout([
    sessionKey,
  ]) {
    return predicate(sessionKey);
  });
  return entry?.[1];
}

async function observeForkIdleTimeouts(codexConfig, sessionId) {
  const observedTimeouts = new Map();
  const manager = stubCodexSessionManager(null, {
    codex: codexConfig,
    sessionOverrides: {
      touch(onExpire, timeoutMs) {
        observedTimeouts.set(this.sessionKey, timeoutMs);
      },
    },
  });
  const route = codexRoute();
  const req = claudeSessionRequest(sessionId);
  const canonicalBody = codexUserRequest('Primary request.');

  await manager.processRequest(req, canonicalBody, route);
  const canonical = manager.ensureSession(req, canonicalBody, route);
  canonical.pendingToolCall = { callId: 'call_pending' };

  await manager.processRequest(req, codexUserRequest('Unrelated side request.'), route);

  return observedTimeouts;
}

function pooledCodexSessionManager(codexConfig, onSession) {
  const createdSessionKeys = [];
  const closedSessions = [];
  let nextLastUsedAt = 1;
  const manager = stubCodexSessionManager(
    function recordSession(sessionKey, session) {
      createdSessionKeys.push(sessionKey);
      session.lastUsedAt = nextLastUsedAt;
      nextLastUsedAt += 1;
      session.touch = function preserveLastUsedAtForDeterministicTest() {};
      session.close = async function close(reason) {
        closedSessions.push({
          sessionKey,
          message: reason?.message || '',
        });
      };
      onSession?.(sessionKey, session);
    },
    {
      codex: codexConfig,
    }
  );

  return {
    closedSessions,
    createdSessionKeys,
    manager,
  };
}

async function processCodexSessionIds(manager, sessionIds, requestBody) {
  const route = codexRoute();
  for (const sessionId of sessionIds) {
    await manager.processRequest(claudeSessionRequest(sessionId), requestBody, route);
  }
}

async function waitForClosedSession(closedSessions) {
  for (let attempt = 0; attempt < 20 && closedSessions.length === 0; attempt += 1) {
    await sleep(5);
  }
}

await runTest('gateway proxy helpers resolve proxy and no_proxy environment rules', async function testGatewayProxyHelpers() {
  assert.equal(
    proxyUrlForTarget('http://api.anthropic.com/v1/messages', {
      HTTP_PROXY: 'proxy.local:8080',
    }),
    'http://proxy.local:8080'
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTPS_PROXY: 'http://upper-proxy.local:8443',
      https_proxy: 'http://lower-proxy.local:8443',
    }),
    'http://lower-proxy.local:8443'
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTP_PROXY: 'http://http-only-proxy.local:8080',
      ALL_PROXY: 'http://fallback-proxy.local:8080',
    }),
    'http://fallback-proxy.local:8080'
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTP_PROXY: 'http://http-only-proxy.local:8080',
    }),
    ''
  );
  assert.equal(
    proxyUrlForTarget('http://api.local/v1/messages', {
      HTTPS_PROXY: 'http://secure-proxy.local:8443',
      ALL_PROXY: 'http://fallback-proxy.local:8080',
    }),
    'http://fallback-proxy.local:8080'
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTPS_PROXY: 'http://proxy.local:8443',
      NO_PROXY: 'api.anthropic.com',
    }),
    ''
  );
  assert.equal(
    proxyUrlForTarget('https://api.anthropic.com/v1/messages', {
      HTTPS_PROXY: 'http://proxy.local:8443',
      NO_PROXY: '*',
    }),
    ''
  );
  assert.equal(
    noProxyMatchesUrl('https://sub.example.com:443/v1/messages', {
      NO_PROXY: '.example.com',
    }),
    true
  );
  assert.equal(
    noProxyMatchesUrl('http://127.0.0.1:4318/v1/messages', {
      NO_PROXY: '127.0.0.0/8',
    }),
    true
  );
  assert.equal(
    noProxyMatchesUrl('http://[::1]:4318/v1/messages', {
      NO_PROXY: '::1/128',
    }),
    true
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: 'localhost',
    }),
    {
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    }
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: '127.0.0.1',
    }),
    {
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    }
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    }),
    {}
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: '127.0.0.0/8',
    }),
    {
      NO_PROXY: '127.0.0.0/8',
      no_proxy: '127.0.0.0/8',
    }
  );
  assert.deepEqual(
    proxyExclusionEnvForHost('127.0.0.1', {
      HTTP_PROXY: 'http://proxy.local:8080',
      NO_PROXY: '127.0.0.1:9999',
    }),
    {
      NO_PROXY: '127.0.0.1:9999,127.0.0.1',
      no_proxy: '127.0.0.1:9999,127.0.0.1',
    }
  );
  ok('proxy env parsing handles proxy selection, bypasses, and child gateway exclusions');
});

await runTest('gateway config prefers Codex-profile aliases for the OpenAI remap target', async function testCodexAliases() {
  const previous = {
    ULTRATHINK_GATEWAY_CODEX_API_KEY: process.env.ULTRATHINK_GATEWAY_CODEX_API_KEY,
    ULTRATHINK_GATEWAY_OPENAI_API_KEY: process.env.ULTRATHINK_GATEWAY_OPENAI_API_KEY,
    ULTRATHINK_GATEWAY_CODEX_MODEL: process.env.ULTRATHINK_GATEWAY_CODEX_MODEL,
    ULTRATHINK_GATEWAY_OPENAI_MODEL: process.env.ULTRATHINK_GATEWAY_OPENAI_MODEL,
    ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT:
      process.env.ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT,
    ULTRATHINK_GATEWAY_OPENAI_REASONING_EFFORT:
      process.env.ULTRATHINK_GATEWAY_OPENAI_REASONING_EFFORT,
    ULTRATHINK_GATEWAY_CODEX_VERBOSITY: process.env.ULTRATHINK_GATEWAY_CODEX_VERBOSITY,
    ULTRATHINK_GATEWAY_OPENAI_VERBOSITY: process.env.ULTRATHINK_GATEWAY_OPENAI_VERBOSITY,
    ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: process.env.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON,
    ULTRATHINK_GATEWAY_EXPOSED_MODELS: process.env.ULTRATHINK_GATEWAY_EXPOSED_MODELS,
  };

  try {
    process.env.ULTRATHINK_GATEWAY_CODEX_API_KEY = 'codex-key';
    process.env.ULTRATHINK_GATEWAY_OPENAI_API_KEY = 'legacy-openai-key';
    process.env.ULTRATHINK_GATEWAY_CODEX_MODEL = 'gpt-5.5';
    process.env.ULTRATHINK_GATEWAY_OPENAI_MODEL = 'should-not-win';
    process.env.ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT = 'low';
    process.env.ULTRATHINK_GATEWAY_OPENAI_REASONING_EFFORT = 'high';
    process.env.ULTRATHINK_GATEWAY_CODEX_VERBOSITY = 'low';
    process.env.ULTRATHINK_GATEWAY_OPENAI_VERBOSITY = 'high';

    const config = loadGatewayConfig();
    assert.equal(config.openai.apiKey, 'codex-key');
    assert.equal(config.openai.model, 'gpt-5.5');
    assert.equal(config.openai.reasoningEffort, 'low');
    assert.equal(config.openai.verbosity, 'low');
    ok('Codex-profile aliases override legacy OpenAI-prefixed env vars');
  } finally {
    restoreEnv(previous);
  }
});

await runTest('gateway config reads an independent DeepSeek route profile', async function testDeepSeekGatewayProfile() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY: 'gateway-deepseek-key',
      DEEPSEEK_API_KEY: 'ambient-deepseek-key',
      ULTRATHINK_GATEWAY_DEEPSEEK_BASE_URL: 'http://127.0.0.1:9876',
      DEEPSEEK_BASE_URL: 'http://should-not-win',
      ULTRATHINK_GATEWAY_DEEPSEEK_MODEL: 'deepseek-v4-pro',
      DEEPSEEK_DEFAULT_MODEL_ID: 'deepseek-v4-flash',
      ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT: 'high',
      ULTRATHINK_DEEPSEEK_REASONING_EFFORT: 'max',
      ULTRATHINK_THINKING_LEVEL: 'OFF',
    },
    async function assertDeepSeekGatewayProfile() {
      const config = loadGatewayConfig();

      assert.equal(config.deepseek.apiKey, 'gateway-deepseek-key');
      assert.equal(config.deepseek.baseUrl, 'http://127.0.0.1:9876');
      assert.equal(config.deepseek.model, 'deepseek-v4-pro');
      assert.equal(config.deepseek.reasoningEffort, 'high');
      assert.equal(config.deepseek.thinking.type, 'disabled');
      ok('DeepSeek gateway routing has its own credentials, endpoint, model, and thinking profile');
    }
  );
});

await runTest('gateway defaults DeepSeek routes to enabled max reasoning', async function testDeepSeekGatewayDefaults() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT: '',
      ULTRATHINK_DEEPSEEK_REASONING_EFFORT: '',
      ULTRATHINK_THINKING_LEVEL: '',
    },
    async function assertDeepSeekGatewayDefaults() {
      const config = loadGatewayConfig();

      assert.equal(config.deepseek.reasoningEffort, 'max');
      assert.equal(config.deepseek.thinking.type, 'enabled');
      ok('DeepSeek gateway routes default to enabled max reasoning');
    }
  );
});

await runTest('gateway defaults Codex-backed routes to writable never-approval sessions', async function testCodexSessionDefaults() {
  const previous = {
    ULTRATHINK_GATEWAY_CODEX_ENABLED: process.env.ULTRATHINK_GATEWAY_CODEX_ENABLED,
    ULTRATHINK_GATEWAY_CODEX_SANDBOX: process.env.ULTRATHINK_GATEWAY_CODEX_SANDBOX,
    ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY: process.env.ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY,
    ULTRATHINK_GATEWAY_CODEX_MODEL: process.env.ULTRATHINK_GATEWAY_CODEX_MODEL,
    ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS:
      process.env.ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS,
  };

  try {
    process.env.ULTRATHINK_GATEWAY_CODEX_ENABLED = 'true';
    process.env.ULTRATHINK_GATEWAY_CODEX_SANDBOX = 'workspace-write';
    process.env.ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY = 'never';
    process.env.ULTRATHINK_GATEWAY_CODEX_MODEL = 'gpt-5.5';
    delete process.env.ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS;

    const config = loadGatewayConfig();
    const route = resolveModelRoute('claude-sonnet-4-7', config);
    assert.equal(route.provider, 'codex');
    assert.equal(route.sandbox, 'workspace-write');
    assert.equal(route.approvalPolicy, 'never');
    assert.equal(config.codex.closeKillTimeoutMs, 2_000);
    ok('Codex-backed gateway routes default to writable never-approval threads');
  } finally {
    restoreEnv(previous);
  }
});

await runTest('gateway can make a configured frontier model the only Anthropic passthrough default', async function testConfigurableAnthropicPassthroughModels() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'claude-fable-5*',
    },
    async function assertConfigurablePassthroughModels() {
      const config = loadGatewayConfig();
      const frontierRoute = resolveModelRoute('claude-fable-5', config);
      const olderOpusRoute = resolveModelRoute('claude-opus-4-8', config);

      assert.deepEqual(config.anthropicPassthroughModels, ['claude-fable-5*']);
      assert.equal(frontierRoute.provider, 'anthropic');
      assert.equal(frontierRoute.upstreamModel, 'claude-fable-5');
      assert.equal(olderOpusRoute.provider, 'codex');
      assert.equal(olderOpusRoute.upstreamModel, 'gpt-5.5');
      ok('only the configured frontier model stays on Anthropic while older Claude ids route to Codex');
    }
  );
});

await runTest('gateway keeps wildcard Anthropic passthrough defaults for standalone compatibility', async function testDefaultAnthropicPassthroughWildcard() {
  const route = resolveModelRoute('claude-opus-4-8-20260601', gatewayConfig());

  assert.equal(route.provider, 'anthropic');
  assert.equal(route.upstreamModel, 'claude-opus-4-8-20260601');
  ok('standalone gateway default still preserves Opus wildcard passthrough');
});

await runTest('gateway strips client-only [1m] qualifiers before Anthropic passthrough', async function testAnthropicPassthroughOneMillionAlias() {
  const opusRoute = resolveModelRoute('claude-opus-4-8[1m]', gatewayConfig());
  const fableRoute = resolveModelRoute(
    'claude-fable-5[1m]',
    gatewayConfig({
      anthropicPassthroughModels: ['claude-fable-5*'],
    })
  );

  assert.equal(opusRoute.provider, 'anthropic');
  assert.equal(opusRoute.requestedModel, 'claude-opus-4-8[1m]');
  assert.equal(opusRoute.upstreamModel, 'claude-opus-4-8');
  assert.equal(fableRoute.provider, 'anthropic');
  assert.equal(fableRoute.requestedModel, 'claude-fable-5[1m]');
  assert.equal(fableRoute.upstreamModel, 'claude-fable-5');
  ok('client-visible [1m] aliases use the plain Anthropic API model id upstream');
});

await runTest('gateway wildcard route-map entries override passthrough patterns', async function testWildcardRouteMapEntry() {
  const route = resolveModelRoute(
    'claude-fable-5[1m]',
    gatewayConfig({
      routeMap: {
        'claude-fable-5*': {
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'max',
        },
      },
      anthropicPassthroughModels: ['claude-fable-5*'],
      deepseek: {
        apiKey: 'deepseek-key',
        baseUrl: 'http://127.0.0.1:1',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
        thinking: { type: 'enabled' },
      },
    })
  );

  assert.equal(route.provider, 'deepseek');
  assert.equal(route.upstreamModel, 'deepseek-v4-pro');
  assert.equal(route.reasoningEffort, 'max');
  assert.deepEqual(route.thinking, { type: 'enabled' });
  ok('wildcard route-map entries are applied before the Anthropic passthrough fallback');
});

await runTest('gateway config exposes the Codex close kill timeout knob', async function testCodexCloseKillTimeoutConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS: '250' },
    async function assertCloseKillTimeoutConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.closeKillTimeoutMs, 250);
      ok('Codex app-server close kill timeout is configurable through the gateway config');
    }
  );
});

await runTest('gateway config exposes the Codex input budget', async function testCodexInputBudgetConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS: '4096' },
    async function assertInputBudgetConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.inputMaxTokens, 4096);
      ok('Codex app-server input budget is configurable through the gateway config');
    }
  );
});

await runTest('gateway config exposes the Codex session pool cap', async function testCodexMaxSessionsConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS: '3' },
    async function assertMaxSessionsConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.maxSessions, 3);
      ok('Codex app-server pool size is configurable through the gateway config');
    }
  );
});

await runTest('gateway config exposes the Codex fork idle timeout', async function testCodexForkIdleTimeoutConfig() {
  await withTemporaryEnv(
    { ULTRATHINK_GATEWAY_CODEX_FORK_IDLE_TIMEOUT_MS: '2500' },
    async function assertForkIdleTimeoutConfig() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.forkIdleTimeoutMs, 2500);
      ok('Codex fork session idle recycling is configurable through the gateway config');
    }
  );
});

await runTest('gateway config exposes the Codex idle-pool defaults', async function testCodexIdlePoolDefaults() {
  await withTemporaryEnv(
    {
      ULTRATHINK_GATEWAY_CODEX_FORK_IDLE_TIMEOUT_MS: undefined,
      ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS: undefined,
    },
    async function assertIdlePoolDefaults() {
      const config = loadGatewayConfig();
      assert.equal(config.codex.forkIdleTimeoutMs, 30_000);
      assert.equal(config.codex.maxSessions, 16);
      ok('Codex idle-pool defaults are explicit in gateway config');
    }
  );
});

await runTest('gateway config expands home-relative Codex and trace paths', async function testGatewayConfigExpandsHomePaths() {
  const previous = {
    ULTRATHINK_GATEWAY_TRACE_DIR: process.env.ULTRATHINK_GATEWAY_TRACE_DIR,
    ULTRATHINK_GATEWAY_CODEX_CWD: process.env.ULTRATHINK_GATEWAY_CODEX_CWD,
  };

  try {
    process.env.ULTRATHINK_GATEWAY_TRACE_DIR = '~/ultrathink-gateway-trace';
    process.env.ULTRATHINK_GATEWAY_CODEX_CWD = '~/ultrathink-codex-cwd';
    const config = loadGatewayConfig();
    assert.equal(
      config.traceDir,
      path.resolve(path.join(os.homedir(), 'ultrathink-gateway-trace'))
    );
    assert.equal(
      config.codex.cwd,
      path.resolve(path.join(os.homedir(), 'ultrathink-codex-cwd'))
    );
    ok('gateway config expands home-relative trace and Codex cwd paths');
  } finally {
    restoreEnv(previous);
  }
});

await runTest('gateway finish events clear request timers without aborting successful streams', async function testGatewayFinishDoesNotAbort() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = true;

  const signal = withAbortSignal(req, res, 60_000);
  res.emit('finish');

  assert.equal(signal.aborted, false);
  ok('normal response completion no longer aborts the routed Codex session');
});

await runTest('gateway SSE writer emits atomic events and honors response backpressure', async function testSseWriterBackpressure() {
  const res = new EventEmitter();
  const chunks = [];
  let resolved = false;
  res.destroyed = false;
  res.write = function write(chunk) {
    chunks.push(chunk);
    return false;
  };

  const promise = writeSseEvent(res, 'message_delta', { type: 'message_delta' }).then(
    function markResolved() {
      resolved = true;
    }
  );
  await sleep(10);
  assert.equal(resolved, false);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /^event: message_delta\ndata: \{"type":"message_delta"\}\n\n$/u);

  res.emit('drain');
  await promise;
  assert.equal(resolved, true);

  const closedRes = new EventEmitter();
  closedRes.destroyed = true;
  closedRes.write = function failUnexpectedWrite() {
    throw new Error('write should not be called after response destruction');
  };

  await assert.rejects(
    writeSseEvent(closedRes, 'ping', { type: 'ping' }),
    /response stream closed before write completed/u
  );
  ok('SSE writes stay atomic while still waiting for drain and rejecting closed responses');
});

await runTest('gateway traces client-aborted Codex turns separately from failures', async function testGatewayAbortTraceClassification() {
  const gatewayPort = await freePort();
  const traceEvents = [];
  const tracer = {
    createId() {
      return 'abort-request';
    },
    scope(details) {
      return {
        log(event, payload) {
          traceEvents.push({ event, ...details, ...payload });
        },
      };
    },
  };
  const codexSessions = {
    async streamRequest(req) {
      return new Promise(function waitForAbort(resolve, reject) {
        req.abortSignal.addEventListener(
          'abort',
          function rejectAbort() {
            reject(
              new GatewayError(
                499,
                'api_error',
                'gateway request aborted before Codex turn completed'
              )
            );
          },
          { once: true }
        );
      });
    },
  };
  const app = createGatewayApp(
    gatewayConfig({
      requestTimeoutMs: 60_000,
      exposedModels: [],
    }),
    codexSessions,
    tracer
  );
  const server = app.listen(gatewayPort, '127.0.0.1');
  await waitForListening(server);

  try {
    await new Promise(function sendAndAbort(resolve) {
      const clientRequest = http.request({
        host: '127.0.0.1',
        port: gatewayPort,
        path: '/v1/messages',
        method: 'POST',
        headers: jsonHeaders(),
      });
      clientRequest.on('error', resolve);
      clientRequest.write(
        JSON.stringify({
          model: 'claude-sonnet-4-7',
          stream: true,
          messages: [{ role: 'user', content: 'Abort this routed Codex request.' }],
        })
      );
      clientRequest.end();
      setTimeout(function abortClientRequest() {
        clientRequest.destroy();
        resolve();
      }, 20);
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        traceEvents.some(function hasAbortEvent(event) {
          return event.event === 'gateway.request.aborted';
        })
      ) {
        break;
      }
      await sleep(25);
    }

    assert.equal(
      traceEvents.some(function hasAbortEvent(event) {
        return event.event === 'gateway.request.aborted';
      }),
      true
    );
    assert.equal(
      traceEvents.some(function hasFailureEvent(event) {
        return event.event === 'gateway.request.failed';
      }),
      false
    );
    ok('client-aborted routed Codex turns are traceable without being counted as gateway failures');
  } finally {
    await closeServer(server);
  }
});

await runTest('gateway request timeouts remain distinct from client-aborted Codex turns', async function testGatewayTimeoutClassification() {
  const gatewayPort = await freePort();
  const traceEvents = [];
  const tracer = {
    createId() {
      return 'timeout-request';
    },
    scope(details) {
      return {
        log(event, payload) {
          traceEvents.push({ event, ...details, ...payload });
        },
      };
    },
  };
  const codexSessions = {
    async processRequest(req) {
      return new Promise(function rejectOnAbort(resolve, reject) {
        req.abortSignal.addEventListener(
          'abort',
          function rejectTimeout() {
            reject(req.abortSignal.reason);
          },
          { once: true }
        );
      });
    },
  };
  const app = createGatewayApp(
    gatewayConfig({
      requestTimeoutMs: 20,
      exposedModels: [],
    }),
    codexSessions,
    tracer
  );
  const server = app.listen(gatewayPort, '127.0.0.1');
  await waitForListening(server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [{ role: 'user', content: 'Timeout this routed Codex request.' }],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 504);
    assert.match(payload.error.message, /timed out/u);
    assert.equal(
      traceEvents.some(function hasTimeoutFailure(event) {
        return event.event === 'gateway.request.failed' && event.gateway_error_status === 504;
      }),
      true
    );
    assert.equal(
      traceEvents.some(function hasAbortEvent(event) {
        return event.event === 'gateway.request.aborted';
      }),
      false
    );
    ok('gateway timeouts report as 504 failures instead of client-abort noise');
  } finally {
    await closeServer(server);
  }
});

await runTest('gateway can expose routed Codex response model metadata', async function testCodexDisplayRoutedModelJson() {
  const gatewayPort = await freePort();
  let seenRoute = null;
  let seenRequestBody = null;

  const codexSessions = {
    async processRequest(req, requestBody, route) {
      seenRequestBody = requestBody;
      seenRoute = route;
      return {
        type: 'final',
        text: 'DISPLAY_MODEL_OK',
        usage: {
          input_tokens: 9,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          reasoning_output_tokens: 2,
          total_tokens: 14,
        },
      };
    },
  };
  const app = createGatewayApp(
    gatewayConfig({
      displayRoutedModel: true,
      exposedModels: ['claude-sonnet-4-7'],
      routeMap: {
        'claude-sonnet-4-7': {
          provider: 'codex',
          model: 'gpt-5.5',
          reasoningEffort: 'medium',
          verbosity: 'high',
        },
      },
    }),
    codexSessions
  );
  const server = app.listen(gatewayPort, '127.0.0.1');
  await waitForListening(server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [{ role: 'user', content: 'Say DISPLAY_MODEL_OK.' }],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(seenRequestBody.model, 'claude-sonnet-4-7');
    assert.equal(seenRoute.provider, 'codex');
    assert.equal(payload.model, routedResponseModel(seenRoute));
    assert.equal(payload.content[0].text, 'DISPLAY_MODEL_OK');
    assert.deepEqual(payload.usage, {
      input_tokens: 9,
      output_tokens: 3,
      cache_read_input_tokens: 4,
    });
    ok('Codex JSON responses can report routed provider/upstream metadata without changing the request');
  } finally {
    await closeServer(server);
  }
});

await runTest('gateway refuses unauthenticated non-loopback binds', async function testGatewayRefusesUnsafeBind() {
  assert.throws(
    function constructUnsafeGateway() {
      createGatewayApp({
        host: '0.0.0.0',
        sharedSecret: '',
      });
    },
    /Refusing to start unauthenticated gateway on non-loopback host 0\.0\.0\.0/u
  );

  for (const host of ['127', '127.999.999.999']) {
    assert.throws(
      function constructAmbiguousGateway() {
        createGatewayApp({
          host,
          sharedSecret: '',
        });
      },
      new RegExp(`Refusing to start unauthenticated gateway on non-loopback host ${host.replaceAll('.', '\\.')}`, 'u')
    );
  }

  ok('non-loopback gateway binds require an explicit shared secret');
});

await runTest('gateway trace context keeps Claude session and routed model identity', async function testGatewayTraceContext() {
  const req = claudeSessionRequest('session-trace', {
    'x-claude-code-agent-id': 'agent-1',
    'x-claude-code-parent-agent-id': 'parent-1',
  });
  const route = codexRoute({
    provider: 'codex',
  });

  assert.deepEqual(summarizeGatewayTraceContext(req, route), {
    claude_session_id: 'session-trace',
    claude_agent_id: 'agent-1',
    claude_parent_agent_id: 'parent-1',
    provider: 'codex',
    requested_model: 'claude-sonnet-4-7',
    upstream_model: 'gpt-5.5',
    sandbox: 'workspace-write',
    approval_policy: 'never',
  });
  ok('trace context carries enough identity to tie request completion/failure back to one Claude workflow session');
});

await runTest('gateway request summaries cap historical tool_result ids while keeping the total count', async function testGatewayRequestSummaryCapsToolResults() {
  const messages = [{ role: 'user', content: [] }];
  for (let index = 1; index <= 20; index += 1) {
    messages[0].content.push({
      type: 'tool_result',
      tool_use_id: `call_${String(index).padStart(2, '0')}`,
      content: `result ${index}`,
    });
  }

  const summary = summarizeRequestBody({
    model: 'claude-sonnet-4-7',
    messages,
    tools: [],
  });

  assert.equal(summary.tool_result_count, 20);
  assert.equal(summary.tool_result_ids.length, 16);
  assert.deepEqual(summary.tool_result_ids.slice(0, 3), ['call_05', 'call_06', 'call_07']);
  assert.deepEqual(summary.tool_result_ids.slice(-3), ['call_18', 'call_19', 'call_20']);
  ok('long workflow traces keep recent tool results without dumping every historical id');
});

await runTest('Codex dynamic tool registry aliases reserved Claude tool names', async function testCodexToolAliasing() {
  const registry = buildCodexDynamicToolRegistry([
    {
      name: 'mcp__claude_ai_Gmail__authenticate',
      description: 'OAuth bootstrap tool',
      input_schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'Workflow',
      description: 'Workflow launcher',
      input_schema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
          },
        },
        required: ['script'],
        additionalProperties: false,
      },
    },
  ]);

  assert.equal(registry.dynamicTools.length, 2);
  assert.equal(registry.dynamicTools[0].name, 'ext_tool_001');
  assert.equal(registry.dynamicTools[1].name, 'ext_tool_002');
  assert.equal(
    registry.byInternalName.get('ext_tool_001')?.originalName,
    'mcp__claude_ai_Gmail__authenticate'
  );
  assert.equal(registry.byInternalName.get('ext_tool_002')?.originalName, 'Workflow');
  ok('reserved Claude tool names are remapped before reaching Codex app-server');
});

await runTest('Codex session manager reuses the pending session when a matching tool_result arrives', async function testToolResultSessionReuse() {
  const createdSessions = [];
  const manager = stubCodexSessionManager(function recordSession(sessionKey, session) {
    createdSessions.push(session);
  });
  const route = codexRoute();
  const req = claudeSessionRequest('session-1');

  const canonicalBody = {
    model: CODEX_REQUEST_MODEL,
    messages: [{ role: 'user', content: 'Run the tool.' }],
    tools: [],
  };
  const canonical = manager.ensureSession(req, canonicalBody, route);
  canonical.pendingToolCall = { callId: 'call_123' };

  const result = await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [
        { role: 'user', content: 'Run the tool.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_123', name: 'Workflow', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_123', content: 'tool complete', is_error: false }],
        },
      ],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessions.length, 1);
  assert.equal(result.ok, true);
  ok('matching tool_result requests are routed back to the original pending Codex session');
});

await runTest('Codex session manager forks unrelated side requests while a tool_result is pending', async function testPendingForking() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const route = codexRoute();
  const req = claudeSessionRequest('session-2');

  const canonicalBody = {
    model: CODEX_REQUEST_MODEL,
    messages: [
      { role: 'system', content: 'Shared workflow instructions.' },
      { role: 'user', content: 'Primary request.' },
    ],
    tools: [],
  };
  const canonical = manager.ensureSession(req, canonicalBody, route);
  canonical.pendingToolCall = { callId: 'call_pending' };

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [
        { role: 'system', content: 'Shared workflow instructions.' },
        { role: 'user', content: 'A different in-session request arrived before the tool_result.' },
      ],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.match(createdSessionKeys[1], /:fork:/u);
  ok('side requests no longer collide with a pending tool_result in the canonical Codex session');
});

await runTest('Codex session manager forks unrelated tool_result requests while a tool_result is pending', async function testPendingForkingWithDifferentToolResult() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const route = codexRoute();
  const req = claudeSessionRequest('session-2b');

  const canonical = manager.ensureSession(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [
        { role: 'system', content: 'Shared workflow instructions.' },
        { role: 'user', content: 'Primary request.' },
      ],
      tools: [],
    },
    route
  );
  canonical.pendingToolCall = { callId: 'call_pending' };

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [
        { role: 'system', content: 'Shared workflow instructions.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_other', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_other', content: 'other result' }],
        },
      ],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.match(createdSessionKeys[1], /:fork:/u);
  ok('unrelated tool_result requests no longer collide with a different pending tool_result');
});

await runTest('Codex session manager forks unrelated side requests while the canonical turn is still in progress', async function testActiveBoundaryForking() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const route = codexRoute();
  const req = claudeSessionRequest('session-active-boundary');

  const canonical = manager.ensureSession(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'Primary request.' }],
      tools: [],
    },
    route
  );
  canonical.activeBoundary = {
    requestFingerprint: 'primary-fingerprint',
    finished: false,
  };

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'Different side request while the first routed turn is still running.' }],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.match(createdSessionKeys[1], /:fork:/u);
  ok('side requests no longer 409 when the canonical routed turn is still in progress');
});

await runTest('Codex session manager starts abortable runs synchronously after selection', async function testAbortableRunsStartSynchronously() {
  let advanceCalls = 0;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      async advance() {
        advanceCalls += 1;
        return finalOutcome();
      },
    },
  });
  const route = codexRoute();
  const controller = new AbortController();
  const req = claudeSessionRequest('session-sync-abortable-start');
  Object.assign(req, {
    abortSignal: controller.signal,
  });

  const promise = manager.processRequest(req, codexUserRequest('Start immediately.'), route);

  assert.equal(advanceCalls, 1);
  await promise;
  ok('abortable session requests now mark session state before another same-tick selection can run');
});

await runTest('Codex session manager forks side requests while canonical startup is reserved', async function testRoutingReservationForking() {
  const createdSessionKeys = [];
  const advanceCalls = [];
  const advanceResolvers = [];
  const manager = stubCodexSessionManager(
    function recordSessionKey(sessionKey) {
      createdSessionKeys.push(sessionKey);
    },
    {
      sessionOverrides: {
        advance(body) {
          advanceCalls.push({
            sessionKey: this.sessionKey,
            content: body.messages[0].content,
          });
          return new Promise(function waitForTest(resolve) {
            advanceResolvers.push(resolve);
          });
        },
      },
    }
  );
  const route = codexRoute();
  const req = claudeSessionRequest('session-routing-reservation');

  const first = manager.processRequest(req, codexUserRequest('Primary request.'), route);
  assert.equal(advanceCalls.length, 1);
  assert.equal(createdSessionKeys.length, 1);
  assert.equal(manager.sessions.get(createdSessionKeys[0])?.routingReservation?.requestFingerprint !== undefined, true);

  const second = manager.processRequest(
    req,
    codexUserRequest('Different same-session side request during startup.'),
    route
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.match(createdSessionKeys[1], /:fork:/u);
  assert.equal(advanceCalls[1].sessionKey, createdSessionKeys[1]);

  for (const resolve of advanceResolvers) {
    resolve(finalOutcome());
  }
  await Promise.all([first, second]);

  for (const session of manager.sessions.values()) {
    assert.equal(session.routingReservation, null);
  }
  ok('startup reservations are visible to routing and cleared after the request settles');
});

await runTest('Codex session manager clears startup reservations after synchronous request failure', async function testRoutingReservationClearedOnSynchronousFailure() {
  let selectedSession = null;
  const manager = stubCodexSessionManager(
    function recordSession(sessionKey, session) {
      selectedSession = session;
    },
    {
      sessionOverrides: {
        advance() {
          throw new GatewayError(400, 'invalid_request_error', 'synthetic startup failure');
        },
      },
    }
  );
  const route = codexRoute();
  const req = claudeSessionRequest('session-routing-reservation-failure');

  await assert.rejects(
    manager.processRequest(req, codexUserRequest('Fail before boundary.'), route),
    /synthetic startup failure/u
  );

  assert.equal(selectedSession?.routingReservation, null);
  assert.equal(manager.sessions.size, 1);
  ok('non-evicted sessions do not keep stale routing reservations after request startup fails');
});

await runTest('Codex session manager protects startup reservations from pool eviction', async function testRoutingReservationBlocksPoolEviction() {
  const createdSessionKeys = [];
  const closedSessionKeys = [];
  let nextLastUsedAt = 1;
  let reservedStartupResolve = null;
  const manager = stubCodexSessionManager(
    function recordSession(sessionKey, session) {
      createdSessionKeys.push(sessionKey);
      session.lastUsedAt = nextLastUsedAt;
      nextLastUsedAt += 1;
      session.close = async function close() {
        closedSessionKeys.push(sessionKey);
      };
    },
    {
      codex: {
        maxSessions: 1,
      },
      sessionOverrides: {
        advance(body) {
          if (body.messages[0].content === 'Reserved startup.') {
            return new Promise(function waitForStartup(resolve) {
              reservedStartupResolve = resolve;
            });
          }

          return finalOutcome();
        },
      },
    }
  );
  const route = codexRoute();

  const first = manager.processRequest(
    claudeSessionRequest('session-reserved-pool-1'),
    codexUserRequest('Reserved startup.'),
    route
  );
  assert.equal(createdSessionKeys.length, 1);
  assert.equal(manager.sessions.get(createdSessionKeys[0])?.routingReservation?.requestFingerprint !== undefined, true);

  await manager.processRequest(
    claudeSessionRequest('session-reserved-pool-2'),
    codexUserRequest('Second request.'),
    route
  );
  await sleep(0);

  assert.deepEqual(closedSessionKeys, []);
  assert.equal(manager.sessions.size, 2);

  reservedStartupResolve(finalOutcome());
  await first;
  await sleep(0);

  assert.deepEqual(closedSessionKeys, [createdSessionKeys[1]]);
  ok('max-session cleanup skips reserved startup sessions until their request settles');
});

await runTest('Codex session manager uses a shorter idle timeout for fork sessions', async function testForkSessionIdleTimeout() {
  const observedTimeouts = await observeForkIdleTimeouts(
    {
      idleTimeoutMs: 60_000,
      forkIdleTimeoutMs: 25,
    },
    'session-fork-timeout'
  );
  const canonicalTimeout = observedTimeoutForSession(observedTimeouts, function isCanonical(
    sessionKey
  ) {
    return !isForkSessionKey(sessionKey);
  });
  const forkTimeout = observedTimeoutForSession(observedTimeouts, isForkSessionKey);

  assert.equal(canonicalTimeout, 60_000);
  assert.equal(forkTimeout, 25);
  ok('canonical sessions stay reusable while fork sessions recycle quickly');
});

await runTest('Codex session manager defaults fork recycling when manual configs omit it', async function testForkSessionDefaultIdleTimeout() {
  const observedTimeouts = await observeForkIdleTimeouts(
    {
      forkIdleTimeoutMs: undefined,
      idleTimeoutMs: 60_000,
    },
    'session-fork-default-timeout'
  );
  const forkTimeout = observedTimeoutForSession(observedTimeouts, isForkSessionKey);

  assert.equal(forkTimeout, 30_000);
  ok('manual gateway configs still use the default fork recycle timeout');
});

await runTest('Codex session manager treats blank manual fork timeouts as unset', async function testForkSessionBlankIdleTimeout() {
  const observedTimeouts = await observeForkIdleTimeouts(
    {
      forkIdleTimeoutMs: '',
      idleTimeoutMs: 60_000,
    },
    'session-fork-blank-timeout'
  );
  const forkTimeout = observedTimeoutForSession(observedTimeouts, isForkSessionKey);

  assert.equal(forkTimeout, 30_000);
  ok('blank manual fork timeout values do not disable fork recycling');
});

await runTest('Codex session manager ignores Claude system prompt churn for session continuity', async function testSystemPromptChurn() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(
    function recordSessionKey(sessionKey) {
      createdSessionKeys.push(sessionKey);
    },
    {
      sessionOverrides: {
        async stream(body, onEvent) {
          onEvent(finalBoundary({ input_tokens: 0, output_tokens: 1 }));
          return { ok: true, body };
        },
      },
    }
  );
  const route = codexRoute();
  const req = claudeSessionRequest('session-system-churn');

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      system: 'Claude Code attribution block A',
      messages: [{ role: 'user', content: 'First request.' }],
      tools: [],
    },
    route,
    function noop() {}
  );

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      system: 'Claude Code attribution block B',
      messages: [{ role: 'user', content: 'Second request.' }],
      tools: [],
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 1);
  ok('changing Claude system prompt text no longer shards the routed Codex session');
});

await runTest('Codex session manager aborts and evicts a live session when the gateway request is aborted', async function testAbortEvictsLiveSession() {
  let closeCalls = 0;
  let closeReason = null;
  let pendingResolve = null;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      async stream() {
        return new Promise(function captureResolve(resolve) {
          pendingResolve = resolve;
        });
      },
      async close(reason) {
        closeCalls += 1;
        closeReason = reason;
        pendingResolve?.({ ok: false });
      },
    },
  });

  const route = codexRoute();
  const controller = new AbortController();
  const req = claudeSessionRequest('session-abort');
  Object.assign(req, {
    abortSignal: controller.signal,
  });

  const promise = manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'Long running review.' }],
      tools: [],
    },
    route,
    function noop() {}
  );

  controller.abort();

  await assert.rejects(promise, /gateway request aborted before Codex turn completed/u);
  assert.equal(closeCalls, 1);
  assert.match(closeReason?.message || '', /gateway request aborted before Codex turn completed/u);
  assert.equal(manager.sessions.size, 0);
  ok('aborted gateway requests now stop the Codex session instead of leaking work');
});

await runTest('Codex session manager does not start turns for pre-aborted requests', async function testPreAbortedRequestsDoNotStartTurns() {
  let advanceCalls = 0;
  let closeCalls = 0;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      async advance() {
        advanceCalls += 1;
        return finalOutcome();
      },
      async close() {
        closeCalls += 1;
      },
    },
  });
  const controller = new AbortController();
  controller.abort(new GatewayError(499, 'api_error', 'pre-aborted request'));
  const req = claudeSessionRequest('session-pre-abort');
  Object.assign(req, {
    abortSignal: controller.signal,
  });

  await assert.rejects(
    manager.processRequest(
      req,
      {
        model: CODEX_REQUEST_MODEL,
        messages: [{ role: 'user', content: 'This should never start.' }],
        tools: [],
      },
      codexRoute()
    ),
    /pre-aborted request/u
  );

  assert.equal(advanceCalls, 0);
  assert.equal(closeCalls, 1);
  assert.equal(manager.sessions.size, 0);
  ok('already-aborted requests evict without starting a new Codex turn');
});

await runTest('Codex session manager evicts failed app-server sessions from the pool', async function testFailedCodexSessionsAreEvicted() {
  let closeCalls = 0;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      async stream() {
        throw new GatewayError(502, 'api_error', 'dead Codex app-server');
      },
      async close() {
        closeCalls += 1;
      },
    },
  });

  await assert.rejects(
    manager.streamRequest(
      claudeSessionRequest('session-dead'),
      {
        model: CODEX_REQUEST_MODEL,
        messages: [{ role: 'user', content: 'Trigger a dead session.' }],
        tools: [],
      },
      codexRoute(),
      function noop() {}
    ),
    /dead Codex app-server/u
  );

  assert.equal(closeCalls, 1);
  assert.equal(manager.sessions.size, 0);
  ok('failed Codex sessions are removed before another request can reuse them');
});

await runTest('Codex session manager caps old idle Codex app-server sessions', async function testMaxSessionPoolEvictsOldIdleSessions() {
  const { closedSessions, createdSessionKeys, manager } = pooledCodexSessionManager({
    maxSessions: 2,
  });

  await processCodexSessionIds(
    manager,
    ['pool-a', 'pool-b', 'pool-c'],
    codexUserRequest('Finish quickly.')
  );
  await waitForClosedSession(closedSessions);

  assert.equal(closedSessions.length, 1);
  assert.equal(closedSessions[0].sessionKey, createdSessionKeys[0]);
  assert.match(closedSessions[0].message, /max_sessions=2/u);
  assert.equal(manager.sessions.size, 2);
  await manager.close();
  ok('idle Codex app-server pressure is bounded by closing the oldest disposable sessions');
});

await runTest('Codex session manager keeps sessions waiting for tool_result', async function testMaxSessionPoolKeepsPendingToolResultSessions() {
  let firstSession = null;
  const { closedSessions, manager } = pooledCodexSessionManager(
    { maxSessions: 1 },
    function captureFirstSession(sessionKey, session) {
      firstSession ||= session;
    }
  );
  const route = codexRoute();
  const requestBody = codexUserRequest('Finish quickly.');

  await manager.processRequest(claudeSessionRequest('pool-pending'), requestBody, route);
  firstSession.pendingToolCall = { callId: 'call_waiting' };

  await manager.processRequest(claudeSessionRequest('pool-new'), requestBody, route);
  await sleep(25);

  assert.equal(closedSessions.length, 0);
  assert.equal(manager.sessions.size, 2);
  await manager.close();
  ok('pool pressure does not close sessions that still own pending tool_result state');
});

await runTest('Codex session manager treats blank manual pool caps as unset', async function testBlankMaxSessionPoolDefaults() {
  const { closedSessions, createdSessionKeys, manager } = pooledCodexSessionManager({
    maxSessions: '',
  });
  const sessionIds = Array.from({ length: 17 }, function buildSessionId(_, index) {
    return `pool-default-${index}`;
  });

  await processCodexSessionIds(manager, sessionIds, codexUserRequest('Finish quickly.'));
  await waitForClosedSession(closedSessions);

  assert.equal(closedSessions.length, 1);
  assert.equal(closedSessions[0].sessionKey, createdSessionKeys[0]);
  assert.match(closedSessions[0].message, /max_sessions=16/u);
  assert.equal(manager.sessions.size, 16);
  await manager.close();
  ok('blank manual pool caps use the default max session limit');
});

await runTest('Codex session manager arms idle timers only after active turns finish', async function testIdleTimerArmsAfterTurn() {
  let finishTurn = null;
  let touchCalls = 0;
  let clearIdleCalls = 0;
  const manager = stubCodexSessionManager(null, {
    sessionOverrides: {
      clearIdleTimer() {
        clearIdleCalls += 1;
      },
      touch() {
        touchCalls += 1;
      },
      async stream() {
        return new Promise(function waitForTurn(resolve) {
          finishTurn = resolve;
        });
      },
    },
  });

  const promise = manager.streamRequest(
    claudeSessionRequest('session-idle'),
    {
      model: CODEX_REQUEST_MODEL,
      messages: [{ role: 'user', content: 'Keep this turn active.' }],
      tools: [],
    },
    codexRoute(),
    function noop() {}
  );

  await sleep(25);
  assert.equal(clearIdleCalls, 1);
  assert.equal(touchCalls, 0);

  finishTurn(finalOutcome({ input_tokens: 1, output_tokens: 1 }));
  await promise;

  assert.equal(touchCalls, 1);
  ok('idle expiration cannot close a session while a routed Codex turn is active');
});

await runTest('Codex session identity keys cannot collide through raw header separators', async function testSessionIdentityKeySeparatorSafety() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const requestBody = {
    model: CODEX_REQUEST_MODEL,
    messages: [{ role: 'user', content: 'Same transcript, ambiguous headers.' }],
    tools: [],
  };

  await manager.processRequest(
    claudeSessionRequest('s', {
      'x-claude-code-agent-id': 'a:b',
      'x-claude-code-parent-agent-id': 'c',
    }),
    requestBody,
    codexRoute()
  );
  await manager.processRequest(
    claudeSessionRequest('s:a', {
      'x-claude-code-agent-id': 'b',
      'x-claude-code-parent-agent-id': 'c',
    }),
    requestBody,
    codexRoute()
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.notEqual(createdSessionKeys[0], createdSessionKeys[1]);
  ok('structured session identity hashing prevents colon-separated header collisions');
});

await runTest(
  'Codex app-server marks Claude workflow agent threads as ephemeral subagents',
  async function testCodexWorkflowAgentThreadStartMetadata() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-thread-source-'));
    const codexPath = path.join(tempDir, 'codex-thread-source');
    const recordsPath = path.join(tempDir, 'records.jsonl');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          "const readline = require('node:readline');\n" +
          'const recordsPath = process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS;\n' +
          'let threadCount = 0;\n' +
          'let turnCount = 0;\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function record(message) {\n' +
          "  fs.appendFileSync(recordsPath, `${JSON.stringify({ method: message.method, params: message.params })}\\n`, 'utf8');\n" +
          '}\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          '    record(message);\n' +
          '    threadCount += 1;\n' +
          "    send({ id: message.id, result: { thread: { id: `thread-${threadCount}` } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    record(message);\n' +
          '    turnCount += 1;\n' +
          '    const turnId = `turn-${turnCount}`;\n' +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          "    setTimeout(function completeTurn() { send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } }); }, 5);\n" +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const previousRecordsPath = process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS;
      process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS = recordsPath;
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          closeKillTimeoutMs: 50,
        },
      });
      try {
        await manager.processRequest(gatewayRequest(), codexUserRequest('Root chat'), codexRoute());
        await manager.processRequest(
          claudeSessionRequest('session-agent', {
            'x-claude-code-agent-id': 'agent-1',
            'x-claude-code-parent-agent-id': 'parent-1',
          }),
          codexUserRequest('Agent chat'),
          codexRoute()
        );
      } finally {
        await manager.close();
        if (previousRecordsPath === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_THREAD_RECORDS = previousRecordsPath;
        }
      }

      const recordsText = await fs.readFile(recordsPath, 'utf8');
      const records = recordsText
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(function parseRecord(line) {
          return JSON.parse(line);
        });
      const threadStarts = records.filter(function isThreadStart(record) {
        return record.method === 'thread/start';
      });

      assert.equal(threadStarts.length, 2);
      assert.equal(threadStarts[0].params.threadSource, 'user');
      assert.equal(threadStarts[0].params.ephemeral, undefined);
      assert.equal(threadStarts[1].params.threadSource, 'subagent');
      assert.equal(threadStarts[1].params.ephemeral, true);
      ok('Claude workflow agent Codex threads are pathless/non-resumable app-server threads');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server parallel tool calls reject later calls without clobbering the pending call',
  async function testCodexParallelToolCallsDoNotClobberPendingCall() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-parallel-tool-'));
    const codexPath = path.join(tempDir, 'codex-parallel-tool');
    const responsesPath = path.join(tempDir, 'tool-responses.json');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          "const readline = require('node:readline');\n" +
          'const responsesPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;\n' +
          'const responses = [];\n' +
          'const turnId = "turn-1";\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'function record(message) {\n' +
          '  responses.push(message);\n' +
          "  fs.writeFileSync(responsesPath, JSON.stringify(responses), 'utf8');\n" +
          '}\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function emitToolCalls() {\n' +
          "      send({ id: 'tool_req_1', method: 'item/tool/call', params: { turnId, callId: 'call_first', tool: 'ext_tool_001', arguments: { value: 'first' } } });\n" +
          "      send({ id: 'tool_req_2', method: 'item/tool/call', params: { turnId, callId: 'call_second', tool: 'ext_tool_001', arguments: { value: 'second' } } });\n" +
          '      send({ method: "thread/tokenUsage/updated", params: { turnId, tokenUsage: { total: { inputTokens: 12, outputTokens: 5 } } } });\n' +
          '    }, 5);\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.id === 'tool_req_1' || message.id === 'tool_req_2') {\n" +
          '    record(message);\n' +
          "    if (message.id === 'tool_req_1' && message.result) {\n" +
          '      setTimeout(function completeTurn() {\n' +
          "        send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '      }, 5);\n' +
          '    }\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const previousPath = process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
      process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = responsesPath;
      let manager = null;
      try {
        manager = new CodexSessionManager({
          requestTimeoutMs: 5_000,
          codex: {
            command: codexPath,
            cwd: tempDir,
            idleTimeoutMs: 0,
          },
        });
        const initialRequest = {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Call the lookup tool.' }],
          tools: [
            {
              name: 'lookup',
              input_schema: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                },
              },
            },
          ],
        };

        const toolUse = await manager.processRequest(gatewayRequest(), initialRequest, codexRoute());
        await waitForFile(responsesPath);

        const firstResponses = JSON.parse(await fs.readFile(responsesPath, 'utf8'));
        const rejectedSecondCall = firstResponses.find(function findSecondResponse(message) {
          return message.id === 'tool_req_2';
        });
        assert.equal(toolUse.type, 'tool_use');
        assert.deepEqual(toolUse.toolCall, {
          id: 'call_first',
          name: 'lookup',
          input: { value: 'first' },
        });
        assert.equal(Boolean(rejectedSecondCall?.error), true);
        assert.match(rejectedSecondCall.error.message, /parallel Codex tool call call_second/u);
        assert.match(rejectedSecondCall.error.message, /call_first/u);
        assert.equal(
          firstResponses.some(function findFirstResponse(message) {
            return message.id === 'tool_req_1';
          }),
          false
        );

        const finalOutcome = await manager.processRequest(
          gatewayRequest(),
          {
            model: CODEX_REQUEST_MODEL,
            messages: [
              { role: 'user', content: 'Call the lookup tool.' },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_first',
                    name: 'lookup',
                    input: { value: 'first' },
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_first',
                    content: 'first complete',
                  },
                ],
              },
            ],
            tools: initialRequest.tools,
          },
          codexRoute()
        );
        const finalResponses = JSON.parse(await fs.readFile(responsesPath, 'utf8'));
        const continuedFirstCall = finalResponses.find(function findFirstResponse(message) {
          return message.id === 'tool_req_1';
        });

        assert.equal(finalOutcome.type, 'final');
        assert.equal(continuedFirstCall.result.success, true);
        assert.deepEqual(continuedFirstCall.result.contentItems, [
          {
            type: 'inputText',
            text: 'first complete',
          },
        ]);
        ok('parallel Codex tool calls reject later calls while preserving the first pending tool_result path');
      } finally {
        await manager?.close();
        if (previousPath === undefined) {
          delete process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES;
        } else {
          process.env.ULTRATHINK_TEST_CODEX_TOOL_RESPONSES = previousPath;
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server usage reports per-boundary input cache and reasoning deltas',
  async function testCodexUsageDeltas() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-usage-delta-'));
    const codexPath = path.join(tempDir, 'codex-usage-delta');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const readline = require('node:readline');\n" +
          'let turnCount = 0;\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'const usages = [\n' +
          '  { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 115 },\n' +
          '  { inputTokens: 160, cachedInputTokens: 50, outputTokens: 45, reasoningOutputTokens: 7, totalTokens: 162 },\n' +
          '];\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-usage' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    const turnId = `turn-${turnCount + 1}`;\n' +
          '    const usage = usages[turnCount];\n' +
          '    turnCount += 1;\n' +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function completeTurn() {\n' +
          "      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: `${turnId}-message`, delta: `done ${turnId}` } });\n" +
          "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { total: usage } } });\n" +
          "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '    }, 5);\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      try {
        const req = claudeSessionRequest('codex-usage-delta');
        const firstOutcome = await manager.processRequest(
          req,
          codexUserRequest('First usage turn.'),
          codexRoute()
        );
        const secondOutcome = await manager.processRequest(
          req,
          codexUserRequest('Second usage turn.'),
          codexRoute()
        );

        assert.deepEqual(firstOutcome.usage, {
          input_tokens: 80,
          output_tokens: 35,
          cache_read_input_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 115,
        });
        assert.deepEqual(secondOutcome.usage, {
          input_tokens: 30,
          output_tokens: 17,
          cache_read_input_tokens: 30,
          reasoning_output_tokens: 2,
          total_tokens: 47,
        });
        ok('Codex cumulative usage is translated into per-response Claude usage deltas');
      } finally {
        await manager.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'Codex app-server last-only usage snapshots do not double count session totals',
  async function testCodexLastUsageSnapshotsDoNotDoubleCountTotals() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-last-usage-'));
    const codexPath = path.join(tempDir, 'codex-last-usage');

    try {
      await makeExecutable(
        codexPath,
        '#!/usr/bin/env node\n' +
          "const readline = require('node:readline');\n" +
          'let turnCount = 0;\n' +
          'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
          'const rl = readline.createInterface({ input: process.stdin });\n' +
          "rl.on('line', function onLine(line) {\n" +
          '  const message = JSON.parse(line);\n' +
          "  if (message.method === 'initialize') {\n" +
          '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'thread/start') {\n" +
          "    send({ id: message.id, result: { thread: { id: 'thread-last-usage' } } });\n" +
          '    return;\n' +
          '  }\n' +
          "  if (message.method === 'turn/start') {\n" +
          '    const turnId = `turn-${turnCount + 1}`;\n' +
          '    turnCount += 1;\n' +
          '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
          '    setTimeout(function completeTurn() {\n' +
          "      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: `${turnId}-message`, delta: `done ${turnId}` } });\n" +
          '      if (turnCount === 1) {\n' +
          "        send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 5, outputTokens: 2 } } } });\n" +
          "        send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 7, outputTokens: 3 } } } });\n" +
          '      } else {\n' +
          "        send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { total: { inputTokens: 20, outputTokens: 8 } } } });\n" +
          '      }\n' +
          "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
          '    }, 5);\n' +
          '  }\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );

      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      try {
        const req = claudeSessionRequest('codex-last-usage');
        const firstOutcome = await manager.processRequest(
          req,
          codexUserRequest('First last-only usage turn.'),
          codexRoute()
        );
        const secondOutcome = await manager.processRequest(
          req,
          codexUserRequest('Second cumulative usage turn.'),
          codexRoute()
        );

        assert.deepEqual(firstOutcome.usage, {
          input_tokens: 7,
          output_tokens: 3,
        });
        assert.deepEqual(secondOutcome.usage, {
          input_tokens: 13,
          output_tokens: 5,
        });
        ok('repeated last-only usage snapshots update the per-session baseline once per turn');
      } finally {
        await manager.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest('Codex app-server invalid JSON rejects startup without crashing the gateway', async function testCodexInvalidJsonRejectsStartup() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-invalid-json-'));
  const codexPath = path.join(tempDir, 'codex-invalid-json');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "process.stdout.write('not-json\\n');\n" +
        'setInterval(function keepAlive() {}, 1000);\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger invalid JSON.' }],
          tools: [],
        },
        codexRoute()
      ),
      /invalid JSON/u
    );
    await manager.close();
    ok('invalid Codex app-server stdout rejects the request path instead of emitting an unhandled error');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server control socket resets fail and evict the session immediately', async function testCodexControlSocketResetEvictsSession() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-control-reset-'));
  const codexPath = path.join(tempDir, 'codex-control-reset');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    process.stderr.write('ERROR: remote app server at `unix:///tmp/app-server-control.sock` transport failed: WebSocket protocol error: Connection reset without closing handshake\\n');\n" +
        '  }\n' +
        '});\n' +
        'setInterval(function keepAlive() {}, 1000);\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        closeKillTimeoutMs: 50,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger Codex control socket reset.' }],
          tools: [],
        },
        codexRoute()
      ),
      /Connection reset without closing handshake/u
    );
    assert.equal(manager.sessions.size, 0);
    await manager.close();
    ok('Codex control socket reset stderr rejects and evicts without waiting for timeout');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server signal exits reject pending startup requests', async function testCodexSignalExitRejectsStartup() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-signal-exit-'));
  const codexPath = path.join(tempDir, 'codex-signal-exit');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "process.kill(process.pid, 'SIGKILL');\n"
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger signal exit.' }],
          tools: [],
        },
        codexRoute()
      ),
      /signal SIGKILL/u
    );
    await manager.close();
    ok('signal-killed Codex app-server processes reject pending requests immediately');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server clean exits reject pending requests instead of timing out', async function testCodexCleanExitRejectsPendingRequest() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-clean-exit-'));
  const codexPath = path.join(tempDir, 'codex-clean-exit');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    process.exit(0);\n' +
        '  }\n' +
        '});\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger clean exit.' }],
          tools: [],
        },
        codexRoute()
      ),
      /code 0 before pending requests completed/u
    );
    await manager.close();
    ok('clean app-server exits with pending RPCs are treated as failed requests immediately');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server clean exits reject active turns after turn/start resolves', async function testCodexCleanExitRejectsActiveTurn() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-clean-midturn-'));
  const codexPath = path.join(tempDir, 'codex-clean-midturn');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        "    send({ id: message.id, result: { turn: { id: 'turn-1' } } });\n" +
        '    setTimeout(function exitMidTurn() { process.exit(0); }, 20);\n' +
        '  }\n' +
        '});\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });

    await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Trigger clean mid-turn exit.' }],
          tools: [],
        },
        codexRoute()
      ),
      /code 0/u
    );
    await manager.close();
    ok('clean app-server exits after turn/start fail the active boundary immediately');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex app-server close force-kills SIGTERM-resistant children', async function testCodexCloseForceKillsStubbornChild() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-stubborn-close-'));
  const codexPath = path.join(tempDir, 'codex-stubborn-close');
  const helperPidFile =
    process.platform === 'win32' ? null : path.join(tempDir, 'codex-helper.pid');
  const previousHelperPidFile = process.env.CODEX_HELPER_PID_FILE;
  let helperPid = null;

  try {
    if (helperPidFile) {
      process.env.CODEX_HELPER_PID_FILE = helperPidFile;
    }

    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import { spawn } from 'node:child_process';\n" +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        "const helperPidFile = process.env.CODEX_HELPER_PID_FILE;\n" +
        'if (helperPidFile) {\n' +
        '  const helper = spawn(process.execPath, [\n' +
        "    '-e',\n" +
        "    \"process.on('SIGTERM', function ignoreSigterm() {}); setInterval(function keepAlive() {}, 1000);\",\n" +
        "  ], { stdio: 'ignore' });\n" +
        '  helper.unref();\n' +
        '  fs.writeFileSync(helperPidFile, String(helper.pid));\n' +
        '}\n' +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '  }\n' +
        '});\n' +
        'setInterval(function keepAlive() {}, 1000);\n'
    );

    const manager = new CodexSessionManager({
      requestTimeoutMs: 5_000,
      codex: {
        command: codexPath,
        closeKillTimeoutMs: 50,
        cwd: tempDir,
        idleTimeoutMs: 0,
      },
    });
    const session = manager.ensureSession(
      gatewayRequest(),
      {
        model: CODEX_REQUEST_MODEL,
        messages: [{ role: 'user', content: 'Prepare stubborn child.' }],
        tools: [],
      },
      codexRoute()
    );
    await session.connection.readyPromise;

    if (helperPidFile) {
      await waitForFile(helperPidFile);
      helperPid = Number(await fs.readFile(helperPidFile, 'utf8'));
      assert.equal(processExists(helperPid), true);
    }

    const start = Date.now();
    await manager.close();
    assert.equal(Date.now() - start < 1_000, true);
    if (helperPid !== null) {
      await waitForProcessExit(helperPid);
      assert.equal(processExists(helperPid), false);
    }
    ok('SIGTERM-resistant app-server children do not hang gateway shutdown');
  } finally {
    if (previousHelperPidFile === undefined) {
      delete process.env.CODEX_HELPER_PID_FILE;
    } else {
      process.env.CODEX_HELPER_PID_FILE = previousHelperPidFile;
    }
    if (helperPid !== null && processExists(helperPid)) {
      try {
        process.kill(helperPid, 'SIGKILL');
      } catch {
        // Best-effort cleanup for a failed regression test.
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex routing rejects invalid named Anthropic tool_choice explicitly', async function testCodexRejectsInvalidToolChoice() {
  let createdSessions = 0;
  const manager = new CodexSessionManager(
    {
      codex: {
        idleTimeoutMs: 0,
      },
    },
    {
      createSession() {
        createdSessions += 1;
        throw new Error('session should not be created');
      },
    }
  );

  await assert.rejects(
      manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          tool_choice: { type: 'tool', name: 'MissingTool' },
          messages: [{ role: 'user', content: 'Do not use tools.' }],
          tools: [{ name: 'AvailableTool', input_schema: { type: 'object' } }],
        },
        codexRoute()
      ),
      /selected unknown tool MissingTool/u
  );
  assert.equal(createdSessions, 0);
  ok('invalid Codex tool_choice selections fail before any app-server work starts');
});

await runTest('Codex routing rejects image blocks instead of dropping them from the transcript', async function testCodexRejectsImageBlocks() {
  let createdSessions = 0;
  const manager = new CodexSessionManager(
    {
      codex: {
        idleTimeoutMs: 0,
      },
    },
    {
      createSession() {
        createdSessions += 1;
        throw new Error('session should not be created');
      },
    }
  );

  await assert.rejects(
    manager.processRequest(
      gatewayRequest(),
      {
        model: CODEX_REQUEST_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this.' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aW1hZ2U=',
                },
              },
            ],
          },
        ],
        tools: [],
      },
      codexRoute()
    ),
    /Codex-routed gateway requests do not support image content blocks yet/u
  );
  assert.equal(createdSessions, 0);
  ok('Codex-routed image requests fail explicitly before vision content can be discarded');
});

await runTest('Codex session keys include effective tool_choice narrowing', async function testCodexToolChoiceSessionKeys() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const req = claudeSessionRequest('session-tool-choice');
  const route = codexRoute();
  const tools = [{ name: 'AvailableTool', input_schema: { type: 'object' } }];

  await manager.processRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      tool_choice: { type: 'none' },
      messages: [{ role: 'user', content: 'No tools.' }],
      tools,
    },
    route
  );
  await manager.processRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      tool_choice: { type: 'tool', name: 'AvailableTool' },
      messages: [{ role: 'user', content: 'Use the selected tool.' }],
      tools,
    },
    route
  );

  assert.equal(createdSessionKeys.length, 2);
  assert.notEqual(createdSessionKeys[0], createdSessionKeys[1]);
  ok('different effective Codex tool sets no longer reuse the same app-server thread');
});

await runTest('Codex tool_result routing survives missing follow-up tool_choice', async function testCodexToolResultRoutingIgnoresToolChoiceChurn() {
  const createdSessionKeys = [];
  const manager = stubCodexSessionManager(function recordSessionKey(sessionKey) {
    createdSessionKeys.push(sessionKey);
  });
  const req = claudeSessionRequest('session-tool-result-choice-churn');
  const route = codexRoute();
  const tools = [
    { name: 'SelectedTool', input_schema: { type: 'object' } },
    { name: 'OtherTool', input_schema: { type: 'object' } },
  ];

  const canonical = manager.ensureSession(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      tool_choice: { type: 'tool', name: 'SelectedTool' },
      messages: [{ role: 'user', content: 'Use exactly the selected tool.' }],
      tools,
    },
    route
  );
  canonical.pendingToolCall = { callId: 'call_selected' };

  await manager.streamRequest(
    req,
    {
      model: CODEX_REQUEST_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_selected',
              content: 'selected tool result',
            },
          ],
        },
      ],
      tools,
    },
    route,
    function noop() {}
  );

  assert.equal(createdSessionKeys.length, 1);
  ok('tool_result follow-ups return to the pending session even when tool_choice is absent');
});

await runTest('fresh Codex sessions seed the app-server turn with the supplied transcript', async function testCodexFreshSessionIncludesTranscript() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-transcript-'));
  const codexPath = path.join(tempDir, 'codex-transcript');
  const turnParamsPath = path.join(tempDir, 'turn-params.json');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    fs.writeFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS, JSON.stringify(message.params), "utf8");\n' +
        "    send({ id: message.id, result: { turn: { id: 'turn-1' } } });\n" +
        "    setTimeout(function completeTurn() { send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }); }, 10);\n" +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
    process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = turnParamsPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      await manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'First requirement.' },
            { role: 'assistant', content: [{ type: 'text', text: 'Prior answer.' }] },
            { role: 'user', content: 'Latest question.' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turnParams = JSON.parse(await fs.readFile(turnParamsPath, 'utf8'));
      const inputText = turnParams.input[0].text;
      assert.equal(inputText.includes('First requirement.'), true);
      assert.equal(inputText.includes('Prior answer.'), true);
      assert.equal(inputText.includes('Latest question.'), true);
      await manager.close();
      ok('fresh routed Codex sessions no longer discard prior Anthropic transcript messages');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex sessions recycle before the reported context can overflow the window', async function testCodexSessionContextPressureRecycle() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-recycle-'));
  const codexPath = path.join(tempDir, 'codex-recycle');
  const turnLogPath = path.join(tempDir, 'turn-log.json');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        'let threadCount = 0;\n' +
        'let turnCount = 0;\n' +
        'function appendTurn(entry) {\n' +
        '  const logPath = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;\n' +
        '  let turns = [];\n' +
        '  try { turns = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch {}\n' +
        '  turns.push(entry);\n' +
        '  fs.writeFileSync(logPath, JSON.stringify(turns), "utf8");\n' +
        '}\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        '    threadCount += 1;\n' +
        '    send({ id: message.id, result: { thread: { id: `thread-${threadCount}` } } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    turnCount += 1;\n' +
        '    const turnId = `turn-${turnCount}`;\n' +
        '    appendTurn({ pid: process.pid, input: message.params.input[0].text });\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        '    setTimeout(function reportUsage() {\n' +
        "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 90, outputTokens: 10 }, modelContextWindow: 120 } } });\n" +
        "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
        '    }, 10);\n' +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
    process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          inputMaxTokens: 100,
        },
      });

      // First turn reports 100 context tokens against a 100-token budget and a
      // 120-token window, exceeding the 75% recycle threshold.
      await manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
        },
        codexRoute()
      );

      await manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
            { role: 'user', content: 'again' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turns = JSON.parse(await fs.readFile(turnLogPath, 'utf8'));
      assert.equal(turns.length, 2);
      assert.notEqual(turns[0].pid, turns[1].pid);
      assert.equal(turns[1].input.includes('again'), true);
      assert.equal(turns[1].input.includes('hi'), true);
      await manager.close();
      ok('context-pressured Codex sessions are replaced by a fresh transcript-replay thread');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex learned context windows bound budgets for later sessions', async function testCodexLearnedWindowBudgets() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-learned-window-'));
  const codexPath = path.join(tempDir, 'codex-learned-window');
  const turnLogPath = path.join(tempDir, 'turn-log.json');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        'let turnCount = 0;\n' +
        'function appendTurn(entry) {\n' +
        '  const logPath = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;\n' +
        '  let turns = [];\n' +
        '  try { turns = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch {}\n' +
        '  turns.push(entry);\n' +
        '  fs.writeFileSync(logPath, JSON.stringify(turns), "utf8");\n' +
        '}\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    turnCount += 1;\n' +
        '    const turnId = `turn-${turnCount}`;\n' +
        '    appendTurn({ input: message.params.input[0].text });\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        '    setTimeout(function reportUsage() {\n' +
        "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 5, outputTokens: 2 }, modelContextWindow: 40 } } });\n" +
        "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
        '    }, 10);\n' +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
    process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          inputMaxTokens: 10_000,
        },
      });

      // First session teaches the manager the model's 40-token window.
      await manager.processRequest(
        claudeSessionRequest('learned-window-a'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
        },
        codexRoute()
      );

      // A brand-new session must render its bootstrap transcript inside the
      // learned window (40 tokens * 0.8 = 32 tokens = 96 chars), truncating
      // the long history while keeping the newest message.
      await manager.processRequest(
        claudeSessionRequest('learned-window-b'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Ancient history. '.repeat(30) },
            { role: 'assistant', content: [{ type: 'text', text: 'Long prior answer. '.repeat(30) }] },
            { role: 'user', content: 'KEEP' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turns = JSON.parse(await fs.readFile(turnLogPath, 'utf8'));
      assert.equal(turns.length, 2);
      assert.equal(turns[1].input.length <= 32 * 3, true);
      assert.equal(turns[1].input.includes('KEEP'), true);
      assert.equal(turns[1].input.includes('Ancient history'), false);
      await manager.close();
      ok('later sessions inherit the learned context window and bound their bootstrap render');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex transcript budget includes omission notices and separators', async function testCodexTranscriptBudgetIncludesNotices() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-budget-'));
  const codexPath = path.join(tempDir, 'codex-budget');
  const turnParamsPath = path.join(tempDir, 'turn-params.json');
  // Small enough to force truncation of the old messages, but large enough
  // (at the conservative 3 chars/token budget) to fit the omission notice
  // plus the newest request.
  const inputMaxTokens = 60;

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: 'thread-1' } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    fs.writeFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS, JSON.stringify(message.params), "utf8");\n' +
        "    send({ id: message.id, result: { turn: { id: 'turn-1' } } });\n" +
        "    setTimeout(function completeTurn() { send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } }); }, 10);\n" +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
    process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = turnParamsPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          inputMaxTokens,
        },
      });

      await manager.processRequest(
        gatewayRequest(),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Old requirement. '.repeat(40) },
            { role: 'assistant', content: 'Old answer. '.repeat(40) },
            { role: 'user', content: 'Newest request should survive the budget.' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turnParams = JSON.parse(await fs.readFile(turnParamsPath, 'utf8'));
      const inputText = turnParams.input[0].text;
      assert.equal(inputText.length <= inputMaxTokens * 3, true);
      assert.equal(inputText.includes('survive the budget.'), true);
      await manager.close();
      ok('final Codex transcript bootstrap stays inside the configured input budget');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('fresh Codex fork sessions start from the current request only', async function testCodexForkSessionSkipsOldTranscript() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-fork-input-'));
  const codexPath = path.join(tempDir, 'codex-fork-input');
  const turnParamsPath = path.join(tempDir, 'turn-params.jsonl');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: `thread-${message.id}` } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    fs.appendFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS, `${JSON.stringify(message.params)}\\n`, "utf8");\n' +
        '    const turnId = `turn-${message.id}`;\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        "    setTimeout(function completeTurn() { send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } }); }, 10);\n" +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
    process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = turnParamsPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
          forkIdleTimeoutMs: 0,
        },
      });
      const req = claudeSessionRequest('session-fork-input');
      const route = codexRoute();
      const firstBody = codexUserRequest('Primary canonical request.');

      await manager.processRequest(req, firstBody, route);
      const canonical = manager.ensureSession(req, firstBody, route);
      canonical.pendingToolCall = { callId: 'call_waiting' };

      await manager.processRequest(
        req,
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Very old workflow context that should not enter a fork.' },
            { role: 'assistant', content: 'Prior canonical answer that belongs to another thread.' },
            { role: 'user', content: 'Current fork side request.' },
          ],
          tools: [],
        },
        route
      );

      const turnParams = (await fs.readFile(turnParamsPath, 'utf8'))
        .trim()
        .split(/\n/u)
        .map(function parseLine(line) {
          return JSON.parse(line);
        });
      const forkInput = turnParams.at(-1).input[0].text;
      assert.equal(forkInput.includes('Current fork side request.'), true);
      assert.equal(forkInput.includes('Very old workflow context'), false);
      assert.equal(forkInput.includes('Prior canonical answer'), false);
      await manager.close();
      ok('forked side traffic no longer replays the whole accumulated Claude transcript');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex context-ish 502s that miss recovery matching are traced', async function testCodexContextDriftTracing() {
  const { entries, tracer } = captureTracer();
  const manager = new CodexSessionManager(
    {
      codex: {
        idleTimeoutMs: 0,
        forkIdleTimeoutMs: 0,
        maxSessions: 16,
      },
    },
    {
      tracer,
      createSession(route, req, requestBody, sessionKey) {
        return stubCodexSession(sessionKey, {
          async advance() {
            throw new GatewayError(
              502,
              'api_error',
              'provider input token budget exceeded before generation'
            );
          },
        });
      },
    }
  );

  await assert.rejects(
    manager.processRequest(
      claudeSessionRequest('session-context-drift'),
      codexUserRequest('Trigger unmatched context-ish 502.'),
      codexRoute()
    ),
    /token budget exceeded/u
  );

  assert.equal(
    entries.some(function hasDriftTrace(entry) {
      return entry.event === 'codex.session.context_recovery_unmatched';
    }),
    true
  );
  ok('context-like Codex 502 wording drift is traceable even when recovery does not engage');
});

await runTest('Codex first-turn transcript overflow recovers straight to latest-only input', async function testCodexContextWindowRecovery() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-context-retry-'));
  const codexPath = path.join(tempDir, 'codex-context-retry');
  const turnParamsPath = path.join(tempDir, 'turn-params.jsonl');
  const failureMarkerPath = path.join(tempDir, 'failed-once');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: `thread-${message.id}` } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    fs.appendFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS, `${JSON.stringify(message.params)}\\n`, "utf8");\n' +
        '    const turnId = `turn-${message.id}`;\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        '    let failCount = 0;\n' +
        '    try { failCount = Number(fs.readFileSync(process.env.ULTRATHINK_TEST_CODEX_FAILURE_MARKER, "utf8")); } catch {}\n' +
        '    if (failCount < 1) {\n' +
        '      fs.writeFileSync(process.env.ULTRATHINK_TEST_CODEX_FAILURE_MARKER, String(failCount + 1), "utf8");\n' +
        "      setTimeout(function failTurn() { send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'failed', error: { message: \"Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.\" } } } }); }, 10);\n" +
        '      return;\n' +
        '    }\n' +
        "    setTimeout(function completeTurn() {\n" +
        "      send({ method: 'item/completed', params: { turnId, item: { id: 'msg-1', type: 'agentMessage', text: 'RECOVERED' } } });\n" +
        "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
        '    }, 10);\n' +
        '  }\n' +
        '});\n'
    );

    const previous = {
      ULTRATHINK_TEST_CODEX_TURN_PARAMS: process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS,
      ULTRATHINK_TEST_CODEX_FAILURE_MARKER:
        process.env.ULTRATHINK_TEST_CODEX_FAILURE_MARKER,
    };
    process.env.ULTRATHINK_TEST_CODEX_TURN_PARAMS = turnParamsPath;
    process.env.ULTRATHINK_TEST_CODEX_FAILURE_MARKER = failureMarkerPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      const outcome = await manager.processRequest(
        claudeSessionRequest('session-context-retry'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Very old context that should be dropped on recovery.' },
            { role: 'assistant', content: 'Prior answer that exhausted the old thread.' },
            { role: 'user', content: 'Current request after context overflow.' },
          ],
          tools: [],
        },
        codexRoute()
      );

      const turnParams = (await fs.readFile(turnParamsPath, 'utf8'))
        .trim()
        .split(/\n/u)
        .map(function parseLine(line) {
          return JSON.parse(line);
        });
      assert.equal(outcome.text, 'RECOVERED');
      // A first-turn transcript bootstrap that overflowed would fail again
      // byte-identically on a transcript retry, so recovery must skip
      // straight to latest-only input: exactly two turns.
      assert.equal(turnParams.length, 2);
      assert.equal(turnParams[0].input[0].text.includes('Very old context'), true);
      assert.equal(turnParams[1].input[0].text.includes('Current request after context overflow.'), true);
      assert.equal(turnParams[1].input[0].text.includes('Very old context'), false);
      await manager.close();
      ok('first-turn transcript overflow skips the doomed transcript retry and recovers latest-only');
    } finally {
      restoreEnv(previous);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('Codex live-session overflow retries with transcript replay before latest-only', async function testCodexLiveSessionOverflowRecovery() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-codex-live-retry-'));
  const codexPath = path.join(tempDir, 'codex-live-retry');
  const turnLogPath = path.join(tempDir, 'turn-log.jsonl');

  try {
    await makeExecutable(
      codexPath,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';\n" +
        "import readline from 'node:readline';\n" +
        'const rl = readline.createInterface({ input: process.stdin });\n' +
        'function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }\n' +
        'let turnCount = 0;\n' +
        "rl.on('line', function onLine(line) {\n" +
        '  const message = JSON.parse(line);\n' +
        "  if (message.method === 'initialize') {\n" +
        '    send({ id: message.id, result: { protocolVersion: 2 } });\n' +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'thread/start') {\n" +
        "    send({ id: message.id, result: { thread: { id: `thread-${process.pid}` } } });\n" +
        '    return;\n' +
        '  }\n' +
        "  if (message.method === 'turn/start') {\n" +
        '    turnCount += 1;\n' +
        '    const turnId = `turn-${turnCount}`;\n' +
        '    fs.appendFileSync(process.env.ULTRATHINK_TEST_CODEX_TURN_LOG, `${JSON.stringify({ pid: process.pid, turn: turnCount, input: message.params.input[0].text })}\\n`, "utf8");\n' +
        '    send({ id: message.id, result: { turn: { id: turnId } } });\n' +
        '    if (turnCount === 2) {\n' +
        '      // Overflow only on the live session follow-up turn.\n' +
        "      setTimeout(function failTurn() { send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'failed', error: { message: \"Codex ran out of room in the model's context window.\" } } } }); }, 10);\n" +
        '      return;\n' +
        '    }\n' +
        '    setTimeout(function completeTurn() {\n' +
        "      send({ method: 'thread/tokenUsage/updated', params: { turnId, tokenUsage: { last: { inputTokens: 5, outputTokens: 2 } } } });\n" +
        "      send({ method: 'item/completed', params: { turnId, item: { id: `msg-${turnCount}`, type: 'agentMessage', text: 'OK' } } });\n" +
        "      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });\n" +
        '    }, 10);\n' +
        '  }\n' +
        '});\n'
    );

    const previousTarget = process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
    process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = turnLogPath;
    try {
      const manager = new CodexSessionManager({
        requestTimeoutMs: 5_000,
        codex: {
          command: codexPath,
          cwd: tempDir,
          idleTimeoutMs: 0,
        },
      });

      const first = await manager.processRequest(
        claudeSessionRequest('live-retry'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [{ role: 'user', content: 'Original question about the code.' }],
          tools: [],
        },
        codexRoute()
      );
      assert.equal(first.text, 'OK');

      const second = await manager.processRequest(
        claudeSessionRequest('live-retry'),
        {
          model: CODEX_REQUEST_MODEL,
          messages: [
            { role: 'user', content: 'Original question about the code.' },
            { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
            { role: 'user', content: 'Follow-up request that overflows.' },
          ],
          tools: [],
        },
        codexRoute()
      );
      assert.equal(second.text, 'OK');

      const turns = (await fs.readFile(turnLogPath, 'utf8'))
        .trim()
        .split(/\n/u)
        .map(function parseLine(line) {
          return JSON.parse(line);
        });
      assert.equal(turns.length, 3);
      // A live session with recorded usage recovers via transcript replay:
      // the retry keeps the prior conversation.
      assert.equal(turns[2].pid === turns[0].pid, false);
      assert.equal(turns[2].input.includes('Original question about the code.'), true);
      assert.equal(turns[2].input.includes('Follow-up request that overflows.'), true);
      await manager.close();
      ok('live-session overflow recovers on a transcript-replay thread with context preserved');
    } finally {
      if (previousTarget === undefined) {
        delete process.env.ULTRATHINK_TEST_CODEX_TURN_LOG;
      } else {
        process.env.ULTRATHINK_TEST_CODEX_TURN_LOG = previousTarget;
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('claude-workflow-gateway daemon publishes env exports and serves healthz', async function testWorkflowGatewayDaemon() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-workflow-daemon-'));
  const envFile = path.join(tempDir, 'gateway.env');
  const daemonPath = new URL('../js/cli/claude-workflow-daemon.js', import.meta.url).pathname;

  const child = spawn(process.execPath, [daemonPath], {
    env: {
      ...process.env,
      ULTRATHINK_GATEWAY_DAEMON_PORT: '0',
      CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: envFile,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', function onStderr(chunk) {
    stderr += chunk.toString();
  });

  try {
    let envText = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        envText = await fs.readFile(envFile, 'utf8');
        break;
      } catch {
        await new Promise(function wait(resolve) {
          setTimeout(resolve, 250);
        });
      }
    }
    assert.notEqual(envText, '', `daemon never wrote env file; stderr: ${stderr}`);
    const baseUrlMatch = envText.match(/^export ANTHROPIC_BASE_URL="([^"]+)"$/mu);
    assert.notEqual(baseUrlMatch, null);
    assert.match(envText, /^export CLAUDE_CODE_SUBAGENT_MODEL="[^"]+"$/mu);
    assert.match(envText, /^export ANTHROPIC_DEFAULT_SONNET_MODEL="[^"]+"$/mu);

    const health = await fetch(`${baseUrlMatch[1]}/healthz`);
    assert.equal(health.ok, true);
    ok('daemon starts on an OS-assigned port, serves healthz, and publishes shell exports');
  } finally {
    child.kill('SIGTERM');
    await new Promise(function waitExit(resolve) {
      child.on('close', resolve);
      setTimeout(resolve, 3_000);
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('claude-workflow daemon script starts and stops the recorded daemon pid', async function testWorkflowGatewayDaemonScriptLifecycle() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-workflow-daemon-script-'));
  const daemonScript = path.resolve('scripts/claude-workflow-daemon.sh');
  const envFile = path.join(tempDir, 'gateway.env');
  const pidFile = path.join(tempDir, 'claude-workflow-gateway.pid');
  const port = await freePort();
  let daemonPid = 0;

  const env = {
    ...process.env,
    ...CLEAN_WORKFLOW_ENV,
    CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: envFile,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: tempDir,
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(port),
  };

  try {
    const start = await runProcess('bash', [daemonScript, 'start'], env);
    assert.equal(start.code, 0, start.stderr || start.stdout);
    await waitForFile(envFile);

    daemonPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    assert.equal(processExists(daemonPid), true);

    const status = await runProcess('bash', [daemonScript, 'status'], env);
    assert.equal(status.code, 0, status.stderr || status.stdout);

    const stop = await runProcess('bash', [daemonScript, 'stop'], env);
    assert.equal(stop.code, 0, stop.stderr || stop.stdout);
    await waitForProcessExit(daemonPid);
    daemonPid = 0;
    ok('daemon script lifecycle manages the recorded pid on Linux and macOS shells');
  } finally {
    if (daemonPid > 0 && processExists(daemonPid)) {
      try {
        process.kill(daemonPid, 'SIGTERM');
        await waitForProcessExit(daemonPid);
      } catch {
        try {
          process.kill(daemonPid, 'SIGKILL');
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('claude-workflow daemon script installs shell hooks for the active shell', async function testWorkflowGatewayDaemonInstallShell() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-workflow-shell-hook-'));
  const daemonScript = path.resolve('scripts/claude-workflow-daemon.sh');

  try {
    const zshInstall = await runProcess('bash', [daemonScript, 'install-shell'], {
      ...process.env,
      HOME: tempDir,
      SHELL: '/bin/zsh',
    });
    assert.equal(zshInstall.code, 0, zshInstall.stderr || zshInstall.stdout);
    const zshrc = await fs.readFile(path.join(tempDir, '.zshrc'), 'utf8');
    assert.match(zshrc, /claude-workflow-gateway\.bashrc/u);

    const bashInstall = await runProcess('bash', [daemonScript, 'install-shell'], {
      ...process.env,
      HOME: tempDir,
      SHELL: '/bin/bash',
    });
    assert.equal(bashInstall.code, 0, bashInstall.stderr || bashInstall.stdout);
    const bashrc = await fs.readFile(path.join(tempDir, '.bashrc'), 'utf8');
    assert.match(bashrc, /claude-workflow-gateway\.bashrc/u);
    ok('install-shell writes the hook to zshrc for zsh users and bashrc for bash users');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

await runTest('gateway route-map config can define custom exposed model routes', async function testRouteMapConfig() {
  const previous = {
    ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: process.env.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON,
    ULTRATHINK_GATEWAY_EXPOSED_MODELS: process.env.ULTRATHINK_GATEWAY_EXPOSED_MODELS,
  };

  try {
    delete process.env.ULTRATHINK_GATEWAY_EXPOSED_MODELS;
    process.env.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON = JSON.stringify({
      'claude-codex-review': {
        provider: 'openai',
        model: 'gpt-5.5',
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        reasoningEffort: 'medium',
        verbosity: 'low',
        displayName: 'Codex Review Route',
      },
    });

    const config = loadGatewayConfig();
    assert.deepEqual(config.exposedModels, ['claude-codex-review']);
    assert.equal(config.routeMap['claude-codex-review'].provider, 'openai');
    assert.equal(config.routeMap['claude-codex-review'].sandbox, 'workspace-write');
    assert.equal(config.routeMap['claude-codex-review'].approvalPolicy, 'never');
    ok('route-map JSON can define custom exposed model ids');
  } finally {
    restoreEnv(previous);
  }
});

await runTest('gateway enforces auth for /v1 and exposes Claude-shaped model discovery', async function testGatewayModels() {
  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    sharedSecret: 'test-secret',
    exposedModels: ['claude-opus-4-8', 'claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
    },
    anthropic: {
      apiKey: 'anthropic-key',
    },
  }));

  await waitForListening(runtime.server);

  try {
    const health = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
    assert.equal(health.status, 200);
    const healthPayload = await health.json();
    assert.equal(healthPayload.display_routed_model, false);
    assert.deepEqual(healthPayload.anthropic_passthrough_models, ['claude-opus-4-8*']);

    const unauthorized = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: { authorization: 'Bearer test-secret' },
    });
    assert.equal(authorized.status, 200);
    const payload = await authorized.json();
    assert.deepEqual(
      payload.data.map(function ids(model) {
        return model.id;
      }),
      ['claude-opus-4-8', 'claude-sonnet-4-7']
    );
    assert.match(payload.data[1].display_name, /Codex profile gpt-5\.5\/low/u);
    ok('model discovery is Claude-shaped and auth-gated');
  } finally {
    await runtime.close();
  }
});

await runTest('gateway authenticates before parsing malformed /v1 JSON bodies', async function testGatewayMalformedJsonAuthOrdering() {
  const gatewayPort = await freePort();
  const app = createGatewayApp(
    gatewayConfig({
      sharedSecret: 'test-secret',
      exposedModels: ['claude-sonnet-4-7'],
      openai: {
        apiKey: 'openai-key',
      },
      anthropic: {
        apiKey: 'anthropic-key',
      },
    }),
    null
  );
  const server = app.listen(gatewayPort, '127.0.0.1');
  await waitForListening(server);

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{"model":',
    });
    assert.equal(unauthorized.status, 401);

    const malformed = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders({
        authorization: 'Bearer test-secret',
      }),
      body: '{"model":',
    });
    assert.equal(malformed.status, 400);
    const payload = await malformed.json();
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'invalid_request_error');

    const health = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`);
    assert.equal(health.status, 200);
    ok('malformed /v1 JSON is auth-gated first and then returned as an Anthropic-shaped 400');
  } finally {
    await closeServer(server);
  }
});

await runTest('gateway does not forward the shared secret to Anthropic passthrough', async function testGatewaySharedSecretAnthropicPassthrough() {
  const upstreamPort = await freePort();
  let capturedHeaders = null;

  const upstream = http.createServer(async function handleAnthropic(req, res) {
    capturedHeaders = req.headers;
    await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  });
  upstream.listen(upstreamPort, '127.0.0.1');
  await waitForListening(upstream);

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    sharedSecret: 'gateway-secret',
    exposedModels: ['claude-opus-4-8'],
    openai: {
      apiKey: 'openai-key',
    },
    anthropic: {
      apiKey: 'anthropic-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders({
        authorization: 'Bearer gateway-secret',
      }),
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(capturedHeaders.authorization, undefined);
    assert.equal(capturedHeaders['x-api-key'], 'anthropic-key');
    ok('Anthropic passthrough uses the configured upstream key instead of leaking the gateway secret');
  } finally {
    await runtime.close();
    await closeServer(upstream);
  }
});

await runTest('gateway preserves path prefixes when joining Anthropic upstream URLs', async function testGatewayAnthropicBasePathPrefix() {
  const upstreamPort = await freePort();
  let capturedUrl = null;
  let capturedBody = null;

  const upstream = http.createServer(async function handleAnthropic(req, res) {
    capturedUrl = req.url;
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'msg_path_prefix',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  });
  upstream.listen(upstreamPort, '127.0.0.1');
  await waitForListening(upstream);

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-opus-4-8'],
    openai: {
      apiKey: 'openai-key',
    },
    anthropic: {
      apiKey: 'anthropic-key',
      baseUrl: `http://127.0.0.1:${upstreamPort}/proxy`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, '/proxy/v1/messages');
    assert.equal(capturedBody.model, 'claude-opus-4-8');
    ok('Anthropic passthrough keeps configured upstream base path prefixes');
  } finally {
    await runtime.close();
    await closeServer(upstream);
  }
});

await runTest('gateway honors HTTP_PROXY and NO_PROXY for upstream JSON requests', async function testGatewayAnthropicPassthroughProxy() {
  const upstreamPort = await freePort();
  const proxyPort = await freePort();
  const gatewayPort = await freePort();
  let capturedUpstreamUrl = null;
  let capturedProxyUrl = null;
  let proxyRequestCount = 0;

  const upstream = http.createServer(async function handleAnthropic(req, res) {
    capturedUpstreamUrl = req.url;
    await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'msg_proxy',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'proxied ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  });
  upstream.listen(upstreamPort, '127.0.0.1');
  await waitForListening(upstream);

  const proxy = http.createServer(function handleProxy(req, res) {
    res.writeHead(502, jsonHeaders());
    res.end(JSON.stringify({ error: `unexpected proxy request ${req.method} ${req.url}` }));
  });
  proxy.on('connect', function handleProxyConnect(req, clientSocket, head) {
    proxyRequestCount += 1;
    capturedProxyUrl = req.url;
    const separator = req.url.lastIndexOf(':');
    const hostname = req.url.slice(0, separator);
    const port = Number(req.url.slice(separator + 1));
    const upstreamSocket = net.connect(port, hostname, function connectUpstream() {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.on('error', function failProxy() {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    clientSocket.on('error', function ignoreClientSocketError() {});
  });
  proxy.listen(proxyPort, '127.0.0.1');
  await waitForListening(proxy);

  function createAnthropicProxyGateway(port) {
    return createGatewayServer(gatewayConfig({
      port,
      exposedModels: ['claude-opus-4-8'],
      openai: {
        apiKey: 'openai-key',
      },
      anthropic: {
        apiKey: 'anthropic-key',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
      },
    }));
  }

  function postAnthropicProxyGatewayMessage(port, content) {
    return fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 128,
        messages: [{ role: 'user', content }],
      }),
    });
  }

  try {
    await withTemporaryEnv(
      cleanProxyEnv({
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      }),
      async function assertProxyRouting() {
        const runtime = createAnthropicProxyGateway(gatewayPort);
        await waitForListening(runtime.server);

        try {
          const response = await postAnthropicProxyGatewayMessage(
            gatewayPort,
            'hello through proxy'
          );

          assert.equal(response.status, 200);
          assert.equal(proxyRequestCount, 1);
          assert.equal(capturedProxyUrl, `127.0.0.1:${upstreamPort}`);
          assert.equal(capturedUpstreamUrl, '/v1/messages');
        } finally {
          await runtime.close();
        }
      }
    );

    capturedUpstreamUrl = null;
    await withTemporaryEnv(
      cleanProxyEnv({
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: '127.0.0.1',
      }),
      async function assertNoProxyBypass() {
        const noProxyGatewayPort = await freePort();
        const runtime = createAnthropicProxyGateway(noProxyGatewayPort);
        await waitForListening(runtime.server);

        try {
          const response = await postAnthropicProxyGatewayMessage(
            noProxyGatewayPort,
            'hello around proxy'
          );

          assert.equal(response.status, 200);
          assert.equal(proxyRequestCount, 1);
          assert.equal(capturedUpstreamUrl, '/v1/messages');
        } finally {
          await runtime.close();
        }
      }
    );
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }

  ok('Anthropic passthrough upstream requests honor configured HTTP proxy and NO_PROXY settings');
});

await runTest('gateway rejects unsupported proxy URL schemes clearly', async function testGatewayUnsupportedProxyScheme() {
  const gatewayPort = await freePort();

  await withTemporaryEnv(
    cleanProxyEnv({
      ALL_PROXY: 'socks5://127.0.0.1:1080',
    }),
    async function assertUnsupportedProxyScheme() {
      const runtime = createGatewayServer(gatewayConfig({
        port: gatewayPort,
        exposedModels: ['claude-opus-4-8'],
        openai: {
          apiKey: 'openai-key',
        },
        anthropic: {
          apiKey: 'anthropic-key',
          baseUrl: 'http://127.0.0.1:1',
        },
      }));
      await waitForListening(runtime.server);

      try {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            max_tokens: 128,
            messages: [{ role: 'user', content: 'hello unsupported proxy' }],
          }),
        });
        const body = await response.json();

        assert.equal(response.status, 502);
        assert.match(
          body.error.message,
          /Unsupported proxy URL scheme "socks5:" for gateway upstream requests/u
        );
      } finally {
        await runtime.close();
      }
    }
  );

  ok('unsupported proxy schemes fail with a clear gateway error');
});

await runTest(
  'gateway emits a stream error event instead of silently truncating a started SSE response',
  async function testGatewayStreamErrorEvent() {
    const gatewayPort = await freePort();
    const codexSessions = {
      async streamRequest(req, requestBody, route, onEvent) {
        onEvent({ type: 'text_delta', text: 'partial' });
        throw new Error('synthetic stream failure');
      },
      async close() {},
    };
    const app = createGatewayApp(
      gatewayConfig({
        port: gatewayPort,
        exposedModels: ['claude-sonnet-4-7'],
        codex: {
          reasoningEffort: 'low',
          verbosity: 'low',
        },
      }),
      codexSessions,
      null
    );
    const server = app.listen(gatewayPort, '127.0.0.1');
    await waitForListening(server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-sonnet-4-7',
          stream: true,
          messages: [{ role: 'user', content: 'Stream through Codex.' }],
        }),
      });
      assert.equal(response.status, 200);
      const bodyText = await response.text();
      const events = parseSsePayloads(bodyText);
      const errorEvent = events.find(function findError(event) {
        return event.name === 'error';
      });
      assert.equal(Boolean(errorEvent), true);
      assert.equal(errorEvent.payload.error.message, 'synthetic stream failure');
      ok('started SSE streams surface a terminal error event instead of truncating silently');
    } finally {
      await closeServer(server);
    }
  }
);

await runTest(
  'claude-workflow requires a gateway-side Anthropic key when a shared secret protects an Anthropic main route',
  async function testWorkflowCliSharedSecretRequiresAnthropicKey() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-shared-secret-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');

    try {
      await makeClaudeShouldNotRunCommand(claudePath);
      await makeCodexLoginStatusCommand(codexPath);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_SHARED_SECRET: 'gateway-secret',
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: '',
          ANTHROPIC_API_KEY: '',
        }
      );

      assert.equal(result.code, 1);
      assert.equal(
        result.stderr.includes('Set ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY'),
        true
      );
      ok(
        'claude-workflow fails fast when a shared-secret gateway would break the default Anthropic main route'
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow reports missing command and Codex login preflight failures',
  async function testWorkflowCliCommandAndLoginPreflightFailures() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-preflight-'));
    const claudePath = path.join(tempDir, 'claude');
    const loggedInCodexPath = path.join(tempDir, 'codex-logged-in');
    const loggedOutCodexPath = path.join(tempDir, 'codex-logged-out');
    const signedOutCodexPath = path.join(tempDir, 'codex-signed-out');
    const missingCodexPath = path.join(tempDir, 'missing-codex');

    async function runLauncher(envOverrides = {}) {
      return runProcess(
        process.execPath,
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: tempDir,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
          ...envOverrides,
        }
      );
    }

    try {
      await makeCodexLoginStatusCommand(loggedInCodexPath, 'Authenticated as test-user');
      await makeCodexLoginStatusCommand(loggedOutCodexPath, 'Not logged in');
      await makeCodexLoginStatusCommand(signedOutCodexPath, 'Not signed in');

      const missingClaude = await runLauncher({
        ULTRATHINK_GATEWAY_CODEX_COMMAND: loggedInCodexPath,
      });
      assert.equal(missingClaude.code, 1);
      assert.match(missingClaude.stderr, /claude CLI not found on PATH/u);

      await makeClaudeShouldNotRunCommand(claudePath);

      const missingCodex = await runLauncher({
        ULTRATHINK_GATEWAY_CODEX_COMMAND: missingCodexPath,
      });
      assert.equal(missingCodex.code, 1);
      assert.match(missingCodex.stderr, /missing-codex not found or not executable/u);

      const loggedOutCodex = await runLauncher({
        ULTRATHINK_GATEWAY_CODEX_COMMAND: loggedOutCodexPath,
      });
      assert.equal(loggedOutCodex.code, 1);
      assert.match(loggedOutCodex.stderr, /codex-logged-out is not logged in/u);
      assert.match(loggedOutCodex.stderr, /Run `.*codex-logged-out login` first/u);

      const signedOutCodex = await runLauncher({
        ULTRATHINK_GATEWAY_CODEX_COMMAND: signedOutCodexPath,
      });
      assert.equal(signedOutCodex.code, 1);
      assert.match(signedOutCodex.stderr, /codex-signed-out is not logged in/u);

      ok('claude-workflow fails preflight clearly before launching Claude');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow injects the gateway shared secret into the child Claude process',
  async function testWorkflowCliInjectsGatewaySecret() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-launch-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const capturedEnvPath = path.join(tempDir, 'claude-env.json');

    try {
      await makeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          'const target = process.env.ULTRATHINK_TEST_CLAUDE_ENV_PATH;\n' +
          'fs.writeFileSync(target, JSON.stringify({\n' +
          "  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || '',\n" +
          "  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',\n" +
          "  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',\n" +
          "  CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL || '',\n" +
          "  NO_PROXY: process.env.NO_PROXY || '',\n" +
          "  no_proxy: process.env.no_proxy || '',\n" +
          "}), 'utf8');\n" +
          "process.stdout.write('CLI_OK\\n');\n"
      );
      await makeCodexLoginStatusCommand(codexPath);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly CLI_OK.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_SHARED_SECRET: 'gateway-secret',
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'anthropic-key',
          ULTRATHINK_TEST_CLAUDE_ENV_PATH: capturedEnvPath,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
          ...cleanProxyEnv({
            HTTP_PROXY: 'http://proxy.local:8080',
            NO_PROXY: 'localhost',
          }),
        }
      );

      assert.equal(result.code, 0);
      const capturedEnv = JSON.parse(await fs.readFile(capturedEnvPath, 'utf8'));
      assert.equal(capturedEnv.ANTHROPIC_AUTH_TOKEN, 'gateway-secret');
      assert.equal(capturedEnv.ANTHROPIC_API_KEY, 'gateway-secret');
      assert.equal(capturedEnv.CLAUDE_CODE_SUBAGENT_MODEL, WORKFLOW_DISPLAY_SUBAGENT_MODEL);
      assert.equal(capturedEnv.ANTHROPIC_BASE_URL.startsWith('http://127.0.0.1:'), true);
      assert.equal(capturedEnv.NO_PROXY, 'localhost,127.0.0.1');
      assert.equal(capturedEnv.no_proxy, 'localhost,127.0.0.1');
      ok('claude-workflow passes gateway auth and local proxy bypass env to the child Claude process');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow sends plain Anthropic API model ids for [1m] main aliases',
  async function testWorkflowCliOneMillionAnthropicMainRoute() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-opus-1m-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const responsePath = path.join(tempDir, 'claude-response.json');
    const anthropicPort = await freePort();
    const seenBodies = [];

    const anthropicServer = http.createServer(async function handleAnthropic(req, res) {
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(404);
        res.end();
        return;
      }

      const body = await readJsonBody(req);
      seenBodies.push(body);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'msg_opus_1m',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'OPUS_1M_OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 3 },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      anthropicServer.once('error', reject);
      anthropicServer.listen(anthropicPort, '127.0.0.1', resolve);
    });

    try {
      await makeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          'async function main() {\n' +
          '  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {\n' +
          "    method: 'POST',\n" +
          "    headers: { 'content-type': 'application/json' },\n" +
          '    body: JSON.stringify({\n' +
          "      model: 'claude-opus-4-8[1m]',\n" +
          "      messages: [{ role: 'user', content: 'Use the 1m alias.' }],\n" +
          '    }),\n' +
          '  });\n' +
          '  const payload = await response.json();\n' +
          "  fs.writeFileSync(process.env.ULTRATHINK_TEST_CLAUDE_RESPONSE_PATH, JSON.stringify(payload), 'utf8');\n" +
          '  if (!response.ok) process.exit(1);\n' +
          '}\n' +
          'main().catch(function onError(error) {\n' +
          '  console.error(error.stack || error.message);\n' +
          '  process.exit(1);\n' +
          '});\n'
      );
      await makeCodexLoginStatusCommand(codexPath);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Trigger fake Claude request.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'claude-opus-4-8[1m]',
          ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'anthropic',
          ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'claude-opus-4-8*',
          ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'anthropic-key',
          ULTRATHINK_GATEWAY_ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicPort}`,
          ULTRATHINK_TEST_CLAUDE_RESPONSE_PATH: responsePath,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );

      assert.equal(result.code, 0);
      const payload = JSON.parse(await fs.readFile(responsePath, 'utf8'));
      assert.equal(seenBodies.length, 1);
      assert.equal(seenBodies[0].model, 'claude-opus-4-8');
      assert.equal(payload.model, 'claude-opus-4-8');
      ok('claude-workflow preserves the [1m] client alias while sending the plain Anthropic API id upstream');
    } finally {
      await closeServer(anthropicServer);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow enables routed model display metadata by default',
  async function testWorkflowCliDisplayRoutedModelDefault() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-display-model-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');

    async function runLauncherWithDisplayEnv(captureName, envOverrides = {}) {
      const healthPath = path.join(tempDir, captureName);
      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly CLI_OK.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL: '',
          CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL: '',
          ULTRATHINK_TEST_CLAUDE_HEALTH_PATH: healthPath,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
          ...envOverrides,
        }
      );

      return { healthPath, result };
    }

    async function runWithDisplayEnv(captureName, envOverrides = {}) {
      const { healthPath, result } = await runLauncherWithDisplayEnv(
        captureName,
        envOverrides
      );

      assert.equal(result.code, 0);
      return JSON.parse(await fs.readFile(healthPath, 'utf8'));
    }

    function modelDisplayName(payload, modelId) {
      return payload.models.data.find(function hasModelId(model) {
        return model.id === modelId;
      })?.display_name;
    }

    try {
      await makeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "const fs = require('node:fs');\n" +
          'async function main() {\n' +
          '  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/healthz`);\n' +
          '  const health = await response.json();\n' +
          '  const modelsResponse = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/models`);\n' +
          '  const models = await modelsResponse.json();\n' +
          '  const payload = {\n' +
          '    health,\n' +
          '    models,\n' +
          "    subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL || '',\n" +
          '  };\n' +
          "  fs.writeFileSync(process.env.ULTRATHINK_TEST_CLAUDE_HEALTH_PATH, JSON.stringify(payload), 'utf8');\n" +
          "  process.stdout.write('CLI_OK\\n');\n" +
          '}\n' +
          'main().catch(function onError(error) {\n' +
          '  console.error(error.stack || error.message);\n' +
          '  process.exit(1);\n' +
          '});\n'
      );
      await makeCodexLoginStatusCommand(codexPath);

      const defaultHealth = await runWithDisplayEnv('default-health.json');
      const optedOutHealth = await runWithDisplayEnv('opted-out-health.json', {
        CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL: 'false',
      });
      const workflowOptOutHealth = await runWithDisplayEnv('workflow-opt-out-health.json', {
        CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL: 'false',
        ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL: 'true',
      });
      const customRouteHealth = await runWithDisplayEnv('custom-route-health.json', {
        ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
          'claude-sonnet-4-7': {
            provider: 'codex',
            upstream_model: 'gpt-custom',
            reasoning_effort: 'xhigh',
            verbosity: 'low',
          },
        }),
      });
      const frontierHealth = await runWithDisplayEnv('frontier-health.json', {
        ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'claude-fable-5',
        ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'claude-fable-5*',
        ULTRATHINK_GATEWAY_CODEX_MODEL: 'gpt-5.5',
        ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT: 'xhigh',
        ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-5.5',
        ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT: 'xhigh',
      });
      const deepSeekMainHealth = await runWithDisplayEnv('deepseek-main-health.json', {
        ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'deepseek',
        ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY: 'deepseek-key',
        ULTRATHINK_GATEWAY_DEEPSEEK_MODEL: 'deepseek-v4-pro',
        ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT: 'max',
        ULTRATHINK_GATEWAY_EXPOSED_MODELS: 'claude-fable-5-20260601',
      });
      const collisionHealth = await runWithDisplayEnv('main-subagent-collision-health.json', {
        ULTRATHINK_GATEWAY_MAIN_MODEL_ID: 'claude-sonnet-4-7',
        ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID: 'claude-sonnet-4-7',
      });
      const invalidRoute = await runLauncherWithDisplayEnv('invalid-route-health.json', {
        ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
          'claude-sonnet-4-7': {
            provider: 'bogus',
          },
        }),
      });

      assert.equal(defaultHealth.health.display_routed_model, true);
      assert.equal(defaultHealth.subagentModel, WORKFLOW_DISPLAY_SUBAGENT_MODEL);
      // The launcher now defaults the frontier main model to Fable 5 1m and keeps
      // the Fable 5 family on Anthropic; lower-tier Claude ids route to Codex gpt-5.5.
      assert.deepEqual(
        defaultHealth.health.anthropic_passthrough_models,
        ['claude-fable-5*']
      );
      assert.equal(
        defaultHealth.health.exposed_models.includes('claude-fable-5[1m]'),
        true
      );
      assert.equal(defaultHealth.health.codex_target_model, 'gpt-5.5');
      assert.match(
        modelDisplayName(defaultHealth, 'claude-opus-4-8') || '',
        /Codex gpt-5\.5/u
      );
      assert.equal(optedOutHealth.health.display_routed_model, false);
      assert.equal(optedOutHealth.subagentModel, 'claude-sonnet-4-7');
      assert.equal(workflowOptOutHealth.health.display_routed_model, false);
      assert.equal(workflowOptOutHealth.subagentModel, 'claude-sonnet-4-7');
      assert.equal(customRouteHealth.subagentModel, 'codex-gpt-custom-xhigh-via-claude-sonnet-4-7');
      assert.equal(
        customRouteHealth.health.exposed_models.includes(customRouteHealth.subagentModel),
        true
      );
      assert.deepEqual(frontierHealth.health.anthropic_passthrough_models, ['claude-fable-5*']);
      assert.equal(frontierHealth.health.codex_target_model, 'gpt-5.5');
      assert.equal(frontierHealth.health.codex_reasoning_effort, 'xhigh');
      assert.equal(
        frontierHealth.health.exposed_models.includes('claude-fable-5'),
        true
      );
      assert.equal(
        frontierHealth.subagentModel,
        'codex-gpt-5.5-xhigh-via-claude-sonnet-4-7'
      );
      assert.equal(deepSeekMainHealth.health.deepseek_model, 'deepseek-v4-pro');
      assert.equal(deepSeekMainHealth.health.deepseek_reasoning_effort, 'max');
      assert.equal(
        modelDisplayName(deepSeekMainHealth, 'claude-fable-5[1m]'),
        'DeepSeek Main Route'
      );
      assert.equal(
        modelDisplayName(deepSeekMainHealth, 'claude-fable-5'),
        'DeepSeek Main Route'
      );
      assert.equal(
        modelDisplayName(deepSeekMainHealth, 'claude-fable-5-20260601'),
        'DeepSeek Main Route'
      );
      assert.equal(
        modelDisplayName(collisionHealth, 'claude-sonnet-4-7'),
        'Claude Workflow Frontier Route'
      );
      assert.notEqual(invalidRoute.result.code, 0);
      assert.match(
        invalidRoute.result.stderr,
        /entry for claude-sonnet-4-7 must set provider/u
      );
      ok('claude-workflow defaults routed response model display on and supports explicit opt-out');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow launches concurrent folders on distinct dynamic ports',
  async function testWorkflowCliConcurrentDynamicPorts() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-dynamic-ports-'));
    const projectA = path.join(tempDir, 'project-a');
    const projectB = path.join(tempDir, 'project-b');
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const cliPath = path.resolve('js/cli/claude-workflow.js');
    const envAPath = path.join(tempDir, 'claude-env-a.json');
    const envBPath = path.join(tempDir, 'claude-env-b.json');

    try {
      await fs.mkdir(projectA, { recursive: true });
      await fs.mkdir(projectB, { recursive: true });
      await makeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          'const target = process.env.ULTRATHINK_TEST_CLAUDE_ENV_PATH;\n' +
          'fs.writeFileSync(target, JSON.stringify({\n' +
          "  cwd: process.cwd(),\n" +
          "  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',\n" +
          "  CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL || '',\n" +
          "}), 'utf8');\n" +
          "process.stdout.write('CLI_OK\\n');\n"
      );
      await makeCodexLoginStatusCommand(codexPath);

      const baseEnv = {
        ...process.env,
        ...CLEAN_WORKFLOW_ENV,
        PATH: `${tempDir}:${process.env.PATH || ''}`,
        ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
        ULTRATHINK_GATEWAY_PORT: '',
        ULTRATHINK_GATEWAY_SHARED_SECRET: '',
        ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      };
      const [resultA, resultB] = await Promise.all([
        runProcess(
          'node',
          [cliPath, 'Reply with exactly CLI_OK.'],
          {
            ...baseEnv,
            ULTRATHINK_TEST_CLAUDE_ENV_PATH: envAPath,
          },
          { cwd: projectA }
        ),
        runProcess(
          'node',
          [cliPath, 'Reply with exactly CLI_OK.'],
          {
            ...baseEnv,
            ULTRATHINK_TEST_CLAUDE_ENV_PATH: envBPath,
          },
          { cwd: projectB }
        ),
      ]);

      assert.equal(resultA.code, 0);
      assert.equal(resultB.code, 0);
      const realProjectA = await fs.realpath(projectA);
      const realProjectB = await fs.realpath(projectB);
      const envA = JSON.parse(await fs.readFile(envAPath, 'utf8'));
      const envB = JSON.parse(await fs.readFile(envBPath, 'utf8'));
      assert.equal(envA.cwd, realProjectA);
      assert.equal(envB.cwd, realProjectB);
      assert.equal(envA.CLAUDE_CODE_SUBAGENT_MODEL, WORKFLOW_DISPLAY_SUBAGENT_MODEL);
      assert.equal(envB.CLAUDE_CODE_SUBAGENT_MODEL, WORKFLOW_DISPLAY_SUBAGENT_MODEL);
      assert.equal(envA.ANTHROPIC_BASE_URL.startsWith('http://127.0.0.1:'), true);
      assert.equal(envB.ANTHROPIC_BASE_URL.startsWith('http://127.0.0.1:'), true);
      assert.notEqual(envA.ANTHROPIC_BASE_URL, envB.ANTHROPIC_BASE_URL);
      ok('parallel workflow launchers in different folders get isolated localhost gateway ports');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow reports fixed gateway port collisions clearly',
  async function testWorkflowCliFixedPortCollision() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-port-collision-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const gatewayPort = await freePort();
    const blocker = http.createServer(function blockPort(req, res) {
      res.statusCode = 404;
      res.end();
    });

    try {
      await makeClaudeShouldNotRunCommand(claudePath);
      await makeCodexLoginStatusCommand(codexPath);
      blocker.listen(gatewayPort, '127.0.0.1');
      await waitForListening(blocker);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_PORT: String(gatewayPort),
          ULTRATHINK_GATEWAY_SHARED_SECRET: '',
          ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );

      assert.equal(result.code, 1);
      assert.equal(result.stderr.includes(`gateway port ${gatewayPort} is already in use`), true);
      assert.equal(result.stderr.includes('Unset ULTRATHINK_GATEWAY_PORT'), true);
      ok('fixed gateway port collisions point users back to dynamic per-instance ports');
    } finally {
      await closeServer(blocker);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow rejects unauthenticated non-loopback gateway binds',
  async function testWorkflowCliRejectsUnauthenticatedExternalBind() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-nonloopback-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');

    try {
      await makeClaudeShouldNotRunCommand(claudePath);
      await makeCodexLoginStatusCommand(codexPath);

      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_HOST: '0.0.0.0',
          ULTRATHINK_GATEWAY_SHARED_SECRET: '',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );

      assert.equal(result.code, 1);
      assert.equal(result.stderr.includes('ULTRATHINK_GATEWAY_HOST=0.0.0.0 is not loopback'), true);
      assert.equal(result.stderr.includes('ULTRATHINK_GATEWAY_SHARED_SECRET'), true);

      const ambiguousHostResult = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', 'Reply with exactly SHOULD_NOT_RUN.'],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_GATEWAY_HOST: '127',
          ULTRATHINK_GATEWAY_SHARED_SECRET: '',
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        }
      );

      assert.equal(ambiguousHostResult.code, 1);
      assert.equal(
        ambiguousHostResult.stderr.includes('ULTRATHINK_GATEWAY_HOST=127 is not loopback'),
        true
      );
      ok('non-loopback workflow gateway binds require explicit gateway authentication');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow defaults to auto mode and keeps yolo flags out of prompts',
  async function testWorkflowCliYoloPermissionFlags() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-yolo-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');

    async function runWithArgs(args, captureName, envOverrides = {}) {
      const capturedArgsPath = path.join(tempDir, captureName);
      const result = await runProcess(
        'node',
        ['js/cli/claude-workflow.js', ...args],
        {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_TEST_CLAUDE_ARGS_PATH: capturedArgsPath,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
          ...envOverrides,
        }
      );

      assert.equal(result.code, 0);
      return JSON.parse(await fs.readFile(capturedArgsPath, 'utf8'));
    }

    function runWithFlag(flag, captureName) {
      return runWithArgs([flag, 'Reply with exactly CLI_OK.'], captureName);
    }

    try {
      await makeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          'const target = process.env.ULTRATHINK_TEST_CLAUDE_ARGS_PATH;\n' +
          "fs.writeFileSync(target, JSON.stringify(process.argv.slice(2)), 'utf8');\n" +
          "process.stdout.write('CLI_OK\\n');\n"
      );
      await makeCodexLoginStatusCommand(codexPath);

      const interactiveArgs = await runWithArgs([], 'claude-interactive-args.json');
      const defaultPromptArgs = await runWithArgs(
        ['Reply with exactly CLI_OK.'],
        'claude-default-prompt-args.json'
      );
      const yoloArgs = await runWithFlag('--yolo', 'claude-yolo-args.json');
      const dangerousArgs = await runWithFlag(
        '--dangerously-skip-permissions',
        'claude-dangerous-args.json'
      );
      const optedOutArgs = await runWithArgs(
        ['--no-yolo', 'Reply with exactly CLI_OK.'],
        'claude-opted-out-args.json'
      );
      const envOptedOutArgs = await runWithArgs(
        ['Reply with exactly CLI_OK.'],
        'claude-env-opted-out-args.json',
        {
          CLAUDE_WORKFLOW_SKIP_PERMISSIONS: 'false',
        }
      );
      const passthroughHelpArgs = await runWithArgs(
        ['--', 'Explain', '--help'],
        'claude-passthrough-help-args.json'
      );
      const resumeSessionId = 'd3512e5e-c859-4109-aad1-f517c268d1e5';
      const resumeArgs = await runWithArgs(
        ['--resume', resumeSessionId],
        'claude-resume-args.json'
      );
      const resumeWithPromptArgs = await runWithArgs(
        ['-r', resumeSessionId, 'Continue with exactly CLI_OK.'],
        'claude-resume-prompt-args.json'
      );
      const continueForkArgs = await runWithArgs(
        ['--continue', '--fork-session'],
        'claude-continue-fork-args.json'
      );
      const fromPrArgs = await runWithArgs(['--from-pr=42'], 'claude-from-pr-args.json');
      const explicitSessionArgs = await runWithArgs(
        ['--session-id', resumeSessionId],
        'claude-session-id-args.json'
      );

      assert.equal(interactiveArgs.includes('--dangerously-skip-permissions'), true);
      assert.equal(interactiveArgs.includes('-p'), false);
      assert.equal(interactiveArgs.includes('--model'), true);
      for (const args of [defaultPromptArgs, yoloArgs, dangerousArgs, passthroughHelpArgs]) {
        assert.equal(args.includes('--dangerously-skip-permissions'), true);
        assert.equal(args.includes('--yolo'), false);
      }
      assert.equal(defaultPromptArgs.at(-1), 'Reply with exactly CLI_OK.');
      assert.equal(yoloArgs.at(-1), 'Reply with exactly CLI_OK.');
      assert.equal(dangerousArgs.at(-1), 'Reply with exactly CLI_OK.');
      assert.equal(passthroughHelpArgs.at(-1), 'Explain --help');
      assert.equal(optedOutArgs.includes('--dangerously-skip-permissions'), false);
      assert.equal(optedOutArgs.includes('--no-yolo'), false);
      assert.equal(optedOutArgs.at(-1), 'Reply with exactly CLI_OK.');
      assert.equal(envOptedOutArgs.includes('--dangerously-skip-permissions'), false);
      assert.equal(envOptedOutArgs.at(-1), 'Reply with exactly CLI_OK.');
      for (const args of [
        resumeArgs,
        resumeWithPromptArgs,
        continueForkArgs,
        fromPrArgs,
        explicitSessionArgs,
      ]) {
        assert.equal(args.includes('-p'), false);
        assert.equal(args.includes('--model'), true);
        assert.equal(args.includes('--dangerously-skip-permissions'), true);
      }
      assert.equal(resumeArgs.includes('--resume'), true);
      assert.equal(resumeArgs.includes(resumeSessionId), true);
      assert.equal(resumeWithPromptArgs.includes('-r'), true);
      assert.equal(resumeWithPromptArgs.at(-1), 'Continue with exactly CLI_OK.');
      assert.equal(continueForkArgs.includes('--continue'), true);
      assert.equal(continueForkArgs.includes('--fork-session'), true);
      assert.equal(fromPrArgs.includes('--from-pr=42'), true);
      assert.equal(explicitSessionArgs.includes('--session-id'), true);
      assert.equal(explicitSessionArgs.includes(resumeSessionId), true);

      ok(
        'claude-workflow defaults to auto mode while preserving explicit yolo aliases, opt-out, and Claude session flags'
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest(
  'claude-workflow forwards SIGTERM to Claude and exits conventionally',
  async function testWorkflowCliSignalHandling() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-cli-signal-'));
    const claudePath = path.join(tempDir, 'claude');
    const codexPath = path.join(tempDir, 'codex-wrapper');
    const startedPath = path.join(tempDir, 'claude-started');
    const stoppedPath = path.join(tempDir, 'claude-stopped');

    try {
      await makeExecutable(
        claudePath,
        '#!/usr/bin/env node\n' +
          "import fs from 'node:fs';\n" +
          'fs.writeFileSync(process.env.ULTRATHINK_TEST_CLAUDE_STARTED_PATH, "started", "utf8");\n' +
          "process.on('SIGTERM', function onSigterm() {\n" +
          '  fs.writeFileSync(process.env.ULTRATHINK_TEST_CLAUDE_STOPPED_PATH, "stopped", "utf8");\n' +
          '  process.exit(0);\n' +
          '});\n' +
          'setInterval(function keepAlive() {}, 1000);\n'
      );
      await makeCodexLoginStatusCommand(codexPath);

      const child = spawn('node', ['js/cli/claude-workflow.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...CLEAN_WORKFLOW_ENV,
          PATH: `${tempDir}:${process.env.PATH || ''}`,
          ULTRATHINK_GATEWAY_CODEX_COMMAND: codexPath,
          ULTRATHINK_TEST_CLAUDE_STARTED_PATH: startedPath,
          ULTRATHINK_TEST_CLAUDE_STOPPED_PATH: stoppedPath,
          ANTHROPIC_AUTH_TOKEN: '',
          ANTHROPIC_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', function onStderr(chunk) {
        stderr += chunk.toString();
      });
      child.stdout.resume();

      try {
        await waitForFile(startedPath);
        child.kill('SIGTERM');
        const result = await new Promise(function waitForExit(resolve, reject) {
          const timeout = setTimeout(function failSignalTest() {
            reject(new Error(`claude-workflow did not exit after SIGTERM: ${stderr}`));
          }, 5_000);
          child.on('close', function onClose(code, signal) {
            clearTimeout(timeout);
            resolve({ code, signal });
          });
          child.on('error', reject);
        });

        assert.equal(result.code, 143);
        assert.equal(result.signal, null);
        await waitForFile(stoppedPath);
        ok('SIGTERM shuts down the gateway wrapper and the child Claude process cleanly');
      } finally {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

await runTest('gateway routes non-frontier requests to the Codex GPT-5.5 low profile', async function testOpenAiRouting() {
  const openAiPort = await freePort();
  let capturedBody = null;
  let capturedUrl = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    capturedUrl = req.url;
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: `Unexpected URL: ${req.url}` } }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-openai-text',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Remapped through the Codex GPT-5.5 low profile.',
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 6,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}/v1`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        system: 'You are terse.',
        max_tokens: 256,
        stop_sequences: ['STOP_HERE'],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Explain the route.' }],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(capturedUrl, '/v1/chat/completions');
    assert.equal(capturedBody.model, 'gpt-5.5');
    assert.equal(capturedBody.reasoning_effort, 'low');
    assert.equal(capturedBody.verbosity, 'low');
    assert.equal(capturedBody.max_completion_tokens, 256);
    assert.deepEqual(capturedBody.stop, ['STOP_HERE']);
    assert.deepEqual(
      capturedBody.messages.map(function roles(message) {
        return message.role;
      }),
      ['developer', 'user']
    );
    assert.equal(payload.model, 'claude-sonnet-4-7');
    assert.equal(payload.stop_reason, 'end_turn');
    assert.deepEqual(payload.content, [
      {
        type: 'text',
        text: 'Remapped through the Codex GPT-5.5 low profile.',
      },
    ]);
    ok('non-frontier requests remap to the Codex-targeted GPT-5.5 low profile');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest(
  'gateway can expose routed OpenAI-compatible response model metadata',
  async function testOpenAiDisplayRoutedModelJson() {
    const openAiPort = await freePort();
    let capturedBody = null;

    const openAiServer = http.createServer(async function handleOpenAi(req, res) {
      capturedBody = await readJsonBody(req);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'chatcmpl-openai-display-model',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'OPENAI_DISPLAY_MODEL_OK',
              },
            },
          ],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      openAiServer.once('error', reject);
      openAiServer.listen(openAiPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(gatewayConfig({
      displayRoutedModel: true,
      port: gatewayPort,
      exposedModels: ['claude-sonnet-4-7'],
      codex: {
        enabled: false,
      },
      openai: {
        apiKey: 'openai-key',
        baseUrl: `http://127.0.0.1:${openAiPort}/v1`,
      },
    }));

    await waitForListening(runtime.server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-sonnet-4-7',
          messages: [{ role: 'user', content: 'Say OPENAI_DISPLAY_MODEL_OK.' }],
        }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();

      assert.equal(capturedBody.model, 'gpt-5.5');
      assert.equal(
        payload.model,
        routedResponseModel({
          provider: 'openai',
          upstreamModel: 'gpt-5.5',
          reasoningEffort: 'low',
          requestedModel: 'claude-sonnet-4-7',
        })
      );
      assert.equal(payload.content[0].text, 'OPENAI_DISPLAY_MODEL_OK');
      ok('OpenAI-compatible JSON responses can report routed metadata without changing the upstream request');
    } finally {
      await runtime.close();
      await closeServer(openAiServer);
    }
  }
);

await runTest('gateway translates empty-text assistant tool calls as tool-call-only messages', function testEmptyAssistantToolCallContent() {
  const translated = translateAnthropicMessagesRequestWithOptions(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            {
              type: 'tool_use',
              id: 'call_empty_text',
              name: 'lookup_weather',
              input: { city: 'San Francisco' },
            },
          ],
        },
      ],
    },
    {
      provider: 'deepseek',
      upstreamModel: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    }
  );

  const assistantMessage = translated.messages[0];
  assert.equal(assistantMessage.content, null);
  assert.equal(assistantMessage.tool_calls[0].id, 'call_empty_text');
  assert.equal(assistantMessage.tool_calls[0].function.name, 'lookup_weather');
  assert.equal(assistantMessage.tool_calls[0].function.arguments, '{"city":"San Francisco"}');
  ok('empty assistant text blocks do not turn tool-call-only replays into empty-string content');
});

await runTest('gateway translates Anthropic image blocks and disables parallel tool calls for OpenAI', async function testOpenAiImageAndToolParallelTranslation() {
  const openAiPort = await freePort();
  let capturedBody = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-openai-image',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'image ok',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}/v1`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image.' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aW1hZ2U=',
                },
              },
            ],
          },
        ],
        tools: [
          {
            name: 'lookup',
            input_schema: {
              type: 'object',
              properties: {},
            },
          },
        ],
        tool_choice: {
          type: 'auto',
          disable_parallel_tool_use: true,
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(capturedBody.messages[0].content, [
      { type: 'text', text: 'Describe this image.' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,aW1hZ2U=',
        },
      },
    ]);
    assert.equal(capturedBody.tool_choice, 'auto');
    assert.equal(capturedBody.parallel_tool_calls, false);
    ok('Anthropic image blocks and no-parallel tool-choice flags survive OpenAI translation');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway accepts Claude-style system role messages inside the message list', async function testSystemRoleRouting() {
  const openAiPort = await freePort();
  let capturedBody = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-openai-system-role',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'SYSTEM_ROLE_OK',
            },
          },
        ],
        usage: {
          prompt_tokens: 18,
          completion_tokens: 4,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [
          {
            role: 'system',
            content: 'Treat this as client-supplied system context.',
          },
          {
            role: 'user',
            content: 'Reply with SYSTEM_ROLE_OK.',
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.deepEqual(
      capturedBody.messages.map(function summarize(message) {
        return { role: message.role, content: message.content };
      }),
      [
        {
          role: 'developer',
          content: 'Treat this as client-supplied system context.',
        },
        {
          role: 'user',
          content: 'Reply with SYSTEM_ROLE_OK.',
        },
      ]
    );
    assert.equal(payload.content[0].text, 'SYSTEM_ROLE_OK');
    ok('system-role messages from Claude clients are translated into developer messages');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway translates Anthropic tool histories and OpenAI tool calls', async function testToolTranslation() {
  const openAiPort = await freePort();
  let capturedBody = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-openai-tool',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'lookup_weather',
                    arguments: JSON.stringify({ city: 'SF' }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 33,
          completion_tokens: 11,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Check weather.' }],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'lookup_weather',
                input: { city: 'SF' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: '72F and sunny',
              },
            ],
          },
        ],
        tools: [
          {
            name: 'lookup_weather',
            description: 'Lookup weather.',
            input_schema: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.deepEqual(
      capturedBody.messages.map(function summarize(message) {
        return message.role;
      }),
      ['user', 'assistant', 'tool']
    );
    assert.deepEqual(capturedBody.messages[1].tool_calls, [
      {
        id: 'toolu_1',
        type: 'function',
        function: {
          name: 'lookup_weather',
          arguments: JSON.stringify({ city: 'SF' }),
        },
      },
    ]);
    assert.equal(capturedBody.messages[2].tool_call_id, 'toolu_1');
    assert.equal(payload.stop_reason, 'tool_use');
    assert.deepEqual(payload.content, [
      {
        type: 'tool_use',
        id: 'call_weather',
        name: 'lookup_weather',
        input: { city: 'SF' },
      },
    ]);
    ok('tool histories and tool call outputs translate cleanly');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest(
  'gateway keeps tool results adjacent to the originating assistant tool call when a mixed user turn also includes text',
  async function testMixedToolResultOrdering() {
    const openAiPort = await freePort();
    let capturedBody = null;

    const openAiServer = http.createServer(async function handleOpenAi(req, res) {
      capturedBody = await readJsonBody(req);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'chatcmpl_mixed_tool_result',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Processed mixed tool result.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      openAiServer.once('error', reject);
      openAiServer.listen(openAiPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(gatewayConfig({
      port: gatewayPort,
      exposedModels: ['claude-sonnet-4-7'],
      codex: {
        enabled: false,
      },
      openai: {
        apiKey: 'openai-key',
        baseUrl: `http://127.0.0.1:${openAiPort}`,
      },
    }));

    await waitForListening(runtime.server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-sonnet-4-7',
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Look up the weather.' }],
            },
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_mixed',
                  name: 'lookup_weather',
                  input: { city: 'SF' },
                },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'The tool completed; summarize it after consuming the result.' },
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_mixed',
                  content: '72F and sunny',
                },
              ],
            },
          ],
          tools: [
            {
              name: 'lookup_weather',
              description: 'Lookup weather.',
              input_schema: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                },
                required: ['city'],
              },
            },
          ],
        }),
      });

      assert.equal(response.status, 200);
      await response.json();
      assert.deepEqual(
        capturedBody.messages.map(function summarize(message) {
          return message.role;
        }),
        ['user', 'assistant', 'tool', 'user']
      );
      assert.equal(capturedBody.messages[2].tool_call_id, 'toolu_mixed');
      assert.equal(
        capturedBody.messages[3].content,
        'The tool completed; summarize it after consuming the result.'
      );
      ok('mixed text + tool_result user turns preserve tool-result adjacency for OpenAI-compatible upstreams');
    } finally {
      await runtime.close();
      await closeServer(openAiServer);
    }
  }
);

await runTest('gateway applies explicit route-map entries before default routing', async function testExplicitRouteMap() {
  const openAiPort = await freePort();
  const captured = [];

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    const body = await readJsonBody(req);
    captured.push(body);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-route-map',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Routed through custom profile.',
            },
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-codex-review'],
    routeMap: {
      'claude-codex-review': {
        provider: 'openai',
        model: 'gpt-5.5',
        reasoningEffort: 'medium',
        verbosity: 'high',
        displayName: 'Codex Review Route',
      },
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-codex-review',
        messages: [{ role: 'user', content: 'Use the configured route.' }],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.model, 'claude-codex-review');
    assert.equal(captured[0].model, 'gpt-5.5');
    assert.equal(captured[0].reasoning_effort, 'medium');
    assert.equal(captured[0].verbosity, 'high');

    const modelsResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    const modelsPayload = await modelsResponse.json();
    assert.equal(modelsPayload.data[0].display_name, 'Codex Review Route');
    ok('explicit route-map entries override the default non-frontier mapping');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway routes configured models to DeepSeek-compatible chat completions', async function testDeepSeekGatewayRouting() {
  const deepSeekPort = await freePort();
  let capturedBody = null;
  let capturedUrl = null;
  let capturedAuthorization = '';

  const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
    capturedUrl = req.url;
    capturedAuthorization = req.headers.authorization || '';
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-deepseek-route',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'DeepSeek route ok.',
            },
          },
        ],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 5,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    deepSeekServer.once('error', reject);
    deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort, {
    config: {
      displayRoutedModel: true,
      openai: {
        apiKey: 'openai-key-should-not-be-used',
        baseUrl: 'http://127.0.0.1:1',
      },
    },
    route: {
      reasoningEffort: 'high',
      displayName: 'Fable via DeepSeek',
    },
    deepseek: {
      reasoningEffort: 'max',
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-fable-5[1m]',
        system: 'You are terse.',
        max_tokens: 128,
        messages: [
          {
            role: 'user',
            content: 'Use DeepSeek.',
          },
        ],
        tools: [lookupWeatherTool()],
        tool_choice: {
          type: 'tool',
          name: 'lookup_weather',
          disable_parallel_tool_use: true,
        },
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(capturedUrl, '/chat/completions');
    assert.equal(capturedAuthorization, 'Bearer deepseek-key');
    assert.equal(capturedBody.model, 'deepseek-v4-pro');
    assert.equal(capturedBody.reasoning_effort, 'high');
    assert.equal(capturedBody.max_tokens, 128);
    assert.equal(capturedBody.max_completion_tokens, undefined);
    assert.deepEqual(capturedBody.thinking, { type: 'enabled' });
    assert.equal(capturedBody.tools[0].function.name, 'lookup_weather');
    assert.equal(capturedBody.tool_choice, undefined);
    assert.equal(capturedBody.parallel_tool_calls, undefined);
    assert.deepEqual(
      capturedBody.messages.map(function roles(message) {
        return message.role;
      }),
      ['system', 'user']
    );
    assert.equal(
      payload.model,
      routedResponseModel({
        provider: 'deepseek',
        upstreamModel: 'deepseek-v4-pro',
        reasoningEffort: 'high',
        requestedModel: 'claude-fable-5[1m]',
      })
    );
    assert.equal(payload.usage.input_tokens, 21);
    assert.equal(payload.usage.output_tokens, 5);
    assert.equal(payload.content[0].text, 'DeepSeek route ok.');
    ok('DeepSeek routes use their own credentials, endpoint, request shape, and response metadata');
  } finally {
    await runtime.close();
    await closeServer(deepSeekServer);
  }
});

await runTest('gateway omits DeepSeek reasoning effort when thinking is disabled', async function testDeepSeekDisabledThinkingRouting() {
  const deepSeekPort = await freePort();
  let capturedBody = null;

  const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, jsonHeaders());
    res.end(
      JSON.stringify({
        id: 'chatcmpl-deepseek-disabled-thinking',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'DeepSeek no thinking ok.',
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
        },
      })
    );
  });

  await new Promise(function listen(resolve, reject) {
    deepSeekServer.once('error', reject);
    deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort, {
    deepseek: {
      thinking: { type: 'disabled' },
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-fable-5[1m]',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Use DeepSeek without thinking.' }],
        tools: [lookupWeatherTool()],
        tool_choice: {
          type: 'auto',
        },
      }),
    });
    assert.equal(response.status, 200);

    assert.equal(capturedBody.reasoning_effort, undefined);
    assert.deepEqual(capturedBody.thinking, { type: 'disabled' });
    assert.equal(capturedBody.tool_choice, 'auto');
    ok('DeepSeek disabled-thinking requests omit reasoning_effort while keeping normal tool_choice translation');
  } finally {
    await runtime.close();
    await closeServer(deepSeekServer);
  }
});

await runTest(
  'gateway translates replayed assistant thinking blocks for DeepSeek routes',
  async function testDeepSeekAssistantThinkingReplay() {
    const deepSeekPort = await freePort();
    let capturedBody = null;

    const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
      capturedBody = await readJsonBody(req);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'chatcmpl-deepseek-thinking-replay',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Continued.',
              },
            },
          ],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 3,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      deepSeekServer.once('error', reject);
      deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort));

    await waitForListening(runtime.server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          max_tokens: 256,
          messages: [
            { role: 'user', content: 'Earlier question.' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'Invisible planning.',
                  signature: 'opaque-thinking-only-signature',
                },
              ],
            },
            { role: 'user', content: 'Keep going.' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'Need a concise answer.',
                  signature: 'opaque-signature',
                },
                {
                  type: 'redacted_thinking',
                  data: 'opaque-redacted-thinking',
                },
                {
                  type: 'text',
                  text: 'Earlier answer.',
                },
              ],
            },
            { role: 'user', content: 'Continue.' },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json();

      const assistantMessages = capturedBody.messages.filter(function findAssistant(message) {
        return message.role === 'assistant';
      });
      assert.equal(assistantMessages[0].content, '');
      assert.equal(assistantMessages[0].reasoning_content, 'Invisible planning.');
      assert.equal(assistantMessages[1].content, 'Earlier answer.');
      assert.equal(assistantMessages[1].reasoning_content, 'Need a concise answer.');
      assert.equal(payload.content[0].text, 'Continued.');
      ok('Claude replayed assistant thinking blocks no longer break DeepSeek-routed turns');
    } finally {
      await runtime.close();
      await closeServer(deepSeekServer);
    }
  }
);

await runTest(
  'gateway preserves DeepSeek reasoning content across JSON tool-result turns',
  async function testDeepSeekReasoningToolLoopJson() {
    const deepSeekPort = await freePort();
    const capturedBodies = [];

    const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
      capturedBodies.push(await readJsonBody(req));
      res.writeHead(200, jsonHeaders());

      if (capturedBodies.length === 1) {
        res.end(
          JSON.stringify({
            id: 'chatcmpl-deepseek-tool',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  reasoning_content: 'Need weather.',
                  tool_calls: [
                    {
                      id: 'call_weather',
                      type: 'function',
                      function: {
                        name: 'lookup_weather',
                        arguments: JSON.stringify({ city: 'SF' }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 6,
            },
          })
        );
        return;
      }

      res.end(
        JSON.stringify({
          id: 'chatcmpl-deepseek-final',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Weather checked.',
              },
            },
          ],
          usage: {
            prompt_tokens: 35,
            completion_tokens: 4,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      deepSeekServer.once('error', reject);
      deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort));

    await waitForListening(runtime.server);

    const headers = deepSeekReasoningHeaders('session-deepseek-json-reasoning');

    try {
      const firstResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Check weather.' }],
          tools: [lookupWeatherTool()],
        }),
      });
      assert.equal(firstResponse.status, 200);
      const firstPayload = await firstResponse.json();
      const toolUse = firstPayload.content.find(function findToolUse(block) {
        return block.type === 'tool_use';
      });
      assert.equal(toolUse.id, 'call_weather');

      const secondResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          max_tokens: 256,
          messages: [
            { role: 'user', content: 'Check weather.' },
            {
              role: 'assistant',
              content: [toolUse],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_weather',
                  content: '72F',
                },
              ],
            },
          ],
        }),
      });
      assert.equal(secondResponse.status, 200);

      assertDeepSeekReasoningReplay(capturedBodies);
      ok('DeepSeek JSON tool loops replay reasoning_content on the assistant tool-call message');
    } finally {
      await runtime.close();
      await closeServer(deepSeekServer);
    }
  }
);

await runTest('gateway streams OpenAI chunks as Anthropic SSE events', async function testStreaming() {
  const openAiPort = await freePort();

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    await readJsonBody(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stream',
        choices: [{ delta: { content: 'Hel' }, finish_reason: null }],
      })}\r\n\r\n`
    );
    await sleep(10);
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stream',
        choices: [{ delta: { content: 'lo' }, finish_reason: null }],
      })}\r\n\r\n`
    );
    await sleep(10);
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stream',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })}\r\n\r\n`
    );
    res.write('data: [DONE]\r\n\r\n');
    res.end();
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    displayRoutedModel: true,
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        stream: true,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const events = parseSsePayloads(text);
    const messageStart = events.find(function findMessageStart(event) {
      return event.name === 'message_start';
    });
    const terminalDelta = events.find(function findTerminalDelta(event) {
      return (
        event.name === 'message_delta' &&
        event.payload?.delta?.stop_reason === 'end_turn'
      );
    });

    assert.match(text, /event: message_start/u);
    assert.equal(
      messageStart.payload.message.model,
      routedResponseModel({
        provider: 'openai',
        upstreamModel: 'gpt-5.5',
        reasoningEffort: 'low',
        requestedModel: 'claude-sonnet-4-7',
      })
    );
    assert.match(text, /"type":"text_delta","text":"Hel"/u);
    assert.match(text, /"type":"text_delta","text":"lo"/u);
    assert.match(text, /"stop_reason":"end_turn"/u);
    assert.equal(terminalDelta.payload.usage.input_tokens, 0);
    assert.equal(terminalDelta.payload.usage.output_tokens, 5);
    assert.match(text, /event: message_stop/u);
    ok('streaming path emits Anthropic-style SSE events with output-only usage');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway maps OpenAI streaming body timeouts to gateway timeout errors', async function testStreamingTimeoutAbortReason() {
  const openAiPort = await freePort();
  let upstreamResponse = null;

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    upstreamResponse = res;
    await readJsonBody(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stream-timeout',
        choices: [{ delta: { content: 'partial' }, finish_reason: null }],
      })}\r\n\r\n`
    );
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    requestTimeoutMs: 75,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        stream: true,
        messages: [{ role: 'user', content: 'Start then timeout.' }],
      }),
    });
    assert.equal(response.status, 200);

    const events = parseSsePayloads(await response.text());
    const errorEvent = events.find(function findErrorEvent(event) {
      return event.name === 'error';
    });

    assert.equal(Boolean(errorEvent), true);
    assert.equal(errorEvent.payload.error.type, 'api_error');
    assert.match(errorEvent.payload.error.message, /gateway request timed out/u);
    ok('streaming upstream aborts preserve the gateway timeout reason');
  } finally {
    upstreamResponse?.destroy();
    openAiServer.closeAllConnections?.();
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest('gateway streams tool calls with Anthropic input_json_delta events', async function testStreamingToolUse() {
  const openAiPort = await freePort();

  const openAiServer = http.createServer(async function handleOpenAi(req, res) {
    await readJsonBody(req);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-tool-stream',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'lookup_weather',
                    arguments: JSON.stringify({ city: 'SF' }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\r\n\r\n`
    );
    await sleep(10);
    res.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-tool-stream',
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 15, completion_tokens: 6 },
      })}\r\n\r\n`
    );
    res.write('data: [DONE]\r\n\r\n');
    res.end();
  });

  await new Promise(function listen(resolve, reject) {
    openAiServer.once('error', reject);
    openAiServer.listen(openAiPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-sonnet-4-7'],
    codex: {
      enabled: false,
    },
    openai: {
      apiKey: 'openai-key',
      baseUrl: `http://127.0.0.1:${openAiPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-7',
        stream: true,
        messages: [{ role: 'user', content: 'Use the weather tool.' }],
        tools: [
          {
            name: 'lookup_weather',
            description: 'Fetch weather.',
            input_schema: {
              type: 'object',
              properties: {
                city: { type: 'string' },
              },
              required: ['city'],
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);

    const events = parseSsePayloads(await response.text());
    const toolStart = events.find(function findToolStart(event) {
      return (
        event.name === 'content_block_start' &&
        event.payload?.content_block?.type === 'tool_use'
      );
    });
    const toolDelta = events.find(function findToolDelta(event) {
      return event.payload?.delta?.type === 'input_json_delta';
    });
    const messageDelta = events.find(function findMessageDelta(event) {
      return event.name === 'message_delta';
    });

    assert.deepEqual(toolStart.payload.content_block, {
      type: 'tool_use',
      id: 'call_weather',
      name: 'lookup_weather',
      input: {},
    });
    assert.equal(toolDelta.payload.delta.partial_json, JSON.stringify({ city: 'SF' }));
    assert.equal(messageDelta.payload.delta.stop_reason, 'tool_use');
    ok('tool-use streaming path emits Anthropic input_json_delta events');
  } finally {
    await runtime.close();
    await closeServer(openAiServer);
  }
});

await runTest(
  'gateway preserves DeepSeek reasoning content across streamed tool-result turns',
  async function testDeepSeekReasoningToolLoopStream() {
    const deepSeekPort = await freePort();
    const capturedBodies = [];

    const deepSeekServer = http.createServer(async function handleDeepSeek(req, res) {
      capturedBodies.push(await readJsonBody(req));

      if (capturedBodies.length === 1) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
        });
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-deepseek-tool-stream',
            choices: [
              {
                delta: {
                  reasoning_content: 'Need weather.',
                },
                finish_reason: null,
              },
            ],
          })}\r\n\r\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-deepseek-tool-stream',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_weather',
                      type: 'function',
                      function: {
                        name: 'lookup_weather',
                        arguments: JSON.stringify({ city: 'SF' }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\r\n\r\n`
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-deepseek-tool-stream',
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 15, completion_tokens: 6 },
          })}\r\n\r\n`
        );
        res.write('data: [DONE]\r\n\r\n');
        res.end();
        return;
      }

      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'chatcmpl-deepseek-stream-final',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Weather checked.',
              },
            },
          ],
          usage: {
            prompt_tokens: 35,
            completion_tokens: 4,
          },
        })
      );
    });

    await new Promise(function listen(resolve, reject) {
      deepSeekServer.once('error', reject);
      deepSeekServer.listen(deepSeekPort, '127.0.0.1', resolve);
    });

    const gatewayPort = await freePort();
    const runtime = createGatewayServer(deepSeekFableGatewayConfig(gatewayPort, deepSeekPort));

    await waitForListening(runtime.server);

    const headers = deepSeekReasoningHeaders('session-deepseek-stream-reasoning');

    try {
      const firstResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          stream: true,
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Check weather.' }],
          tools: [lookupWeatherTool()],
        }),
      });
      assert.equal(firstResponse.status, 200);

      const events = parseSsePayloads(await firstResponse.text());
      const toolStart = events.find(function findToolStart(event) {
        return (
          event.name === 'content_block_start' &&
          event.payload?.content_block?.type === 'tool_use'
        );
      });
      assert.equal(toolStart.payload.content_block.id, 'call_weather');

      const secondResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-fable-5[1m]',
          max_tokens: 256,
          messages: [
            { role: 'user', content: 'Check weather.' },
            {
              role: 'assistant',
              content: [
                {
                  ...toolStart.payload.content_block,
                  input: { city: 'SF' },
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call_weather',
                  content: '72F',
                },
              ],
            },
          ],
        }),
      });
      assert.equal(secondResponse.status, 200);

      assertDeepSeekReasoningReplay(capturedBodies);
      ok('DeepSeek streaming tool loops replay reasoning_content on the assistant tool-call message');
    } finally {
      await runtime.close();
      await closeServer(deepSeekServer);
    }
  }
);

await runTest(
  'gateway streams live Codex usage updates before the terminal boundary',
  async function testCodexUsageStreaming() {
    const gatewayPort = await freePort();
    let seenRoute = null;
    let seenRequestBody = null;

    const fakeCodexSessions = {
      async processRequest() {
        throw new Error('processRequest should not be called for this streaming test');
      },
      async streamRequest(req, requestBody, route, onEvent) {
        seenRequestBody = requestBody;
        seenRoute = route;
        onEvent({
          type: 'usage',
          usage: {
            input_tokens: 42,
            output_tokens: 1,
            cache_read_input_tokens: 5,
          },
        });
        await sleep(5);
        onEvent({
          type: 'text_delta',
          text: 'STREAM_USAGE_OK',
        });
        await sleep(5);
        onEvent({
          type: 'usage',
          usage: {
            input_tokens: 42,
            output_tokens: 7,
            cache_read_input_tokens: 5,
          },
        });
        await sleep(5);
        onEvent({
          type: 'boundary',
          outcome: {
            type: 'final',
            usage: {
              input_tokens: 42,
              output_tokens: 7,
              cache_read_input_tokens: 5,
              reasoning_output_tokens: 3,
              total_tokens: 50,
            },
          },
        });

        return {
          type: 'final',
          usage: {
            input_tokens: 42,
            output_tokens: 7,
            cache_read_input_tokens: 5,
            reasoning_output_tokens: 3,
            total_tokens: 50,
          },
        };
      },
      async close() {
        return undefined;
      },
    };

    const app = createGatewayApp(
      gatewayConfig({
        displayRoutedModel: true,
        port: gatewayPort,
        exposedModels: ['claude-sonnet-4-7'],
        routeMap: {
          'claude-sonnet-4-7': {
            provider: 'codex',
            model: 'gpt-5.5',
            reasoningEffort: 'low',
            verbosity: 'low',
          },
        },
        codex: {
          reasoningEffort: 'low',
          verbosity: 'low',
        },
      }),
      fakeCodexSessions
    );
    const server = app.listen(gatewayPort, '127.0.0.1');
    await waitForListening(server);

    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: 'claude-sonnet-4-7',
          stream: true,
          messages: [{ role: 'user', content: 'Say STREAM_USAGE_OK.' }],
        }),
      });
      assert.equal(response.status, 200);

      const events = parseSsePayloads(await response.text());
      const messageStart = events.find(function findMessageStart(event) {
        return event.name === 'message_start';
      });
      const nonTerminalDeltas = events.filter(function findUsageDelta(event) {
        return (
          event.name === 'message_delta' &&
          event.payload?.delta?.stop_reason === null
        );
      });
      const terminalDelta = events.find(function findTerminalDelta(event) {
        return (
          event.name === 'message_delta' &&
          event.payload?.delta?.stop_reason === 'end_turn'
        );
      });
      const textDelta = events.find(function findTextDelta(event) {
        return event.payload?.delta?.type === 'text_delta';
      });

      assert.equal(seenRequestBody.model, 'claude-sonnet-4-7');
      assert.equal(seenRoute.provider, 'codex');
      assert.equal(messageStart.payload.message.model, routedResponseModel(seenRoute));
      assert.equal(messageStart.payload.message.usage.input_tokens, 42);
      assert.equal(messageStart.payload.message.usage.output_tokens, 1);
      assert.equal(messageStart.payload.message.usage.cache_read_input_tokens, 5);
      assert.equal(nonTerminalDeltas.length >= 1, true);
      assert.equal(nonTerminalDeltas.at(-1).payload.usage.input_tokens, 42);
      assert.equal(nonTerminalDeltas.at(-1).payload.usage.output_tokens, 7);
      assert.equal(nonTerminalDeltas.at(-1).payload.usage.cache_read_input_tokens, 5);
      assert.equal(textDelta.payload.delta.text, 'STREAM_USAGE_OK');
      assert.equal(terminalDelta.payload.usage.input_tokens, 42);
      assert.equal(terminalDelta.payload.usage.output_tokens, 7);
      assert.equal(terminalDelta.payload.usage.cache_read_input_tokens, 5);
      assert.equal('reasoning_output_tokens' in terminalDelta.payload.usage, false);
      assert.equal('total_tokens' in terminalDelta.payload.usage, false);
      ok('Codex streaming path emits live Anthropic-compatible usage before the terminal boundary');
    } finally {
      await closeServer(server);
    }
  }
);

await runTest('gateway proxies Opus 4.8 requests and token counts to Anthropic', async function testAnthropicPassthrough() {
  const anthropicPort = await freePort();
  const seen = {
    messages: [],
    countTokens: [],
  };

  const anthropicServer = http.createServer(async function handleAnthropic(req, res) {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      const body = await readJsonBody(req);
      seen.messages.push(body);
      res.writeHead(200, jsonHeaders());
      res.end(
        JSON.stringify({
          id: 'msg_passthrough',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'Direct from Anthropic.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/messages/count_tokens') {
      seen.countTokens.push(await readJsonBody(req));
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ input_tokens: 77 }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(function listen(resolve, reject) {
    anthropicServer.once('error', reject);
    anthropicServer.listen(anthropicPort, '127.0.0.1', resolve);
  });

  const gatewayPort = await freePort();
  const runtime = createGatewayServer(gatewayConfig({
    port: gatewayPort,
    exposedModels: ['claude-opus-4-8', 'claude-opus-4-8[1m]'],
    openai: {
      apiKey: 'openai-key',
    },
    anthropic: {
      apiKey: 'anthropic-key',
      baseUrl: `http://127.0.0.1:${anthropicPort}`,
    },
  }));

  await waitForListening(runtime.server);

  try {
    for (const modelId of ['claude-opus-4-8', 'claude-opus-4-8[1m]']) {
      const messageResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Stay on Anthropic.' }],
        }),
      });
      assert.equal(messageResponse.status, 200);
      const messagePayload = await messageResponse.json();
      assert.equal(messagePayload.model, 'claude-opus-4-8');

      const tokenResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/v1/messages/count_tokens`,
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'Count me.' }],
          }),
        }
      );
      assert.equal(tokenResponse.status, 200);
      const tokenPayload = await tokenResponse.json();
      assert.deepEqual(tokenPayload, { input_tokens: 77 });
    }

    assert.deepEqual(
      seen.messages.map(function messageModel(body) {
        return body.model;
      }),
      ['claude-opus-4-8', 'claude-opus-4-8']
    );
    assert.deepEqual(
      seen.countTokens.map(function tokenCountModel(body) {
        return body.model;
      }),
      ['claude-opus-4-8', 'claude-opus-4-8']
    );
    ok('Opus 4.8 passthrough works for base and [1m] aliases in messages and count_tokens');
  } finally {
    await runtime.close();
    await closeServer(anthropicServer);
  }
});
