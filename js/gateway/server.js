import express from 'express';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import {
  estimateAnthropicInputTokens,
  formatAnthropicError,
  mapOpenAiFinishReason,
  translateAnthropicMessagesRequestWithOptions,
  translateOpenAiResponseToAnthropic,
} from './anthropic-format.js';
import { isGatewayLoopbackHost, loadGatewayConfig } from './config.js';
import { CodexSessionManager } from './codex-provider.js';
import { GatewayError, listGatewayModels, resolveModelRoute } from './model-routing.js';
import { proxyUrlForTarget } from './proxy.js';
import { createGatewayTracer } from './trace.js';

const proxyDispatchers = new Map();
const TOOL_REASONING_CACHE_MAX_ENTRIES = 2_048;

export function assertGatewayBindIsSafe(config) {
  const host = config.host || '127.0.0.1';
  if (isGatewayLoopbackHost(host) || config.sharedSecret) {
    return;
  }

  throw new GatewayError(
    500,
    'api_error',
    `Refusing to start unauthenticated gateway on non-loopback host ${host}. Set ULTRATHINK_GATEWAY_SHARED_SECRET or bind to 127.0.0.1.`
  );
}

function authHeaderSecret(req) {
  const authorization = req.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length);
  }

  const apiKey = req.get('x-api-key');
  if (typeof apiKey === 'string' && apiKey !== '') {
    return apiKey;
  }

  return '';
}

function requireGatewayAuth(config) {
  return function gatewayAuth(req, res, next) {
    if (!config.sharedSecret) {
      next();
      return;
    }

    if (authHeaderSecret(req) !== config.sharedSecret) {
      res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'invalid gateway credentials',
        },
      });
      return;
    }

    next();
  };
}

export function withAbortSignal(req, res, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = new GatewayError(
    504,
    'api_error',
    `gateway request timed out after ${timeoutMs}ms`
  );
  const clientAbortError = new GatewayError(
    499,
    'api_error',
    'gateway request aborted by the client before completion'
  );

  function abortOnce(reason) {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  }

  const timer = setTimeout(function abortOnTimeout() {
    abortOnce(timeoutError);
  }, timeoutMs);
  timer.unref?.();

  controller.signal.addEventListener(
    'abort',
    function clearAbortTimer() {
      clearTimeout(timer);
    },
    { once: true }
  );
  req.on('aborted', function abortOnAbort() {
    abortOnce(clientAbortError);
  });
  res.on('close', function abortOnClose() {
    if (!res.writableEnded) {
      abortOnce(clientAbortError);
    }
  });
  res.on('finish', function clearOnFinish() {
    clearTimeout(timer);
  });
  return controller.signal;
}

function upstreamHeaders(headers = {}) {
  return {
    'content-type': 'application/json',
    ...headers,
  };
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function postJson(url, headers, body, signal) {
  try {
    return await undiciFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      dispatcher: fetchDispatcherForUrl(url),
    });
  } catch (error) {
    if (signal?.aborted && signal.reason instanceof GatewayError) {
      throw signal.reason;
    }
    throw error;
  }
}

function normalizeAbortError(error, signal) {
  if (signal?.aborted && signal.reason instanceof GatewayError) {
    return signal.reason;
  }

  return error;
}

function gatewayUrl(baseUrl, relativePath) {
  const base = String(baseUrl || '').endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath.replace(/^\/+/u, ''), base);
}

function fetchDispatcherForUrl(url) {
  const proxyUrl = proxyUrlForTarget(url);
  if (!proxyUrl) {
    return undefined;
  }

  const dispatcherUrl = normalizeProxyDispatcherUrl(proxyUrl);
  if (!proxyDispatchers.has(dispatcherUrl)) {
    proxyDispatchers.set(dispatcherUrl, new ProxyAgent(dispatcherUrl));
  }

  return proxyDispatchers.get(dispatcherUrl);
}

function normalizeProxyDispatcherUrl(proxyUrl) {
  let parsed = null;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new GatewayError(
      502,
      'api_error',
      'Invalid proxy URL configured for gateway upstream requests'
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GatewayError(
      502,
      'api_error',
      `Unsupported proxy URL scheme "${parsed.protocol}" for gateway upstream requests; configure an http:// or https:// proxy URL.`
    );
  }

  return parsed.href;
}

