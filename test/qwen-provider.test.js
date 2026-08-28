import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadGatewayConfig } from '../js/gateway/config.js';
import { resolveModelRoute } from '../js/gateway/model-routing.js';
import { createGatewayServer } from '../js/gateway/server.js';
import {
  QWEN_MAIN_MODEL_ID,
  buildWorkflowClientEnv,
  buildWorkflowGatewayConfig,
} from '../js/gateway/workflow-config.js';
import { environmentWithoutGatewayCredentials } from '../js/utils/child-env.js';

const QWEN_API_KEY = 'sk-sp-test-qwen-upstream-key';
const GATEWAY_SECRET = 'test-qwen-gateway-secret';
const QWEN_MODEL = 'qwen3.8-max';
const QWEN_CONTEXT_TOKENS = 983_616;
const CLAUDE_COMMON_CONTEXT_TOKENS = 828_400;
const CLAUDE_COMMON_AUTO_COMPACT_TOKENS = 784_800;
const DAEMON_PATH = fileURLToPath(
  new URL('../js/cli/claude-workflow-daemon.js', import.meta.url)
);
const ISOLATED_ENV_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES',
  'BAILIAN_TOKEN_PLAN_API_KEY',
  'DASHSCOPE_API_KEY',
  'QWEN_API_KEY',
  'QWEN_BASE_URL',
  'QWEN_MODEL',
  'QWEN_REASONING_EFFORT',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL',
  'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID',
  'ULTRATHINK_GATEWAY_CODEX_COMMAND',
  'ULTRATHINK_GATEWAY_CODEX_MODEL',
  'ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY',
  'ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS',
  'ULTRATHINK_GATEWAY_MAIN_MODEL_ID',
  'ULTRATHINK_GATEWAY_MAIN_PROVIDER',
  'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL',
  'ULTRATHINK_GATEWAY_QWEN_API_KEY',
  'ULTRATHINK_GATEWAY_QWEN_BASE_URL',
  'ULTRATHINK_GATEWAY_QWEN_CONTEXT_TOKENS',
  'ULTRATHINK_GATEWAY_QWEN_MAX_OUTPUT_TOKENS',
  'ULTRATHINK_GATEWAY_QWEN_MODEL',
  'ULTRATHINK_GATEWAY_QWEN_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_ROUTE_MAP_JSON',
  'ULTRATHINK_GATEWAY_SHARED_SECRET',
  'ULTRATHINK_GATEWAY_SUBAGENT_MODEL_ID',
  'ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT',
  'ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL',
  'CLAUDE_WORKFLOW_MAIN_PROVIDER',
]);

