import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

import { loadGatewayConfig } from '../js/gateway/config.js';
import { createGatewayServer } from '../js/gateway/server.js';

const REQUEST_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const GATEWAY_SECRET = 'gateway-test-secret';
const UPSTREAM_SECRET = 'upstream-test-secret';
const TEST_MODEL = 'claude-contract-test';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function rawPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers,
      },
      (response) => {
        const chunks = [];
        let settled = false;
        const finish = (aborted) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            aborted,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode,
          });
        };
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => finish(false));
        response.on('aborted', () => finish(true));
        response.on('error', () => finish(true));
      }
    );
    request.once('error', reject);
    request.end(body);
  });
}

function anthropicMessage(model = TEST_MODEL) {
  return {
    id: 'msg_contract_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

async function startGateway(upstreamBaseUrl, options = {}) {
  const defaults = loadGatewayConfig();
  const config = {
    ...defaults,
    host: '127.0.0.1',
    port: 0,
    traceDir: '',
    sharedSecret: GATEWAY_SECRET,
    requestTimeoutMs: 5_000,
    authFailureRateLimitWindowMs: 60_000,
    authFailureRateLimitMaxRequests: 10_000,
    maxConcurrentRequests: 64,
    exposedModels: [TEST_MODEL],
    routeMap: {},
    anthropicPassthroughModels: [TEST_MODEL],
    codex: {
      ...defaults.codex,
      enabled: false,
    },
    anthropic: {
      ...defaults.anthropic,
      apiKey: UPSTREAM_SECRET,
      apiKeySource: 'dedicated',
      baseUrl: upstreamBaseUrl,
    },
    ...options,
  };
  const runtime = createGatewayServer(config);
  if (!runtime.server.listening) {
    await once(runtime.server, 'listening');
  }
  const address = runtime.server.address();
  return {
    runtime,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function gatewayHeaders(extra = {}) {
  return {
    authorization: `Bearer ${GATEWAY_SECRET}`,
    'content-type': 'application/json; charset=utf-8',
    ...extra,
  };
}

function jsonBodyWithExactBytes(byteLength) {
  const prefix = `{"model":"${TEST_MODEL}","stream":false,"padding":"`;
  const suffix = '"}';
  const fixedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  assert.ok(byteLength >= fixedBytes);
  const body = `${prefix}${'x'.repeat(byteLength - fixedBytes)}${suffix}`;
  assert.equal(Buffer.byteLength(body), byteLength);
  return body;
}

test('Anthropic proxy forwards evolving identity headers without forwarding gateway credentials', async function (t) {
  let captured = null;
  const upstream = http.createServer(async function capture(request, response) {
    const body = await readBody(request);
    captured = {
      body: JSON.parse(body.toString('utf8')),
      headers: request.headers,
      url: request.url,
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(
    `http://127.0.0.1:${upstreamAddress.port}/proxy/`
  );
  t.after(() => gateway.runtime.close());

  const response = await rawPost(
    `${gateway.url}/v1/messages?beta=true&future=1`,
    gatewayHeaders({
      'anthropic-api-key': 'must-not-leak',
      'anthropic-auth-token': 'must-not-leak',
      'anthropic-beta': 'future-beta',
      'anthropic-connection-scoped': 'must-not-forward',
      'anthropic-future-identity': 'future-value',
      'anthropic-version': 'future-version',
      'anthropic-workspace-id': 'workspace-123',
      connection: 'close, anthropic-connection-scoped',
      'user-agent': 'claude-contract-test/1.0',
      'x-api-key': GATEWAY_SECRET,
      'x-app': 'cli',
      'x-claude-code-api-key': 'must-not-leak',
      'x-claude-code-agent-id': 'agent-123',
      'x-claude-code-auth': 'must-not-leak',
      'x-claude-code-authorization': 'must-not-leak',
      'x-claude-code-session-id': 'session-123',
      'x-stainless-api-key': 'must-not-leak',
      'x-stainless-retry-count': '7',
    }),
    JSON.stringify({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 16,
      stream: false,
      future_body_field: { enabled: true },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).content[0].text, 'ok');
  assert.ok(captured);
  assert.equal(captured.url, '/proxy/v1/messages?beta=true&future=1');
  assert.deepEqual(captured.body.future_body_field, { enabled: true });
  assert.equal(captured.headers['anthropic-beta'], 'future-beta');
  assert.equal(captured.headers['anthropic-future-identity'], 'future-value');
  assert.equal(captured.headers['anthropic-version'], 'future-version');
  assert.equal(captured.headers['anthropic-workspace-id'], 'workspace-123');
  assert.equal(captured.headers['x-claude-code-agent-id'], 'agent-123');
  assert.equal(captured.headers['x-claude-code-session-id'], 'session-123');
  assert.equal(captured.headers['x-stainless-retry-count'], '7');
  assert.equal(captured.headers['user-agent'], 'claude-contract-test/1.0');
  assert.equal(captured.headers['x-app'], 'cli');
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.headers['x-api-key'], UPSTREAM_SECRET);
  assert.equal(captured.headers['anthropic-api-key'], undefined);
  assert.equal(captured.headers['anthropic-auth-token'], undefined);
  assert.equal(captured.headers['anthropic-connection-scoped'], undefined);
  assert.equal(captured.headers['x-claude-code-api-key'], undefined);
  assert.equal(captured.headers['x-claude-code-auth'], undefined);
  assert.equal(captured.headers['x-claude-code-authorization'], undefined);
  assert.equal(captured.headers['x-stainless-api-key'], undefined);
  assert.notEqual(captured.headers.connection, 'close');
  assert.equal(captured.headers['content-type'], 'application/json');
});

test('credentialed upstream redirects fail closed without replaying the Kimi key', async function (t) {
  let redirectedRequest = null;
  const redirectTarget = http.createServer(async function captureRedirect(request, response) {
    await readBody(request);
    redirectedRequest = request.headers;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage('k3')));
  });
  const redirectTargetAddress = await listen(redirectTarget);
  t.after(() => closeServer(redirectTarget));

  let sourceKey = null;
  const redirectSource = http.createServer(async function redirect(request, response) {
    await readBody(request);
    sourceKey = request.headers['x-api-key'];
    response.writeHead(307, {
      location: `http://127.0.0.1:${redirectTargetAddress.port}/credential-sink`,
    });
    response.end();
  });
  const redirectSourceAddress = await listen(redirectSource);
  t.after(() => closeServer(redirectSource));

  const kimiKey = 'test-kimi-redirect-key';
  const gateway = await startGateway('http://127.0.0.1:1/', {
    anthropicPassthroughModels: [],
    kimi: {
      apiKey: kimiKey,
      baseUrl: `http://127.0.0.1:${redirectSourceAddress.port}/`,
      contextTokens: 1_048_576,
      model: 'k3',
      reasoningEffort: 'max',
      version: '2023-06-01',
    },
    routeMap: {
      [TEST_MODEL]: { provider: 'kimi', model: 'k3', reasoningEffort: 'max' },
    },
  });
  t.after(() => gateway.runtime.close());

  const response = await rawPost(
    `${gateway.url}/v1/messages`,
    gatewayHeaders(),
    JSON.stringify({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 16,
      stream: false,
    })
  );
  assert.equal(response.status, 502);
  assert.equal(sourceKey, kimiKey);
  assert.equal(redirectedRequest, null);
  assert.deepEqual(JSON.parse(response.body), {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'upstream redirects are disabled to protect credentials and request integrity',
    },
  });
});

test('shared-secret Anthropic routes reject a generic upstream credential', function () {
  const config = loadGatewayConfig();
  assert.throws(
    () =>
      createGatewayServer({
        ...config,
        host: '127.0.0.1',
        port: 0,
        sharedSecret: GATEWAY_SECRET,
        anthropicPassthroughModels: [TEST_MODEL],
        routeMap: {},
        anthropic: {
          ...config.anthropic,
          apiKey: 'generic-anthropic-key',
          apiKeySource: 'generic',
        },
      }),
    /requires ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY/u
  );
});

test('invalid credentials are rate-limited without throttling valid model requests', async function (t) {
  let upstreamRequests = 0;
  const upstream = http.createServer(async function respond(request, response) {
    await readBody(request);
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    authFailureRateLimitMaxRequests: 2,
  });
  t.after(() => gateway.runtime.close());
  const body = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 16,
  });

  const unrelated = await fetch(`${gateway.url}/v1evil`, {
    headers: { authorization: 'Bearer wrong-secret' },
  });
  assert.equal(unrelated.status, 404);

  const wrong = await rawPost(
    `${gateway.url}/V1/MESSAGES/`,
    gatewayHeaders({ authorization: 'Bearer wrong-secret' }),
    body
  );
  assert.equal(wrong.status, 401);

  const missing = await rawPost(
    `${gateway.url}/v1/messages`,
    { 'content-type': 'application/json' },
    body
  );
  assert.equal(missing.status, 401);

  const limited = await rawPost(
    `${gateway.url}/v1/messages`,
    gatewayHeaders({ authorization: 'Bearer another-wrong-secret' }),
    `{"model":"${TEST_MODEL}"`
  );
  assert.equal(limited.status, 429);
  assert.equal(Number(limited.headers['retry-after']) >= 1, true);
  assert.equal(JSON.parse(limited.body).error.type, 'rate_limit_error');
  assert.equal(upstreamRequests, 0);

  for (let index = 0; index < 4; index += 1) {
    const valid = await rawPost(`${gateway.url}/v1/messages`, gatewayHeaders(), body);
    assert.equal(valid.status, 200);
  }
  assert.equal(upstreamRequests, 4);
});

test('anonymous health polling stays unlimited while wrong health credentials are bounded', async function (t) {
  const gateway = await startGateway('http://127.0.0.1:1/', {
    host: '0.0.0.0',
    authFailureRateLimitMaxRequests: 1,
  });
  t.after(() => gateway.runtime.close());

  for (let index = 0; index < 4; index += 1) {
    const health = await fetch(`${gateway.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  }

  const firstWrong = await fetch(`${gateway.url}/HEALTHZ/`, {
    headers: { authorization: 'Bearer wrong-secret' },
  });
  assert.equal(firstWrong.status, 200);
  assert.deepEqual(await firstWrong.json(), {
    ok: true,
    service: 'claude-workflow-gateway',
  });

  const limitedWrong = await fetch(`${gateway.url}/healthz`, {
    headers: { authorization: 'Bearer another-wrong-secret' },
  });
  assert.equal(limitedWrong.status, 429);
  assert.equal((await limitedWrong.json()).error.type, 'rate_limit_error');

  const valid = await fetch(`${gateway.url}/healthz`, {
    headers: gatewayHeaders(),
  });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).runtime_pid, process.pid);
});

test('no-secret loopback routes do not acquire an authentication-failure quota', async function (t) {
  let upstreamRequests = 0;
  const upstream = http.createServer(async function respond(request, response) {
    await readBody(request);
    upstreamRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    sharedSecret: '',
    authFailureRateLimitMaxRequests: 1,
  });
  t.after(() => gateway.runtime.close());
  const body = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 16,
  });

  for (let index = 0; index < 3; index += 1) {
    const response = await rawPost(
      `${gateway.url}/v1/messages`,
      { 'content-type': 'application/json' },
      body
    );
    assert.equal(response.status, 200);
  }
  assert.equal(upstreamRequests, 3);
});

test('concurrent admission is held through the response and runs before JSON buffering', async function (t) {
  let releaseFirst;
  const firstRelease = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstReceived;
  const firstReceived = new Promise((resolve) => {
    markFirstReceived = resolve;
  });
  let upstreamRequests = 0;
  const upstream = http.createServer(async function respond(request, response) {
    const requestBody = JSON.parse((await readBody(request)).toString('utf8'));
    upstreamRequests += 1;
    if (upstreamRequests === 1) {
      assert.equal(requestBody.stream, true);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      response.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      markFirstReceived();
      await firstRelease;
      response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => {
    releaseFirst();
    return closeServer(upstream);
  });

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    maxConcurrentRequests: 1,
  });
  t.after(() => gateway.runtime.close());
  const streamedBody = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 16,
    stream: true,
  });
  const body = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 16,
    stream: false,
  });

  const first = rawPost(`${gateway.url}/v1/messages`, gatewayHeaders(), streamedBody);
  await firstReceived;

  const limited = await rawPost(
    `${gateway.url}/v1/messages`,
    gatewayHeaders(),
    `{"model":"${TEST_MODEL}"`
  );
  assert.equal(limited.status, 429);
  assert.equal(JSON.parse(limited.body).error.type, 'rate_limit_error');
  assert.equal(upstreamRequests, 1);

  releaseFirst();
  assert.equal((await first).status, 200);

  const afterRelease = await rawPost(
    `${gateway.url}/v1/messages`,
    gatewayHeaders(),
    body
  );
  assert.equal(afterRelease.status, 200);
  assert.equal(upstreamRequests, 2);
});

test('health reports resolved Codex context capabilities and only active compact overrides', async function (t) {
  const gateway = await startGateway('http://127.0.0.1:1/');
  t.after(() => gateway.runtime.close());

  const capabilities = gateway.runtime.config.codex.capabilities;
  const initial = await fetch(`${gateway.url}/healthz`);
  assert.equal(initial.status, 200);
  const health = await initial.json();
  assert.equal(health.auth_failure_rate_limit_window_ms, 60_000);
  assert.equal(health.auth_failure_rate_limit_max_requests, 10_000);
  assert.equal(health.request_max_concurrent_requests, 64);
  assert.equal(health.request_active_operations, 0);
  assert.equal(health.codex_context_profile, capabilities.profile);
  assert.equal(health.codex_context_source, capabilities.source);
  assert.equal(
    health.codex_requested_raw_context_tokens,
    capabilities.requestedRawContextTokens
  );
  assert.equal(
    health.codex_resolved_raw_context_tokens,
    capabilities.resolvedRawContextTokens
  );
  assert.equal(health.codex_usable_context_tokens, capabilities.usableContextTokens);
  assert.equal(
    health.codex_native_auto_compact_tokens,
    capabilities.autoCompactTokens
  );
  assert.equal(health.codex_max_raw_context_tokens, capabilities.maxRawContextTokens);
  assert.equal(health.codex_auto_compact_token_limit_scope, null);

  gateway.runtime.config.codex.autoCompactTokenLimit = 123_456;
  gateway.runtime.config.codex.autoCompactTokenLimitScope = 'body_after_prefix';
  const overridden = await (await fetch(`${gateway.url}/healthz`)).json();
  assert.equal(overridden.codex_auto_compact_token_limit, 123_456);
  assert.equal(
    overridden.codex_auto_compact_token_limit_scope,
    'body_after_prefix'
  );
});

test('gateway accepts 32 MiB JSON and returns an Anthropic 413 above the limit', async function (t) {
  const upstreamBodies = [];
  const upstream = http.createServer(async function capture(request, response) {
    const body = await readBody(request);
    upstreamBodies.push(body.length);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(anthropicMessage()));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`);
  t.after(() => gateway.runtime.close());

  const acceptedBody = jsonBodyWithExactBytes(REQUEST_BODY_LIMIT_BYTES);
  const accepted = await fetch(`${gateway.url}/v1/messages`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: acceptedBody,
  });
  assert.equal(accepted.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.equal(upstreamBodies[0], REQUEST_BODY_LIMIT_BYTES);

  const rejectedBody = jsonBodyWithExactBytes(REQUEST_BODY_LIMIT_BYTES + 1);
  const rejected = await fetch(`${gateway.url}/v1/messages`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: rejectedBody,
  });
  assert.equal(rejected.status, 413);
  assert.deepEqual(await rejected.json(), {
    type: 'error',
    error: {
      type: 'request_too_large',
      message: 'request body exceeds the 32 MiB limit',
    },
  });
  assert.equal(upstreamBodies.length, 1);

  const malformed = await fetch(`${gateway.url}/v1/messages`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: `{"model":"${TEST_MODEL}"`,
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.type, 'invalid_request_error');
});

test('proxied SSE keepalives stay between frames and never enter JSON errors', async function (t) {
  const upstream = http.createServer(async function respond(request, response) {
    const body = JSON.parse((await readBody(request)).toString('utf8'));
    if (body.metadata?.test_case === 'json-error') {
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '3',
      });
      response.flushHeaders();
      setTimeout(function finishJsonError() {
        response.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' },
        }));
      }, 70);
      return;
    }
    if (body.metadata?.test_case === 'truncated-json') {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.write('{"type":"error","error":{"type":"api_error"');
      setTimeout(() => response.destroy(), 20);
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    response.write('event: message_start\ndata: {"type":"message_');
    setTimeout(function finishSseFrame() {
      response.end('start"}\n\n');
    }, 70);
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gateway = await startGateway(`http://127.0.0.1:${upstreamAddress.port}/`, {
    sseKeepaliveIntervalMs: 15,
  });
  t.after(() => gateway.runtime.close());

  const streamed = await fetch(`${gateway.url}/v1/messages?beta=true`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: JSON.stringify({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 16,
      stream: true,
    }),
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get('content-type') || '', /^text\/event-stream/iu);
  const streamedText = await streamed.text();
  assert.ok((streamedText.match(/event: ping/gu) || []).length >= 2, streamedText);
  assert.match(
    streamedText,
    /event: message_start\ndata: \{"type":"message_start"\}\n\n/u
  );
  assert.doesNotMatch(streamedText, /message_\s*event: ping/u);

  const jsonError = await fetch(`${gateway.url}/v1/messages`, {
    method: 'POST',
    headers: gatewayHeaders(),
    body: JSON.stringify({
      model: TEST_MODEL,
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { test_case: 'json-error' },
      max_tokens: 16,
      stream: true,
    }),
  });
  assert.equal(jsonError.status, 429);
  assert.equal(jsonError.headers.get('retry-after'), '3');
  assert.match(jsonError.headers.get('content-type') || '', /^application\/json/iu);
  const jsonErrorText = await jsonError.text();
  assert.doesNotMatch(jsonErrorText, /event: ping/u);
  assert.deepEqual(JSON.parse(jsonErrorText), {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'slow down' },
  });

  const truncatedBody = JSON.stringify({
    model: TEST_MODEL,
    messages: [{ role: 'user', content: 'hello' }],
    metadata: { test_case: 'truncated-json' },
    max_tokens: 16,
    stream: true,
  });
  const truncated = await rawPost(
    `${gateway.url}/v1/messages`,
    {
      ...gatewayHeaders(),
      'content-length': Buffer.byteLength(truncatedBody),
    },
    truncatedBody
  );
  assert.equal(truncated.status, 502);
  assert.equal(truncated.aborted, true);
  assert.match(truncated.headers['content-type'] || '', /^application\/json/iu);
  assert.doesNotMatch(truncated.body, /event:\s*error|data:\s*\{/u);
});