function openAiCompatibleConfig(config, route) {
  if (route.provider === 'deepseek') {
    return config.deepseek;
  }

  return config.openai;
}

function createOpenAiCompatibleHeaders(config, route) {
  const providerConfig = openAiCompatibleConfig(config, route);
  return upstreamHeaders({
    authorization: `Bearer ${providerConfig.apiKey}`,
  });
}

function openAiCompatibleProviderLabel(route) {
  if (route.provider === 'deepseek') {
    return 'DeepSeek';
  }

  return 'OpenAI-compatible';
}

function toolReasoningCacheNamespace(req) {
  return [
    req.get('x-claude-code-session-id') || 'global',
    req.get('x-claude-code-agent-id') || '',
    req.get('x-claude-code-parent-agent-id') || '',
  ].join('\x1f');
}

function rememberToolCallReasoning(cache, key, reasoningContent) {
  if (!key || typeof reasoningContent !== 'string' || reasoningContent === '') {
    return;
  }

  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, reasoningContent);

  while (cache.size > TOOL_REASONING_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function openAiCompatibleTranslationOptions(req, route, toolReasoningCache) {
  if (route.provider !== 'deepseek') {
    return {};
  }

  const cacheNamespace = toolReasoningCacheNamespace(req);
  function cacheKey(toolCallId) {
    return `${cacheNamespace}\x1f${toolCallId}`;
  }

  return {
    preserveAssistantThinking: true,
    reasoningContentForToolCall(toolCallId) {
      if (!toolCallId) {
        return '';
      }
      return toolReasoningCache.get(cacheKey(toolCallId)) || '';
    },
    recordToolCallReasoning(toolCallId, reasoningContent) {
      if (!toolCallId) {
        return;
      }
      rememberToolCallReasoning(
        toolReasoningCache,
        cacheKey(toolCallId),
        reasoningContent
      );
    },
  };
}

function matchesGatewaySharedSecret(value, config) {
  return Boolean(config.sharedSecret) && value === config.sharedSecret;
}

function forwardedAnthropicCredential(req, config) {
  const authorization = req.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    const bearerToken = authorization.slice('Bearer '.length);
    if (!matchesGatewaySharedSecret(bearerToken, config)) {
      return {
        headerName: 'authorization',
        headerValue: authorization,
      };
    }
  }

  const apiKey = req.get('x-api-key');
  if (
    typeof apiKey === 'string' &&
    apiKey !== '' &&
    !matchesGatewaySharedSecret(apiKey, config)
  ) {
    return {
      headerName: 'x-api-key',
      headerValue: apiKey,
    };
  }

  return null;
}

function createAnthropicHeaders(config, req) {
  const headers = upstreamHeaders({
    'anthropic-version': req.get('anthropic-version') || config.anthropic.version,
  });

  const forwardedCredential = forwardedAnthropicCredential(req, config);
  if (forwardedCredential) {
    headers[forwardedCredential.headerName] = forwardedCredential.headerValue;
  } else if (config.anthropic.apiKey) {
    headers['x-api-key'] = config.anthropic.apiKey;
  } else {
    throw new GatewayError(
      401,
      'authentication_error',
      'Anthropic passthrough requires inbound Claude credentials or ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY'
    );
  }

  const anthropicBeta = req.get('anthropic-beta');
  if (anthropicBeta) {
    headers['anthropic-beta'] = anthropicBeta;
  }

  return headers;
}

async function proxyAnthropicJson(req, res, config, route, signal) {
  const url = gatewayUrl(config.anthropic.baseUrl, 'v1/messages');
  const upstream = await postJson(
    url,
    createAnthropicHeaders(config, req),
    { ...req.body, model: route.upstreamModel },
    signal
  );

  const body = await safeJson(upstream);
  res.status(upstream.status).json(body);
}

async function proxyAnthropicStream(req, res, config, route, signal) {
  const url = gatewayUrl(config.anthropic.baseUrl, 'v1/messages');
  const upstream = await postJson(
    url,
    createAnthropicHeaders(config, req),
    { ...req.body, model: route.upstreamModel, stream: true },
    signal
  );

  res.status(upstream.status);
  res.setHeader(
    'content-type',
    upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8'
  );
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  if (!upstream.body) {
    res.end();
    return;
  }

  try {
    for await (const chunk of upstream.body) {
      await writeResponseChunk(res, chunk);
    }
  } catch (error) {
    throw normalizeAbortError(error, signal);
  }
  res.end();
}