function updateEnvironment(updates) {
  const previous = new Map();
  for (const [name, value] of Object.entries(updates)) {
    previous.set(name, process.env[name]);
    if (value === undefined || value === null || value === '') {
      delete process.env[name];
    } else {
      process.env[name] = String(value);
    }
  }
  return function restoreEnvironment() {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

async function withIsolatedEnvironment(overrides, callback) {
  const clean = Object.fromEntries(ISOLATED_ENV_NAMES.map((name) => [name, undefined]));
  const restore = updateEnvironment({ ...clean, ...overrides });
  try {
    return await callback();
  } finally {
    restore();
  }
}

function listen(server) {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise(function waitForListening(resolve, reject) {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise(function closeServer(resolve, reject) {
    server.close(function serverClosed(error) {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function jsonHeaders(extra = {}) {
  return { 'content-type': 'application/json', ...extra };
}

test('Qwen profile exposes its exact route with the shared Codex-safe Claude context', async function () {
  await withIsolatedEnvironment(
    {
      DASHSCOPE_API_KEY: 'test-low-priority-qwen-key',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: QWEN_MAIN_MODEL_ID,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'qwen',
      ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
    },
    async function verifyQwenProfile() {
      const loaded = loadGatewayConfig();
      assert.deepEqual(loaded.qwen, {
        apiKey: QWEN_API_KEY,
        baseUrl:
          'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
        model: QWEN_MODEL,
        reasoningEffort: 'xhigh',
        contextTokens: QWEN_CONTEXT_TOKENS,
        totalContextTokens: 1_000_000,
        maxOutputTokens: 131_072,
      });

      const workflow = buildWorkflowGatewayConfig();
      const route = resolveModelRoute(QWEN_MAIN_MODEL_ID, workflow.config);
      assert.equal(workflow.mainModelId, QWEN_MAIN_MODEL_ID);
      assert.equal(route.provider, 'qwen');
      assert.equal(route.transport, 'openai');
      assert.equal(route.upstreamModel, QWEN_MODEL);
      assert.equal(route.reasoningEffort, 'xhigh');
      assert.equal(route.contextTokens, QWEN_CONTEXT_TOKENS);
      assert.equal(route.totalContextTokens, 1_000_000);
      assert.equal(route.maxOutputTokens, 131_072);
      assert.equal(route.preserveAssistantThinking, true);
      assert.equal(route.emitReasoningContent, true);
      assert.equal(route.enableThinking, true);
      assert.equal(route.preserveThinking, true);
      assert.equal(route.supportsParallelToolCalls, true);
      assert.equal(route.explicitParallelToolCalls, true);
      assert.equal(route.toolChoicePolicy, 'auto-none');
      assert.equal(route.strictThinkingReplay, true);
      assert.equal(route.suppressTerminalTitleRequest, true);
      assert.equal(workflow.config.sharedSecret.length >= 32, true);
      assert.throws(
        () => createGatewayServer({ ...workflow.config, sharedSecret: '' }),
        /Qwen routes require gateway authentication/u
      );

      const clientEnv = buildWorkflowClientEnv(
        workflow.config,
        'http://127.0.0.1:4318',
        workflow.subagentModelId,
        workflow.mainModelId
      );
      assert.equal(clientEnv.ANTHROPIC_MODEL, QWEN_MAIN_MODEL_ID);
      assert.equal(
        clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
        String(CLAUDE_COMMON_AUTO_COMPACT_TOKENS)
      );
      assert.equal(
        clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
        String(CLAUDE_COMMON_CONTEXT_TOKENS)
      );
      assert.equal(clientEnv.CLAUDE_CODE_EFFORT_LEVEL, 'max');
      assert.equal(clientEnv.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
      assert.equal(clientEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
      assert.equal(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION, QWEN_MAIN_MODEL_ID);
      assert.equal(clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME, 'Qwen 3.8 Max Main Route');
      assert.equal(
        clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
        'qwen:qwen3.8-max/xhigh through claude-workflow'
      );
      assert.equal(
        clientEnv.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES,
        'effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking'
      );
      assert.equal(clientEnv.ANTHROPIC_API_KEY, workflow.config.sharedSecret);
      assert.equal(Object.values(clientEnv).includes(QWEN_API_KEY), false);

      const cleaned = environmentWithoutGatewayCredentials({
        KEEP_ME: 'yes',
        BAILIAN_TOKEN_PLAN_API_KEY: 'one',
        DASHSCOPE_API_KEY: 'two',
        QWEN_API_KEY: 'three',
        ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
      });
      assert.deepEqual(cleaned, { KEEP_ME: 'yes' });
    }
  );
});

test('Qwen paired with literal-1M Codex agents keeps proactive input headroom', async function () {
  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_CODEX_COMMAND: '/definitely/missing/codex',
      ULTRATHINK_GATEWAY_CODEX_MODEL: 'gpt-5.4',
      ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT: 'xhigh',
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: QWEN_MAIN_MODEL_ID,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'qwen',
      ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
      ULTRATHINK_GATEWAY_SUBAGENT_REASONING_EFFORT: 'xhigh',
      ULTRATHINK_GATEWAY_SUBAGENT_UPSTREAM_MODEL: 'gpt-5.4',
    },
    async function verifyQwenHeadroom() {
      const workflow = buildWorkflowGatewayConfig();
      const clientEnv = buildWorkflowClientEnv(
        workflow.config,
        'http://127.0.0.1:4318',
        workflow.subagentModelId,
        workflow.mainModelId
      );
      assert.equal(workflow.subagentModelId, 'codex-gpt-5.4');
      assert.equal(clientEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '950000');
      assert.equal(clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '900000');
      assert.equal(QWEN_CONTEXT_TOKENS - 900_000, 83_616);
    }
  );
});

test('Qwen effort aliases normalize to Alibaba-supported levels and invalid values fail locally', async function () {
  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        qwenHigh: { provider: 'QWEN', model: QWEN_MODEL, reasoningEffort: 'max' },
        qwenMedium: { provider: 'qwen', model: QWEN_MODEL, reasoning_effort: 'medium' },
        qwenBad: { provider: 'qwen', model: QWEN_MODEL, reasoningEffort: 'extreme' },
      }),
    },
    async function verifyEffortValidation() {
      const config = loadGatewayConfig();
      assert.equal(resolveModelRoute('qwenHigh', config).reasoningEffort, 'xhigh');
      assert.equal(resolveModelRoute('qwenHigh', config).upstreamModel, QWEN_MODEL);
      assert.equal(resolveModelRoute('qwenMedium', config).reasoningEffort, 'medium');
      assert.throws(
        () => resolveModelRoute('qwenBad', config),
        /Qwen route.*low, medium, or xhigh/u
      );
    }
  );

  for (const [baseUrl, expectedError] of [
    ['http://api.example.com/compatible-mode/v1', /refuses remote http:\/\//u],
    ['ftp://api.example.com/compatible-mode/v1', /requires an https:\/\/ base URL/u],
    ['javascript:alert(1)', /requires an https:\/\/ base URL/u],
  ]) {
    await withIsolatedEnvironment(
      {
        ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
        QWEN_BASE_URL: baseUrl,
        ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
          [QWEN_MAIN_MODEL_ID]: { provider: 'qwen', model: QWEN_MODEL },
        }),
      },
      async function rejectUnsafeQwenEndpoint() {
        const config = loadGatewayConfig();
        assert.throws(() => resolveModelRoute(QWEN_MAIN_MODEL_ID, config), expectedError);
      }
    );
  }

  for (const baseUrl of [
    'https://api.example.com/compatible-mode/v1',
    'http://localhost:8080/compatible-mode/v1',
    'http://127.12.34.56:8080/compatible-mode/v1',
    'http://[::1]:8080/compatible-mode/v1',
  ]) {
    await withIsolatedEnvironment(
      {
        ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
        QWEN_BASE_URL: baseUrl,
        ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
          [QWEN_MAIN_MODEL_ID]: { provider: 'qwen', model: QWEN_MODEL },
        }),
      },
      async function acceptSecureOrLoopbackQwenEndpoint() {
        const config = loadGatewayConfig();
        assert.equal(resolveModelRoute(QWEN_MAIN_MODEL_ID, config).provider, 'qwen');
      }
    );
  }
});

test('Qwen pairs Token Plan credentials with its endpoint and requires explicit custom DashScope routing', async function () {
  await withIsolatedEnvironment(
    { DASHSCOPE_API_KEY: 'sk-test-dashscope-payg-key' },
    async function ignoreAmbientPaygKeyForTokenPlan() {
      assert.equal(loadGatewayConfig().qwen.apiKey, '');
    }
  );

  await withIsolatedEnvironment(
    {
      DASHSCOPE_API_KEY: 'sk-test-dashscope-payg-key',
      QWEN_BASE_URL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
    async function allowExplicitPaygPairing() {
      const config = loadGatewayConfig();
      assert.equal(config.qwen.apiKey, 'sk-test-dashscope-payg-key');
      assert.equal(resolveModelRoute(QWEN_MAIN_MODEL_ID, {
        ...config,
        routeMap: {
          [QWEN_MAIN_MODEL_ID]: { provider: 'qwen', model: QWEN_MODEL },
        },
      }).provider, 'qwen');
    }
  );

  await withIsolatedEnvironment(
    {
      QWEN_API_KEY: 'sk-test-wrong-plan-key',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        [QWEN_MAIN_MODEL_ID]: { provider: 'qwen', model: QWEN_MODEL },
      }),
    },
    async function rejectMismatchedPlanKey() {
      const config = loadGatewayConfig();
      assert.throws(
        () => resolveModelRoute(QWEN_MAIN_MODEL_ID, config),
        /Token Plan endpoint requires its matching sk-sp- credential/u
      );
    }
  );

  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
      QWEN_BASE_URL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
      ULTRATHINK_GATEWAY_ROUTE_MAP_JSON: JSON.stringify({
        [QWEN_MAIN_MODEL_ID]: { provider: 'qwen', model: QWEN_MODEL },
      }),
    },
    async function rejectAnthropicEndpointOnOpenAiTransport() {
      const config = loadGatewayConfig();
      assert.throws(
        () => resolveModelRoute(QWEN_MAIN_MODEL_ID, config),
        /OpenAI-compatible transport.*not the apps\/anthropic endpoint/u
      );
    }
  );
});

