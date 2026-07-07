#!/usr/bin/env node

import http from 'node:http';

import { createGatewayServer } from '../../js/gateway/server.js';

const MODEL_ID = 'glm-5.2[1m]';
const UPSTREAM_MODEL = 'glm-5.2';
const ROUTED_MODEL_ID = `glm:${UPSTREAM_MODEL}/max via ${MODEL_ID}`;
const MAX_TOKENS = 512;
const LIVE_SESSION_HEADERS = Object.freeze({
  'x-claude-code-session-id': 'live-glm-session',
  'x-claude-code-agent-id': 'live-glm-agent',
});

function apiKey() {
  return (
    process.env.ULTRATHINK_GATEWAY_GLM_API_KEY ||
    process.env.ZAI_API_KEY ||
    process.env.GLM_API_KEY ||
    ''
  );
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

function gatewayConfig(port, key) {
  return {
    host: '127.0.0.1',
    port,
    traceDir: '',
    displayRoutedModel: true,
    sharedSecret: '',
    requestTimeoutMs: 120_000,
    exposedModels: [MODEL_ID, UPSTREAM_MODEL],
    routeMap: {
      [MODEL_ID]: {
        provider: 'glm',
        model: MODEL_ID,
        reasoningEffort: 'max',
        displayName: 'GLM 5.2 Live Route',
      },
      [UPSTREAM_MODEL]: {
        provider: 'glm',
        model: UPSTREAM_MODEL,
        reasoningEffort: 'max',
        displayName: 'GLM 5.2 Live Route',
      },
    },
    anthropicPassthroughModels: [],
    codex: {
      enabled: false,
      command: 'codex',
      cwd: process.cwd(),
      model: 'gpt-5.5',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      reasoningEffort: 'low',
      verbosity: 'low',
      inputMaxTokens: 0,
      toolResultMaxBytes: 0,
      toolResultWindowMaxBytes: 0,
      autoCompactTokenLimit: 0,
      autoCompactTokenLimitScope: 'body_after_prefix',
      idleTimeoutMs: 1_000,
      forkIdleTimeoutMs: 1_000,
      maxSessions: 1,
      closeKillTimeoutMs: 100,
    },
    openai: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      model: 'gpt-5.5',
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
    glm: {
      apiKey: key,
      baseUrl:
        process.env.ULTRATHINK_GATEWAY_GLM_BASE_URL ||
        process.env.ZAI_BASE_URL ||
        process.env.GLM_BASE_URL ||
        'https://api.z.ai/api/coding/paas/v4',
      model: UPSTREAM_MODEL,
      reasoningEffort: 'max',
      thinking: {
        type: 'enabled',
        clear_thinking: false,
      },
    },
    anthropic: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:1',
      version: '2023-06-01',
    },
  };
}

function weatherTool() {
  return {
    name: 'lookup_weather',
    description: 'Fetch weather.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
      },
      required: ['city'],
      additionalProperties: false,
    },
  };
}

async function postMessage(baseUrl, body, headers = {}) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`gateway returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
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
          event.payload = JSON.parse(line.slice('data: '.length));
        }
      }

      return event;
    });
}

async function streamMessage(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_ID,
      stream: true,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: 'Reply exactly STREAM_OK.' }],
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`stream gateway returned HTTP ${response.status}: ${text}`);
  }

  return parseSsePayloads(text);
}

function textFromContent(content) {
  return content
    .filter(function textBlock(block) {
      return block.type === 'text';
    })
    .map(function blockText(block) {
      return block.text || '';
    })
    .join('');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPositiveUsage(usage, label) {
  assert(usage?.input_tokens > 0, `${label} did not report input tokens`);
  assert(usage?.output_tokens > 0, `${label} did not report output tokens`);
}

async function verifySimpleTurn(baseUrl) {
  const payload = await postMessage(baseUrl, {
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: 'Reply exactly GLM_GATEWAY_OK.' }],
  });

  assert(payload.model === ROUTED_MODEL_ID, 'routed model metadata was wrong');
  assert(textFromContent(payload.content).includes('GLM_GATEWAY_OK'), 'simple GLM response marker missing');
  assertPositiveUsage(payload.usage, 'simple GLM response');
}

async function verifyToolLoop(baseUrl) {
  const firstPayload = await postMessage(
    baseUrl,
    {
      model: MODEL_ID,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: 'Use lookup_weather for Riyadh. Do not answer directly.' }],
      tools: [weatherTool()],
      tool_choice: {
        type: 'tool',
        name: 'lookup_weather',
      },
    },
    LIVE_SESSION_HEADERS
  );
  const toolUse = firstPayload.content.find(function findToolUse(block) {
    return block.type === 'tool_use';
  });
  assert(toolUse, 'GLM did not return a tool_use block');
  assert(toolUse.name === 'lookup_weather', 'GLM returned the wrong tool name');

  const secondPayload = await postMessage(
    baseUrl,
    {
      model: MODEL_ID,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'user', content: 'Use lookup_weather for Riyadh. Do not answer directly.' },
        {
          role: 'assistant',
          content: [toolUse],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({
                city: 'Riyadh',
                temperature_c: 44,
                condition: 'hot and dry',
              }),
            },
            {
              type: 'text',
              text: 'Answer with the temperature and condition from the tool result.',
            },
          ],
        },
      ],
      tools: [weatherTool()],
      tool_choice: {
        type: 'none',
      },
    },
    LIVE_SESSION_HEADERS
  );
  const text = textFromContent(secondPayload.content);
  assert(
    /44|hot/i.test(text),
    `GLM tool loop final answer did not use the tool result: ${JSON.stringify(secondPayload.content)}`
  );
}

async function verifyStreaming(baseUrl) {
  const events = await streamMessage(baseUrl);
  const text = events
    .filter(function textDelta(event) {
      return event.payload?.delta?.type === 'text_delta';
    })
    .map(function deltaText(event) {
      return event.payload.delta.text || '';
    })
    .join('');
  const terminalDelta = events.find(function messageDelta(event) {
    return event.name === 'message_delta';
  });

  assert(text.includes('STREAM_OK'), 'streaming GLM response marker missing');
  assertPositiveUsage(terminalDelta?.payload?.usage, 'streaming GLM response');
}

async function main() {
  const key = apiKey();
  if (!key) {
    console.log('SKIP: set ULTRATHINK_GATEWAY_GLM_API_KEY, ZAI_API_KEY, or GLM_API_KEY to run live GLM gateway tests.');
    return;
  }

  const port = await freePort();
  const runtime = createGatewayServer(gatewayConfig(port, key));
  await waitForListening(runtime.server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await verifySimpleTurn(baseUrl);
    await verifyToolLoop(baseUrl);
    await verifyStreaming(baseUrl);
    console.log('PASS: live GLM 5.2 gateway routing, tool loop, thinking, and streaming usage verified.');
  } finally {
    await runtime.close();
  }
}

main().catch(function onError(error) {
  console.error(error.stack || error.message);
  process.exit(1);
});