async function writeResponseChunk(res, chunk) {
  if (res.destroyed) {
    throw new GatewayError(499, 'api_error', 'response stream closed before write completed');
  }

  if (res.write(chunk)) {
    return;
  }

  await new Promise(function waitForDrain(resolve, reject) {
    function cleanup() {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    }

    function onDrain() {
      cleanup();
      resolve();
    }

    function onClose() {
      cleanup();
      reject(new GatewayError(499, 'api_error', 'response stream closed before drain'));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

export async function writeSseEvent(res, event, data) {
  const eventLine = event ? `event: ${event}\n` : '';
  await writeResponseChunk(res, `${eventLine}data: ${JSON.stringify(data)}\n\n`);
}

async function writeSseErrorAndClose(res, errorBody) {
  try {
    await writeSseEvent(res, 'error', errorBody);
  } catch {
    // Best effort only; the socket may already be closing.
  }
  res.end();
}

function summarizeMessageRoles(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map(function pickRole(message) {
    return message?.role || 'unknown';
  });
}

function summarizeToolNames(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map(function pickToolName(tool) {
      return tool?.name || '';
    })
    .filter(Boolean);
}

function summarizeToolResults(messages) {
  if (!Array.isArray(messages)) {
    return {
      count: 0,
      ids: [],
    };
  }

  const toolResultIds = [];
  for (const message of messages) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
        toolResultIds.push(block.tool_use_id);
      }
    }
  }

  return {
    count: toolResultIds.length,
    ids: toolResultIds.slice(-16),
  };
}

export function summarizeRequestBody(requestBody) {
  const toolResults = summarizeToolResults(requestBody?.messages);
  return {
    model: requestBody?.model || null,
    stream: requestBody?.stream === true,
    max_tokens: requestBody?.max_tokens || null,
    message_count: Array.isArray(requestBody?.messages) ? requestBody.messages.length : 0,
    message_roles: summarizeMessageRoles(requestBody?.messages),
    tool_names: summarizeToolNames(requestBody?.tools),
    tool_result_count: toolResults.count,
    tool_result_ids: toolResults.ids,
    system_present: requestBody?.system !== undefined && requestBody?.system !== null,
  };
}

function summarizeRoute(route) {
  return {
    provider: route.provider,
    requested_model: route.requestedModel,
    upstream_model: route.upstreamModel,
    sandbox: route.sandbox || null,
    approval_policy: route.approvalPolicy || null,
    reasoning_effort: route.reasoningEffort || null,
    verbosity: route.verbosity || null,
  };
}

function routedResponseModel(route) {
  const effort = route.reasoningEffort ? `/${route.reasoningEffort}` : '';
  return `${route.provider}:${route.upstreamModel}${effort} via ${route.requestedModel}`;
}

function responseModelForRoute(config, route) {
  if (!config.displayRoutedModel || route.provider === 'anthropic') {
    return route.requestedModel;
  }

  return routedResponseModel(route);
}

function summarizeGatewayHeaders(req) {
  return {
    claude_session_id: req.get('x-claude-code-session-id') || null,
    claude_agent_id: req.get('x-claude-code-agent-id') || null,
    claude_parent_agent_id: req.get('x-claude-code-parent-agent-id') || null,
  };
}

export function summarizeGatewayTraceContext(req, route = null) {
  return {
    ...summarizeGatewayHeaders(req),
    provider: route?.provider || null,
    requested_model: route?.requestedModel || null,
    upstream_model: route?.upstreamModel || null,
    sandbox: route?.sandbox || null,
    approval_policy: route?.approvalPolicy || null,
  };
}

function summarizeError(error) {
  return {
    error_name: error?.name || null,
    error_message: error?.message || 'unknown error',
    gateway_error_type: error?.type || null,
    gateway_error_status: error?.status || null,
  };
}

function isClientAbortError(error) {
  return error instanceof GatewayError && error.status === 499;
}

function createStreamState(requestedModel, fallbackId) {
  return {
    messageId: fallbackId,
    requestedModel,
    messageStarted: false,
    textBlockStarted: false,
    textBlockIndex: 0,
    toolCalls: new Map(),
    reasoningContent: '',
    finishReason: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

async function ensureTextBlockStarted(res, state) {
  if (!state.messageStarted) {
    await writeSseEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: state.requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: state.usage,
      },
    });
    state.messageStarted = true;
  }

  if (state.textBlockStarted) {
    return;
  }

  await writeSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.textBlockIndex,
    content_block: {
      type: 'text',
      text: '',
    },
  });
  state.textBlockStarted = true;
}