test('Qwen and Anthropic mixed routes require separate gateway-side credentials', async function () {
  const base = {
    ANTHROPIC_API_KEY: 'test-generic-anthropic-key',
    ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS: 'claude-opus-5*',
    ULTRATHINK_GATEWAY_MAIN_MODEL_ID: QWEN_MAIN_MODEL_ID,
    ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'qwen',
    ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
  };
  await withIsolatedEnvironment(base, async function rejectCredentialReuse() {
    assert.throws(
      () => buildWorkflowGatewayConfig(),
      /Qwen route combined with an Anthropic route requires a dedicated gateway-side Anthropic API key/u
    );
  });
  await withIsolatedEnvironment(
    { ...base, ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY: 'test-dedicated-anthropic-key' },
    async function acceptDistinctCredentials() {
      const workflow = buildWorkflowGatewayConfig();
      assert.equal(resolveModelRoute(QWEN_MAIN_MODEL_ID, workflow.config).provider, 'qwen');
      assert.equal(resolveModelRoute('claude-opus-5', workflow.config).provider, 'anthropic');
    }
  );
});

test('Qwen OpenAI transport preserves max thinking, reasoning blocks, tools, and large results in one call', async function () {
  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: QWEN_MAIN_MODEL_ID,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'qwen',
      ULTRATHINK_GATEWAY_QWEN_API_KEY: QWEN_API_KEY,
    },
    async function verifyQwenWireContract() {
      const requests = [];
      const upstream = http.createServer(async function fakeQwen(req, res) {
        const body = await readJsonBody(req);
        requests.push({ body, headers: req.headers, method: req.method, url: req.url });
        if (req.url !== '/compatible-mode/v1/chat/completions') {
          res.writeHead(404, jsonHeaders());
          res.end(JSON.stringify({ error: { message: 'wrong fake Qwen path' } }));
          return;
        }

        if (body.messages.some((message) => String(message.content).includes('RATE_LIMIT'))) {
          res.writeHead(429, {
            ...jsonHeaders(),
            'content-type': 'text/event-stream; charset=utf-8',
            'request-id': 'qwen-request-id',
            'retry-after': '7',
            'x-ratelimit-remaining-requests': '0',
            'x-upstream-private': 'must-not-propagate',
          });
          res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
          return;
        }

        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          const chunks = body.tools
            ? [
                'data: {"id":"chat_qwen_tools","choices":[{"delta":{"reasoning_content":"choose tools"},"finish_reason":null}]}\r\n\r\n',
                'data: {"id":"chat_qwen_tools","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"Read","arguments":"{\\"file_path\\":\\"a"}},{"index":1,"id":"call_b","function":{"name":"Read","arguments":"{\\"file_path\\":\\"b"}}]},"finish_reason":null}]}\r\n\r\n',
                'data: {"id":"chat_qwen_tools","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".js\\"}"}},{"index":1,"function":{"arguments":".js\\"}"}}]},"finish_reason":"tool_calls"}]}\r\n\r\n',
                'data: {"id":"chat_qwen_tools","choices":[],"usage":{"prompt_tokens":21,"completion_tokens":11}}\r\n\r\n',
                'data: [DONE]\r\n\r\n',
              ]
            : [
                'data: {"id":"chat_qwen_stream","choices":[{"delta":{"reasoning_content":"think "},"finish_reason":null}]}\r\n\r\n',
                'data: {"id":"chat_qwen_stream","choices":[{"delta":{"reasoning_content":"carefully"},"finish_reason":null}]}\r\n\r\n',
                'data: {"id":"chat_qwen_stream","choices":[{"delta":{"content":"QWEN_STREAM_OK"},"finish_reason":null}]}\r\n\r\n',
                'data: {"id":"chat_qwen_stream","choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
                'data: {"id":"chat_qwen_stream","choices":[],"usage":{"prompt_tokens":17,"completion_tokens":9}}\r\n\r\n',
                'data: [DONE]\r\n\r\n',
              ];
          for (const chunk of chunks) {
            res.write(chunk);
          }
          res.end();
          return;
        }

        const hasToolResult = body.messages.some((message) => message.role === 'tool');
        if (body.tools && body.tool_choice !== 'none' && !hasToolResult) {
          res.writeHead(200, jsonHeaders());
          res.end(
            JSON.stringify({
              id: 'chat_qwen_tool',
              model: QWEN_MODEL,
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    reasoning_content: 'reason-before-tool',
                    tool_calls: [
                      {
                        id: 'call_qwen_read',
                        type: 'function',
                        function: { name: 'Read', arguments: '{"file_path":"package.json"}' },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 12 },
            })
          );
          return;
        }

        res.writeHead(200, jsonHeaders());
        res.end(
          JSON.stringify({
            id: 'chat_qwen_json',
            model: QWEN_MODEL,
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  reasoning_content: 'reason-before-answer',
                  content: hasToolResult ? 'QWEN_TOOL_OK' : 'QWEN_JSON_OK',
                },
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          })
        );
      });
      upstream.listen(0, '127.0.0.1');
      await listen(upstream);
      const upstreamAddress = upstream.address();
      assert.equal(typeof upstreamAddress, 'object');

      const workflow = buildWorkflowGatewayConfig();
      workflow.config.port = 0;
      workflow.config.sharedSecret = GATEWAY_SECRET;
      workflow.config.displayRoutedModel = false;
      workflow.config.qwen.baseUrl = `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`;
      const runtime = createGatewayServer(workflow.config);
      await listen(runtime.server);
      const gatewayAddress = runtime.server.address();
      assert.equal(typeof gatewayAddress, 'object');
      const gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}`;
      const headers = jsonHeaders({
        authorization: `Bearer ${GATEWAY_SECRET}`,
        'x-api-key': 'must-not-reach-qwen',
      });

      try {
        const modelsResponse = await fetch(`${gatewayUrl}/v1/models`, { headers });
        assert.equal(modelsResponse.status, 200);
        const models = await modelsResponse.json();
        assert.equal(
          models.data.some((model) => model.id === QWEN_MAIN_MODEL_ID),
          true
        );

        const healthResponse = await fetch(`${gatewayUrl}/healthz`);
        assert.equal(healthResponse.status, 200);
        const health = await healthResponse.json();
        assert.equal(health.qwen_total_context_tokens, 1_000_000);
        assert.equal(health.qwen_input_ceiling_tokens, QWEN_CONTEXT_TOKENS);
        assert.equal(health.qwen_context_tokens, QWEN_CONTEXT_TOKENS);

        const jsonResponse = await fetch(`${gatewayUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: QWEN_MAIN_MODEL_ID,
            max_tokens: 262_144,
            system: [{ type: 'text', text: 'System contract.' }],
            thinking: { type: 'adaptive' },
            messages: [{ role: 'user', content: 'Return JSON path.' }],
          }),
        });
        assert.equal(jsonResponse.status, 200);
        const json = await jsonResponse.json();
        assert.deepEqual(json.content, [
          { type: 'thinking', thinking: 'reason-before-answer', signature: '' },
          { type: 'text', text: 'QWEN_JSON_OK' },
        ]);
        assert.equal(json.model, QWEN_MAIN_MODEL_ID);

        const firstRequest = requests.at(-1);
        assert.equal(firstRequest.method, 'POST');
        assert.equal(firstRequest.url, '/compatible-mode/v1/chat/completions');
        assert.equal(firstRequest.headers.authorization, `Bearer ${QWEN_API_KEY}`);
        assert.equal(firstRequest.headers['x-api-key'], undefined);
        assert.equal(firstRequest.body.model, QWEN_MODEL);
        assert.equal(firstRequest.body.max_tokens, 131_072);
        assert.equal(firstRequest.body.max_completion_tokens, undefined);
        assert.equal(firstRequest.body.reasoning_effort, 'xhigh');
        assert.equal(firstRequest.body.enable_thinking, true);
        assert.equal(firstRequest.body.preserve_thinking, true);
        assert.equal(firstRequest.body.thinking, undefined);
        assert.deepEqual(firstRequest.body.messages[0], {
          role: 'system',
          content: 'System contract.',
        });

        const streamResponse = await fetch(`${gatewayUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: QWEN_MAIN_MODEL_ID,
            max_tokens: 1024,
            stream: true,
            messages: [{ role: 'user', content: 'Stream.' }],
          }),
        });
        assert.equal(streamResponse.status, 200);
        const streamText = await streamResponse.text();
        assert.match(streamText, /"type":"thinking"/u);
        assert.match(streamText, /"type":"thinking_delta","thinking":"think "/u);
        assert.match(streamText, /"type":"thinking_delta","thinking":"carefully"/u);
        assert.match(streamText, /"index":1,"content_block":\{"type":"text"/u);
        assert.match(streamText, /QWEN_STREAM_OK/u);
        assert.equal(requests.at(-1).body.tool_stream, undefined);

        const streamedTools = await fetch(`${gatewayUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: QWEN_MAIN_MODEL_ID,
            max_tokens: 1024,
            stream: true,
            tools: [
              {
                name: 'Read',
                description: 'Read one file.',
                input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
              },
            ],
            messages: [{ role: 'user', content: 'Read two files.' }],
          }),
        });
        assert.equal(streamedTools.status, 200);
        const streamedToolText = await streamedTools.text();
        assert.match(streamedToolText, /"index":0,"content_block":\{"type":"thinking"/u);
        assert.match(streamedToolText, /"index":1,"content_block":\{"type":"tool_use","id":"call_a"/u);
        assert.match(streamedToolText, /"index":2,"content_block":\{"type":"tool_use","id":"call_b"/u);
        assert.match(streamedToolText, /a\.js/u);
        assert.match(streamedToolText, /b\.js/u);
        assert.equal(requests.at(-1).body.tool_stream, true);
        assert.equal(requests.at(-1).body.parallel_tool_calls, true);

        const toolResponse = await fetch(`${gatewayUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: QWEN_MAIN_MODEL_ID,
            max_tokens: 1024,
            tools: [
              {
                name: 'Read',
                description: 'Read one file.',
                input_schema: {
                  type: 'object',
                  properties: { file_path: { type: 'string' } },
                  required: ['file_path'],
                },
              },
            ],
            tool_choice: { type: 'auto', disable_parallel_tool_use: true },
            messages: [{ role: 'user', content: 'Read package.json.' }],
          }),
        });
        assert.equal(toolResponse.status, 200);
        const toolMessage = await toolResponse.json();
        assert.deepEqual(toolMessage.content, [
          { type: 'thinking', thinking: 'reason-before-tool', signature: '' },
          {
            type: 'tool_use',
            id: 'call_qwen_read',
            name: 'Read',
            input: { file_path: 'package.json' },
          },
        ]);
        const toolRequest = requests.at(-1).body;
        assert.equal(toolRequest.parallel_tool_calls, false);

        const noToolResponse = await fetch(`${gatewayUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: QWEN_MAIN_MODEL_ID,
            max_tokens: 1024,
            tools: [
              {
                name: 'Read',
                description: 'Read one file.',
                input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
              },
            ],
            tool_choice: { type: 'none' },
            messages: [{ role: 'user', content: 'Do not use a tool.' }],
          }),
        });
        assert.equal(noToolResponse.status, 200);
        const noToolRequest = requests.at(-1).body;
        assert.equal(noToolRequest.tool_choice, 'none');
        assert.equal(noToolRequest.parallel_tool_calls, false);

        for (const unsupportedChoice of [
          { type: 'any' },
          { type: 'tool', name: 'Read' },
        ]) {
          const callsBeforeChoice = requests.length;
          const rejected = await fetch(`${gatewayUrl}/v1/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: QWEN_MAIN_MODEL_ID,
              max_tokens: 1024,
              tools: [
                {
                  name: 'Read',
                  input_schema: { type: 'object', properties: {} },
                },
              ],
              tool_choice: unsupportedChoice,
              messages: [{ role: 'user', content: 'Force a tool.' }],
            }),
          });
          assert.equal(rejected.status, 400);
          assert.match(
            (await rejected.json()).error.message,
            /support only tool_choice auto or none/u
          );
          assert.equal(requests.length, callsBeforeChoice);
        }

        for (const incompatibleHistory of [
          [
            { type: 'thinking', thinking: 'first', signature: '' },
            { type: 'thinking', thinking: 'second', signature: '' },
            { type: 'text', text: 'answer' },
          ],
          [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'answer' }],
        ]) {
          const callsBeforeHistory = requests.length;
          const rejected = await fetch(`${gatewayUrl}/v1/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: QWEN_MAIN_MODEL_ID,
              max_tokens: 1024,
              messages: [
                { role: 'user', content: 'Earlier question.' },
                { role: 'assistant', content: incompatibleHistory },
                { role: 'user', content: 'Continue.' },
              ],
            }),
          });
          assert.equal(rejected.status, 400);
          assert.match((await rejected.json()).error.message, /Qwen/u);
          assert.equal(requests.length, callsBeforeHistory);
        }

        const largeResult = [
          'QWEN-LARGE-FIRST',
          ...Array.from({ length: 12_000 }, (_, index) => `line-${index}`),
          'QWEN-LARGE-MIDDLE',
          'QWEN-LARGE-LAST',
        ].join('\n');
        const continuationResponse = await fetch(`${gatewayUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: QWEN_MAIN_MODEL_ID,
            max_tokens: 1024,
            tools: toolRequest.tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters,
            })),
            messages: [
              { role: 'user', content: 'Read package.json.' },
              { role: 'assistant', content: toolMessage.content },
              {
                role: 'user',
                content: [
                  { type: 'tool_result', tool_use_id: 'call_qwen_read', content: largeResult },
                ],
              },
            ],
          }),
        });
        assert.equal(continuationResponse.status, 200);
        assert.equal((await continuationResponse.json()).content.at(-1).text, 'QWEN_TOOL_OK');
        const continuationRequest = requests.at(-1).body;
        const assistant = continuationRequest.messages.find((message) => message.role === 'assistant');
        const toolResult = continuationRequest.messages.find((message) => message.role === 'tool');
        assert.equal(assistant.reasoning_content, 'reason-before-tool');
        assert.equal(toolResult.content.startsWith('QWEN-LARGE-FIRST'), true);
        assert.equal(toolResult.content.includes('QWEN-LARGE-MIDDLE'), true);
        assert.equal(toolResult.content.endsWith('QWEN-LARGE-LAST'), true);

        const upstreamCallsBeforeCount = requests.length;
        const countResponse = await fetch(`${gatewayUrl}/v1/messages/count_tokens`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: QWEN_MAIN_MODEL_ID,
            messages: [{ role: 'user', content: `Count locally: ${'界'.repeat(1_000)}` }],
          }),
        });
        assert.equal(countResponse.status, 200);
        const count = (await countResponse.json()).input_tokens;
        assert.equal(Number.isInteger(count), true);
        assert.equal(count > 1_000, true, 'Unicode-heavy input must not be undercounted');
        assert.equal(requests.length, upstreamCallsBeforeCount);

        const limited = await fetch(`${gatewayUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: QWEN_MAIN_MODEL_ID,
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'RATE_LIMIT' }],
          }),
        });
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get('retry-after'), '7');
        assert.equal(limited.headers.get('request-id'), 'qwen-request-id');
        assert.equal(limited.headers.get('x-ratelimit-remaining-requests'), '0');
        assert.equal(limited.headers.get('x-upstream-private'), null);
        assert.match(limited.headers.get('content-type'), /^application\/json\b/u);
        const limitedBody = await limited.text();
        assert.match(limitedBody, /slow down/u);
        assert.equal(limitedBody.includes(QWEN_API_KEY), false);
      } finally {
        await runtime.close();
        await close(upstream);
      }
    }
  );
});