function bufferToolCallDelta(toolCallDeltas, toolCalls) {
  for (const toolCall of toolCallDeltas) {
    const index = toolCall.index ?? 0;
    const existing = toolCalls.get(index) || {
      id: toolCall.id || '',
      name: '',
      arguments: '',
    };

    if (toolCall.id) {
      existing.id = toolCall.id;
    }
    if (toolCall.function?.name) {
      existing.name = toolCall.function.name;
    }
    if (toolCall.function?.arguments) {
      existing.arguments += toolCall.function.arguments;
    }

    toolCalls.set(index, existing);
  }
}

function recordStreamingToolCallReasoning(state, translationOptions) {
  if (!state.reasoningContent) {
    return;
  }

  for (const toolCall of state.toolCalls.values()) {
    translationOptions.recordToolCallReasoning?.(toolCall.id, state.reasoningContent);
  }
}

async function closeTextBlock(res, state) {
  if (!state.textBlockStarted) {
    return;
  }
  await writeSseEvent(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: state.textBlockIndex,
  });
  state.textBlockStarted = false;
  state.textBlockIndex += 1;
}

async function flushToolUses(res, state) {
  const sortedToolCalls = Array.from(state.toolCalls.entries()).sort(function sortByIndex(
    left,
    right
  ) {
    return left[0] - right[0];
  });

  for (const [index, toolCall] of sortedToolCalls) {
    let input = {};
    if (toolCall.arguments) {
      try {
        input = JSON.parse(toolCall.arguments);
      } catch (error) {
        throw new GatewayError(
          502,
          'api_error',
          `upstream returned invalid tool arguments for ${toolCall.name || toolCall.id || index}`
        );
      }
    }

    const contentIndex = state.textBlockIndex + index;
    const serializedInput = JSON.stringify(input);
    await writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: contentIndex,
      content_block: {
        type: 'tool_use',
        id: toolCall.id || `toolu_${index}`,
        name: toolCall.name || 'unknown_tool',
        input: {},
      },
    });
    await writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: contentIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: serializedInput,
      },
    });
    await writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: contentIndex,
    });
  }
}

async function streamOpenAiAsAnthropic(req, res, config, route, signal, toolReasoningCache) {
  const translationOptions = openAiCompatibleTranslationOptions(req, route, toolReasoningCache);
  const requestBody = translateAnthropicMessagesRequestWithOptions(
    req.body,
    route,
    translationOptions
  );
  const providerConfig = openAiCompatibleConfig(config, route);
  const url = gatewayUrl(providerConfig.baseUrl, 'chat/completions');
  const upstream = await postJson(
    url,
    createOpenAiCompatibleHeaders(config, route),
    requestBody,
    signal
  );

  if (!upstream.ok) {
    const body = await safeJson(upstream);
    res.status(upstream.status).json({
      type: 'error',
      error: {
        type: body?.error?.type || 'api_error',
        message:
          body?.error?.message ||
          `${openAiCompatibleProviderLabel(route)} upstream returned HTTP ${upstream.status}`,
      },
    });
    return;
  }

  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  const state = createStreamState(responseModelForRoute(config, route), `msg_${Date.now()}`);
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = events.pop() || '';

      for (const event of events) {
        const dataLines = event
          .split('\n')
          .filter(function pickData(line) {
            return line.startsWith('data: ');
          })
          .map(function stripPrefix(line) {
            return line.slice('data: '.length).replace(/\r$/u, '');
          });

        for (const dataLine of dataLines) {
          if (dataLine === '[DONE]') {
            await closeTextBlock(res, state);
            await ensureTextBlockStartedNoText(res, state);
            recordStreamingToolCallReasoning(state, translationOptions);
            await flushToolUses(res, state);
            await writeSseEvent(res, 'message_delta', {
              type: 'message_delta',
              delta: {
                stop_reason: mapOpenAiFinishReason(state.finishReason),
                stop_sequence: null,
              },
              usage: state.usage,
            });
            await writeSseEvent(res, 'message_stop', { type: 'message_stop' });
            res.end();
            return;
          }

          let payload = null;
          try {
            payload = JSON.parse(dataLine);
          } catch {
            continue;
          }
          if (!state.messageId && payload.id) {
            state.messageId = payload.id;
          }
          if (payload.usage) {
            state.usage = outputOnlyUsage({
              output_tokens: payload.usage.completion_tokens || 0,
            });
          }

          const choice = payload.choices?.[0];
          if (!choice) {
            continue;
          }
          if (choice.finish_reason) {
            state.finishReason = choice.finish_reason;
          }
          if (choice.delta?.reasoning_content) {
            state.reasoningContent += choice.delta.reasoning_content;
          }

          if (choice.delta?.content) {
            await ensureTextBlockStarted(res, state);
            await writeSseEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: state.textBlockIndex,
              delta: {
                type: 'text_delta',
                text: choice.delta.content,
              },
            });
          }

          if (Array.isArray(choice.delta?.tool_calls)) {
            await ensureTextBlockStartedNoText(res, state);
            bufferToolCallDelta(choice.delta.tool_calls, state.toolCalls);
          }
        }
      }
    }
  } catch (error) {
    throw normalizeAbortError(error, signal);
  }

  await closeTextBlock(res, state);
  await ensureTextBlockStartedNoText(res, state);
  recordStreamingToolCallReasoning(state, translationOptions);
  await flushToolUses(res, state);
  await writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: mapOpenAiFinishReason(state.finishReason),
      stop_sequence: null,
    },
    usage: state.usage,
  });
  await writeSseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function ensureTextBlockStartedNoText(res, state) {
  if (state.messageStarted) {
    return;
  }

  await writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: state.requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: state.usage,
    },
  });
  state.messageStarted = true;
}

function codexOutcomeTextBlocks(text) {
  if (typeof text !== 'string' || text === '') {
    return [];
  }

  return [
    {
      type: 'text',
      text,
    },
  ];
}

function normalizeCodexUsage(usage) {
  const nextUsage = usage || {
    input_tokens: 0,
    output_tokens: 0,
  };
  const normalized = {
    input_tokens: nextUsage.input_tokens || 0,
    output_tokens: nextUsage.output_tokens || 0,
  };

  if (Number(nextUsage.cache_read_input_tokens) > 0) {
    normalized.cache_read_input_tokens = nextUsage.cache_read_input_tokens;
  }

  return normalized;
}

function usageValue(usage, key) {
  return usage?.[key] || 0;
}

function sameUsage(left, right) {
  return (
    usageValue(left, 'input_tokens') === usageValue(right, 'input_tokens') &&
    usageValue(left, 'output_tokens') === usageValue(right, 'output_tokens') &&
    usageValue(left, 'cache_read_input_tokens') ===
      usageValue(right, 'cache_read_input_tokens')
  );
}

function outputOnlyUsage(usage) {
  return {
    input_tokens: 0,
    output_tokens: usage?.output_tokens || 0,
  };
}

function codexOutcomeToAnthropic(outcome, requestedModel) {
  const content = [...codexOutcomeTextBlocks(outcome.text)];
  if (outcome.type === 'tool_use') {
    content.push({
      type: 'tool_use',
      id: outcome.toolCall.id,
      name: outcome.toolCall.name,
      input: outcome.toolCall.input || {},
    });
  }

  return {
    id: outcome.toolCall?.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: outcome.type === 'tool_use' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: normalizeCodexUsage(outcome.usage),
  };
}