test('Qwen routes fail locally and redact the credential when no key is configured', async function () {
  await withIsolatedEnvironment(
    {
      ULTRATHINK_GATEWAY_MAIN_MODEL_ID: QWEN_MAIN_MODEL_ID,
      ULTRATHINK_GATEWAY_MAIN_PROVIDER: 'qwen',
    },
    async function verifyMissingKey() {
      const workflow = buildWorkflowGatewayConfig();
      assert.throws(
        () => resolveModelRoute(QWEN_MAIN_MODEL_ID, workflow.config),
        function isActionable(error) {
          assert.equal(error.status, 500);
          assert.match(error.message, /ULTRATHINK_GATEWAY_QWEN_API_KEY|QWEN_API_KEY/u);
          assert.equal(error.message.includes(QWEN_API_KEY), false);
          return true;
        }
      );
    }
  );
});

test('shared daemon fails before listening when the Qwen credential is missing', async function () {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-qwen-daemon-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of ISOLATED_ENV_NAMES) {
    delete env[name];
  }
  env.ULTRATHINK_GATEWAY_MAIN_MODEL_ID = QWEN_MAIN_MODEL_ID;
  env.ULTRATHINK_GATEWAY_MAIN_PROVIDER = 'qwen';

  try {
    const result = spawnSync(process.execPath, [DAEMON_PATH], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout || ''}${result.stderr || ''}`,
      /Qwen routing is configured.*(?:ULTRATHINK_GATEWAY_QWEN_API_KEY|QWEN_API_KEY)/u
    );
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