function streamCodexResponse(
  req,
  res,
  signal,
  requestedModel,
  codexSessions,
  route,
  requestTracer
) {
  const state = createStreamState(requestedModel, `msg_${Date.now()}`);
  let emittedUsage = null;
  let closed = false;
  let eventFailure = null;
  let eventChain = Promise.resolve();
  let notifyEventFailure = null;
  const eventFailureReady = new Promise(function waitForEventFailure(resolve) {
    notifyEventFailure = resolve;
  });
  const heartbeat = setInterval(function emitPing() {
    if (closed) {
      return;
    }
    void writeSseEvent(res, 'ping', { type: 'ping' }).catch(function stopOnPingFailure() {
      closed = true;
      stopHeartbeat();
    });
  }, 10_000);
  heartbeat.unref?.();

  function stopHeartbeat() {
    clearInterval(heartbeat);
  }

  if (signal) {
    signal.addEventListener(
      'abort',
      function markClosed() {
        closed = true;
        stopHeartbeat();
      },
      { once: true }
    );
  }

  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.on('close', stopHeartbeat);
  res.on('finish', stopHeartbeat);

  async function writeUsageDelta(usage, stopReason = null) {
    if (closed) {
      return;
    }

    state.usage = normalizeCodexUsage(usage);
    const unchanged = emittedUsage && sameUsage(emittedUsage, state.usage);
    if (stopReason === null && unchanged) {
      return;
    }

    emittedUsage = state.usage;
    await ensureTextBlockStartedNoText(res, state);
    await writeSseEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: state.usage,
    });
  }

  async function writeToolUse(toolCall, usage) {
    if (closed) {
      return;
    }

    state.usage = normalizeCodexUsage(usage);
    await closeTextBlock(res, state);
    await ensureTextBlockStartedNoText(res, state);
    const toolBlockIndex = state.textBlockIndex;
    await writeSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: toolBlockIndex,
      content_block: {
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: {},
      },
    });
    await writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: toolBlockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(toolCall.input || {}),
      },
    });
    await writeSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: toolBlockIndex,
    });
    await writeUsageDelta(usage, 'tool_use');
    await writeSseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
    closed = true;
    stopHeartbeat();
  }

  async function writeFinal(usage) {
    if (closed) {
      return;
    }

    state.usage = normalizeCodexUsage(usage);
    await closeTextBlock(res, state);
    await ensureTextBlockStartedNoText(res, state);
    await writeUsageDelta(usage, 'end_turn');
    await writeSseEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
    closed = true;
    stopHeartbeat();
  }

  async function handleCodexEvent(event) {
    if (closed) {
      return;
    }

    if (event.type === 'text_delta') {
      await ensureTextBlockStarted(res, state);
      await writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.textBlockIndex,
        delta: {
          type: 'text_delta',
          text: event.text,
        },
      });
      return;
    }

    if (event.type === 'usage') {
      await writeUsageDelta(event.usage, null);
      return;
    }

    if (event.type !== 'boundary') {
      return;
    }

    if (event.outcome.type === 'tool_use') {
      await writeToolUse(event.outcome.toolCall, event.outcome.usage);
      return;
    }

    await writeFinal(event.outcome.usage);
  }

  function recordEventFailure(error) {
    if (eventFailure) {
      return;
    }

    eventFailure = error;
    notifyEventFailure();
  }

  function enqueueCodexEvent(event) {
    const queued = eventChain.then(async function writeQueuedCodexEvent() {
      if (eventFailure) {
        return undefined;
      }

      return handleCodexEvent(event);
    });
    queued.catch(recordEventFailure);
    eventChain = queued.catch(function keepEventQueueSettled() {
      return undefined;
    });
    return queued;
  }

  async function flushCodexEvents() {
    await eventChain;
  }

  const streamResult = codexSessions
    .streamRequest(req, req.body, route, enqueueCodexEvent, requestTracer)
    .then(
      function streamSucceeded(value) {
        return { type: 'success', value };
      },
      function streamFailed(error) {
        return { type: 'failure', error };
      }
    );

  return Promise.race([
    streamResult,
    eventFailureReady.then(function eventWriteFailed() {
      return { type: 'event_failure' };
    }),
  ])
    .then(async function flushAndReturn(result) {
      await flushCodexEvents();
      if (eventFailure) {
        throw eventFailure;
      }
      if (result.type === 'failure') {
        throw result.error;
      }
      return result.value;
    })
    .finally(stopHeartbeat);
}

async function handleOpenAiJson(req, res, config, route, signal, toolReasoningCache) {
  const translationOptions = openAiCompatibleTranslationOptions(req, route, toolReasoningCache);
  const requestBody = translateAnthropicMessagesRequestWithOptions(
    req.body,
    route,
    translationOptions
  );
  const providerConfig = openAiCompatibleConfig(config, route);
  const url = gatewayUrl(providerConfig.baseUrl, 'chat/completions');
  const upstream = await postJson(
    url,
    createOpenAiCompatibleHeaders(config, route),
    requestBody,
    signal
  );
  const body = await safeJson(upstream);

  if (!upstream.ok) {
    res.status(upstream.status).json({
      type: 'error',
      error: {
        type: body?.error?.type || 'api_error',
        message:
          body?.error?.message ||
          `${openAiCompatibleProviderLabel(route)} upstream returned HTTP ${upstream.status}`,
      },
    });
    return;
  }

  res.json(translateOpenAiResponseToAnthropic(
    body,
    responseModelForRoute(config, route),
    body?.id,
    translationOptions
  ));
}

async function handleCodexJson(req, res, config, codexSessions, route, requestTracer) {
  const outcome = await codexSessions.processRequest(req, req.body, route, requestTracer);
  res.json(codexOutcomeToAnthropic(outcome, responseModelForRoute(config, route)));
}

async function handleCodexStream(req, res, config, codexSessions, route, signal, requestTracer) {
  await streamCodexResponse(
    req,
    res,
    signal,
    responseModelForRoute(config, route),
    codexSessions,
    route,
    requestTracer
  );
}

async function handleCountTokens(req, res, config, signal) {
  const route = resolveModelRoute(req.body?.model, config);
  switch (route.provider) {
    case 'anthropic': {
      const url = gatewayUrl(config.anthropic.baseUrl, 'v1/messages/count_tokens');
      const upstream = await postJson(
        url,
        createAnthropicHeaders(config, req),
        { ...req.body, model: route.upstreamModel },
        signal
      );
      const body = await safeJson(upstream);
      res.status(upstream.status).json(body);
      return;
    }
    case 'codex':
    case 'deepseek':
    case 'openai':
      res.json({
        input_tokens: estimateAnthropicInputTokens(req.body),
      });
      return;
    default:
      throw new GatewayError(500, 'api_error', `Unsupported gateway provider: ${route.provider}`);
  }
}

async function handleMessages(
  req,
  res,
  config,
  codexSessions,
  route,
  requestTracer,
  toolReasoningCache
) {
  const signal = withAbortSignal(req, res, config.requestTimeoutMs);
  req.abortSignal = signal;
  req.gatewayTracer = requestTracer;

  switch (route.provider) {
    case 'anthropic':
      if (req.body?.stream === true) {
        await proxyAnthropicStream(req, res, config, route, signal);
        return route;
      }
      await proxyAnthropicJson(req, res, config, route, signal);
      return route;
    case 'codex':
      if (!codexSessions) {
        throw new GatewayError(500, 'api_error', 'Codex session manager is not available');
      }

      if (req.body?.stream === true) {
        await handleCodexStream(req, res, config, codexSessions, route, signal, requestTracer);
        return route;
      }

      await handleCodexJson(req, res, config, codexSessions, route, requestTracer);
      return route;
    case 'deepseek':
    case 'openai':
      if (req.body?.stream === true) {
        await streamOpenAiAsAnthropic(req, res, config, route, signal, toolReasoningCache);
        return route;
      }
      await handleOpenAiJson(req, res, config, route, signal, toolReasoningCache);
      return route;
    default:
      throw new GatewayError(500, 'api_error', `Unsupported gateway provider: ${route.provider}`);
  }
}

export function createGatewayApp(config = loadGatewayConfig(), codexSessions = null, tracer = null) {
  assertGatewayBindIsSafe(config);
  const app = express();
  const toolReasoningCache = new Map();

  app.get('/healthz', function healthz(req, res) {
    res.json({
      ok: true,
      service: 'claude-workflow-gateway',
      codex_target_model: config.codex?.model || null,
      codex_sandbox: config.codex?.sandbox || null,
      codex_approval_policy: config.codex?.approvalPolicy || null,
      codex_reasoning_effort: config.codex?.reasoningEffort || null,
      codex_verbosity: config.codex?.verbosity || null,
      codex_enabled: Boolean(config.codex?.enabled),
      openai_model: config.openai?.model || null,
      openai_reasoning_effort: config.openai?.reasoningEffort || null,
      deepseek_model: config.deepseek?.model || null,
      deepseek_reasoning_effort: config.deepseek?.reasoningEffort || null,
      deepseek_thinking: config.deepseek?.thinking?.type || null,
      anthropic_passthrough_enabled: true,
      anthropic_passthrough_models: config.anthropicPassthroughModels || [],
      exposed_models: config.exposedModels || [],
      display_routed_model: Boolean(config.displayRoutedModel),
    });
  });

  app.use('/v1', requireGatewayAuth(config));
  app.use('/v1', express.json({ limit: '20mb' }));
  app.use('/v1', function jsonBodyErrorHandler(error, req, res, next) {
    if (!error) {
      next();
      return;
    }

    const formatted = formatAnthropicError(
      new GatewayError(400, 'invalid_request_error', error.message || 'invalid JSON body')
    );
    res.status(formatted.status).json(formatted.body);
  });

  app.get('/v1/models', function listModels(req, res) {
    res.json({
      object: 'list',
      data: listGatewayModels(config),
    });
  });

  app.post('/v1/messages/count_tokens', async function countTokens(req, res) {
    try {
      await handleCountTokens(
        req,
        res,
        config,
        withAbortSignal(req, res, config.requestTimeoutMs)
      );
    } catch (error) {
      const formatted = formatAnthropicError(error);
      res.status(formatted.status).json(formatted.body);
    }
  });

  app.post('/v1/messages', async function messages(req, res) {
    const requestTracer =
      tracer?.scope?.({
        request_id: tracer.createId?.() || `${Date.now()}`,
      }) || null;

    requestTracer?.log?.('gateway.request.received', {
      headers: summarizeGatewayHeaders(req),
      request: summarizeRequestBody(req.body),
    });

    let route = null;

    try {
      route = resolveModelRoute(req.body?.model, config);
      requestTracer?.log?.('gateway.route.resolved', {
        ...summarizeGatewayTraceContext(req, route),
        route: summarizeRoute(route),
        response_model: responseModelForRoute(config, route),
      });

      await handleMessages(
        req,
        res,
        config,
        codexSessions,
        route,
        requestTracer,
        toolReasoningCache
      );
      requestTracer?.log?.('gateway.request.completed', {
        ...summarizeGatewayTraceContext(req, route),
        status_code: res.statusCode,
        headers_sent: res.headersSent,
        finished: res.writableEnded,
      });
    } catch (error) {
      requestTracer?.log?.(
        isClientAbortError(error) ? 'gateway.request.aborted' : 'gateway.request.failed',
        {
          ...summarizeGatewayTraceContext(req, route),
          ...summarizeError(error),
        }
      );

      if (isClientAbortError(error) && (req.destroyed || res.destroyed)) {
        return;
      }

      const formatted = formatAnthropicError(error);
      if (!res.headersSent) {
        res.status(formatted.status).json(formatted.body);
        return;
      }
      if (req.body?.stream === true) {
        await writeSseErrorAndClose(res, formatted.body);
        return;
      }
      res.end();
    }
  });

  return app;
}

export function createGatewayServer(config = loadGatewayConfig()) {
  const tracer = createGatewayTracer(config);
  const codexSessions = new CodexSessionManager(config, { tracer });
  const app = createGatewayApp(config, codexSessions, tracer);
  const server = app.listen(config.port, config.host);
  let closePromise = null;

  return {
    app,
    server,
    config,
    tracer,
    async close() {
      if (closePromise) {
        return closePromise;
      }

      closePromise = (async function closeRuntime() {
        let closeError = null;
        try {
          await new Promise(function stopListening(resolve, reject) {
            try {
              server.close(function onClose(error) {
                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
                  reject(error);
                  return;
                }
                resolve();
              });
              server.closeAllConnections?.();
            } catch (error) {
              if (error?.code === 'ERR_SERVER_NOT_RUNNING') {
                resolve();
                return;
              }
              reject(error);
            }
          });
        } catch (error) {
          closeError = error;
        } finally {
          await Promise.allSettled([codexSessions.close(), tracer.close()]);
        }

        if (closeError) {
          throw closeError;
        }
      })();

      return closePromise;
    },
  };
}
