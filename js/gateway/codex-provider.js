import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { GatewayError } from './model-routing.js';

const DEFAULT_CLOSE_KILL_TIMEOUT_MS = 2_000;
const DEFAULT_FORK_IDLE_TIMEOUT_MS = 30_000;
// Cold-start bound only: once the Codex app-server reports the model's real
// context window (thread/tokenUsage/updated), budgets adapt to it. Codex
// gpt-5.5 reports a 258,400-token window with ~10k tokens of baseline
// thread overhead, so keep the pre-learning default safely below that.
const DEFAULT_INPUT_MAX_TOKENS = 192_000;
// Fraction of the reported context window usable as input budget; the rest
// is headroom for the model's reasoning and output.
const CODEX_WINDOW_INPUT_FRACTION = 0.8;
const DEFAULT_MAX_SESSIONS = 16;
const SUPPORTS_PROCESS_GROUP_SIGNALS = process.platform !== 'win32';
const INPUT_TRUNCATION_NOTICE = '[content omitted to fit Codex context budget]';
const TRANSCRIPT_OMISSION_NOTICE = '[older transcript omitted to fit Codex context budget]';
const NON_RESERVING_SELECTION_REASONS = new Set([
  'matching_tool_result',
  'boundary_replay',
  'routing_reservation_replay',
]);
// Selection reasons under which a between-turns session may be recycled for
// context pressure; replay-style selections must keep their session intact.
const RECYCLE_ELIGIBLE_SELECTION_REASONS = new Set(['canonical', 'matching_tool_result']);
const CODEX_APP_SERVER_FATAL_STDERR_PATTERNS = [
  /remote app server .*transport failed/iu,
  /WebSocket protocol error: Connection reset without closing handshake/iu,
];
const CODEX_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
// Recycle a live Codex session before its real context (as reported by the
// app-server) can overflow the model window: long tool loops accumulate
// history turn by turn, so per-payload budgets alone cannot bound the sum.
// The threshold is a fraction of the model window itself; bootstrap replays
// are capped strictly below it (see bootstrapInputMaxTokens) so a freshly
// recycled session can never immediately re-trigger recycling.
const CODEX_SESSION_RECYCLE_FRACTION = 0.75;
const CODEX_BOOTSTRAP_RECYCLE_HEADROOM = 0.9;
// Code-heavy content tokenizes near 3 chars/token, not the prose-like 4.
// Undershooting chars-per-token overflows the upstream window (fatal);
// overshooting only truncates earlier, so estimate conservatively everywhere
// budgets and recycle projections are computed.
const ESTIMATE_CHARS_PER_TOKEN = 3;
const CODEX_CONTEXT_WINDOW_ERROR_PATTERN =
  /context window|context length|maximum context|too many tokens|ran out of room|clear earlier history/iu;
const CODEX_CONTEXT_WINDOW_DRIFT_PATTERN =
  /token|history|context|window|room|compact|truncate|too large|too long|exceed/iu;

function noop() {}

function signalChildProcessTree(child, signal) {
  if (!child) {
    return false;
  }

  let signaled = false;
  if (SUPPORTS_PROCESS_GROUP_SIGNALS && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      signaled = true;
    } catch {
      // Fall back to the direct child for launchers that are not process-group leaders.
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return signaled;
  }

  try {
    return child.kill(signal) || signaled;
  } catch {
    return signaled;
  }
}

function childProcessTreeExists(child) {
  if (!child) {
    return false;
  }

  if (SUPPORTS_PROCESS_GROUP_SIGNALS && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  return child.exitCode === null && child.signalCode === null;
}

function numberOrDefault(value, defaultValue) {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  if (typeof value === 'string' && value.trim() === '') {
    return defaultValue;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : defaultValue;
}

function joinTextParts(parts) {
  if (parts.length === 0) {
    return '';
  }
  return parts.join('\n\n');
}

function normalizeContentBlocks(content, label) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (Array.isArray(content)) {
    return content;
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `${label} must be a string or an array of content blocks`
  );
}

function renderTextBlocks(blocks, label) {
  const parts = [];

  for (const block of normalizeContentBlocks(blocks, label)) {
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported ${label} content block type: ${String(block?.type)}`
      );
    }
    parts.push(block.text || '');
  }

  return joinTextParts(parts);
}

function renderSystemPrompt(requestBody) {
  const parts = [];

  if (requestBody.system !== undefined && requestBody.system !== null) {
    parts.push(renderTextBlocks(requestBody.system, 'system'));
  }

  for (const message of requestBody.messages || []) {
    if (message?.role !== 'system') {
      continue;
    }
    parts.push(renderTextBlocks(message.content, 'system'));
  }

  return parts.filter(Boolean).join('\n\n');
}

function toolSchemaSignature(tools) {
  return JSON.stringify(Array.isArray(tools) ? tools : []);
}

function defaultToolInputSchema() {
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function normalizeToolInputSchema(tool) {
  if (tool?.input_schema && typeof tool.input_schema === 'object') {
    return tool.input_schema;
  }
  return defaultToolInputSchema();
}

export function buildCodexDynamicToolRegistry(tools) {
  const originalTools = Array.isArray(tools) ? tools : [];
  const byInternalName = new Map();
  const dynamicTools = originalTools.map(function mapTool(tool, index) {
    const internalName = `ext_tool_${String(index + 1).padStart(3, '0')}`;
    const record = {
      internalName,
      originalName: tool.name,
      description: tool.description || '',
      inputSchema: normalizeToolInputSchema(tool),
    };

    byInternalName.set(internalName, record);

    return {
      name: internalName,
      description: tool.description || tool.name || internalName,
      inputSchema: record.inputSchema,
    };
  });

  return {
    dynamicTools,
    byInternalName,
  };
}

function selectCodexTools(tools, toolChoice) {
  const originalTools = Array.isArray(tools) ? tools : [];
  if (toolChoice === undefined || toolChoice === null) {
    return originalTools;
  }

  if (typeof toolChoice !== 'object') {
    throw new GatewayError(400, 'invalid_request_error', 'tool_choice must be an object when provided');
  }

  switch (toolChoice.type) {
    case 'auto':
    case 'any':
      return originalTools;
    case 'none':
      return [];
    case 'tool': {
      if (typeof toolChoice.name !== 'string') {
        break;
      }

      const selectedTool = originalTools.find(function findTool(tool) {
        return tool?.name === toolChoice.name;
      });
      if (!selectedTool) {
        throw new GatewayError(
          400,
          'invalid_request_error',
          `tool_choice selected unknown tool ${toolChoice.name}`
        );
      }
      return [selectedTool];
    }
    default:
      break;
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `unsupported tool_choice type: ${String(toolChoice.type)}`
  );
}

function effectiveCodexTools(requestBody) {
  return selectCodexTools(requestBody?.tools, requestBody?.tool_choice);
}

function effectiveToolSchemaSignature(requestBody) {
  return toolSchemaSignature(effectiveCodexTools(requestBody));
}

function originalToolName(registry, internalName) {
  return registry.byInternalName.get(internalName)?.originalName || internalName;
}

function requestFingerprint(requestBody) {
  return shortHash(
    JSON.stringify({
      model: requestBody?.model || null,
      system: requestBody?.system || null,
      messages: requestBody?.messages || [],
      tools: requestBody?.tools || [],
      tool_choice: requestBody?.tool_choice || null,
      thinking: requestBody?.thinking || null,
      output_config: requestBody?.output_config || null,
      max_tokens: requestBody?.max_tokens || null,
    })
  );
}

function usageField(source, camelKey, snakeKey) {
  const value = Number(source?.[camelKey] ?? source?.[snakeKey] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function addPositiveUsageField(usage, key, value) {
  if (value > 0) {
    usage[key] = value;
  }
}

function normalizeUsageBreakdown(source) {
  const inputTokens = usageField(source, 'inputTokens', 'input_tokens');
  const cachedInputTokens = usageField(source, 'cachedInputTokens', 'cached_input_tokens');
  const outputTokens = usageField(source, 'outputTokens', 'output_tokens');
  const reasoningOutputTokens = usageField(
    source,
    'reasoningOutputTokens',
    'reasoning_output_tokens'
  );
  const totalTokens = usageField(source, 'totalTokens', 'total_tokens');
  const normalized = {
    input_tokens: Math.max(0, inputTokens - cachedInputTokens),
    output_tokens: outputTokens + reasoningOutputTokens,
  };

  addPositiveUsageField(normalized, 'cache_read_input_tokens', cachedInputTokens);
  addPositiveUsageField(normalized, 'reasoning_output_tokens', reasoningOutputTokens);
  addPositiveUsageField(normalized, 'total_tokens', totalTokens);

  return normalized;
}

function normalizeCodexTokenUsage(tokenUsage) {
  const total = tokenUsage?.total ? normalizeUsageBreakdown(tokenUsage.total) : null;
  const last = tokenUsage?.last ? normalizeUsageBreakdown(tokenUsage.last) : null;
  return {
    total,
    last,
    model_context_window: tokenUsage?.modelContextWindow || null,
  };
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
  };
}

function usageNumber(usage, key) {
  const value = Number(usage?.[key] || 0);
  return Number.isFinite(value) ? value : 0;
}

function contextTokensFromUsage(usage) {
  if (!usage) {
    return 0;
  }

  // Prefer the app-server's own total for the turn; fall back to summing the
  // components (input + cached input is the full context the model was fed,
  // output approximates the thread context after the turn).
  const total = usageNumber(usage, 'total_tokens');
  if (total > 0) {
    return total;
  }

  return (
    usageNumber(usage, 'input_tokens') +
    usageNumber(usage, 'cache_read_input_tokens') +
    usageNumber(usage, 'output_tokens')
  );
}

function estimateIncomingRequestTokens(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const latest = messages.at(-1);
  if (!latest) {
    return 0;
  }

  try {
    return estimateTokensFromJson(latest.content ?? '');
  } catch {
    return 0;
  }
}

function codexRecycleContextLimit(config, contextWindow) {
  const window = Number(contextWindow || 0);
  const base = window > 0 ? window : codexInputMaxTokens(config);
  if (!Number.isFinite(base)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor(base * CODEX_SESSION_RECYCLE_FRACTION);
}

function usageDelta(current, baseline) {
  // Codex app-server totals are expected to be monotonic; clamp anyway so compaction
  // or replay quirks cannot surface negative Anthropic usage.
  const inputTokens = Math.max(
    0,
    usageNumber(current, 'input_tokens') - usageNumber(baseline, 'input_tokens')
  );
  const outputTokens = Math.max(
    0,
    usageNumber(current, 'output_tokens') - usageNumber(baseline, 'output_tokens')
  );
  const delta = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };

  const cacheReadInputTokens = Math.max(
    0,
    usageNumber(current, 'cache_read_input_tokens') -
      usageNumber(baseline, 'cache_read_input_tokens')
  );
  addPositiveUsageField(delta, 'cache_read_input_tokens', cacheReadInputTokens);

  const reasoningOutputTokens = Math.max(
    0,
    usageNumber(current, 'reasoning_output_tokens') -
      usageNumber(baseline, 'reasoning_output_tokens')
  );
  addPositiveUsageField(delta, 'reasoning_output_tokens', reasoningOutputTokens);

  const totalTokens = Math.max(
    0,
    usageNumber(current, 'total_tokens') - usageNumber(baseline, 'total_tokens')
  );
  addPositiveUsageField(delta, 'total_tokens', totalTokens);

  return delta;
}

function addUsage(left, right) {
  const inputTokens = usageNumber(left, 'input_tokens') + usageNumber(right, 'input_tokens');
  const outputTokens = usageNumber(left, 'output_tokens') + usageNumber(right, 'output_tokens');
  const total = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };

  const cacheReadInputTokens =
    usageNumber(left, 'cache_read_input_tokens') +
    usageNumber(right, 'cache_read_input_tokens');
  addPositiveUsageField(total, 'cache_read_input_tokens', cacheReadInputTokens);

  const reasoningOutputTokens =
    usageNumber(left, 'reasoning_output_tokens') +
    usageNumber(right, 'reasoning_output_tokens');
  addPositiveUsageField(total, 'reasoning_output_tokens', reasoningOutputTokens);

  const totalTokens = usageNumber(left, 'total_tokens') + usageNumber(right, 'total_tokens');
  addPositiveUsageField(total, 'total_tokens', totalTokens);

  return total;
}

function estimateTokensFromJson(value) {
  return estimateTokensFromText(JSON.stringify(value));
}

function estimateTokensFromText(text) {
  return Math.max(1, Math.ceil(String(text || '').length / ESTIMATE_CHARS_PER_TOKEN));
}

function maxCharsForTokenBudget(maxTokens) {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(1, Math.floor(maxTokens * ESTIMATE_CHARS_PER_TOKEN));
}

function limitTextByTokenBudget(text, maxTokens) {
  const value = String(text || '');
  const maxChars = maxCharsForTokenBudget(maxTokens);
  if (!Number.isFinite(maxChars) || value.length <= maxChars) {
    return value;
  }

  const marker = `\n\n${INPUT_TRUNCATION_NOTICE}\n\n`;
  if (marker.length >= maxChars) {
    return value.slice(-maxChars);
  }

  const remainingChars = maxChars - marker.length;
  const headChars = Math.ceil(remainingChars / 2);
  const tailChars = Math.floor(remainingChars / 2);
  return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
}

function codexInputMaxTokens(config) {
  const maxTokens = numberOrDefault(config?.codex?.inputMaxTokens, DEFAULT_INPUT_MAX_TOKENS);
  if (maxTokens <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(1, Math.trunc(maxTokens));
}

function effectiveCodexInputMaxTokens(config, contextWindow) {
  const configured = codexInputMaxTokens(config);
  const window = Number(contextWindow || 0);
  if (window <= 0) {
    return configured;
  }

  const fromWindow = Math.max(1, Math.floor(window * CODEX_WINDOW_INPUT_FRACTION));
  return Math.min(configured, fromWindow);
}

function populateEstimatedUsage(boundary, requestBody, outcome) {
  if ((boundary.usage.output_tokens || 0) > 0) {
    return;
  }

  const outputEstimateParts = [boundary.text || ''];
  if (outcome.type === 'tool_use' && outcome.toolCall) {
    outputEstimateParts.push(outcome.toolCall.name || '');
    outputEstimateParts.push(JSON.stringify(outcome.toolCall.input || {}));
  }

  boundary.usage = {
    input_tokens: Math.max(
      boundary.usage.input_tokens || 0,
      estimateTokensFromJson({
        system: requestBody?.system || null,
        messages: requestBody?.messages || [],
        tools: requestBody?.tools || [],
        tool_choice: requestBody?.tool_choice || null,
      })
    ),
    output_tokens: Math.max(
      boundary.usage.output_tokens || 0,
      estimateTokensFromText(outputEstimateParts.join('\n'))
    ),
  };
}

function hasMatchingToolResult(requestBody, pendingToolCall) {
  if (!pendingToolCall) {
    return false;
  }

  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== 'user') {
      continue;
    }

    for (const block of normalizeContentBlocks(message.content, 'tool_result message')) {
      if (block?.type === 'tool_result' && block.tool_use_id === pendingToolCall.callId) {
        return true;
      }
    }
  }

  return false;
}

function createBoundary(turnId, requestBody, usageBaseline = emptyUsage()) {
  const listeners = new Set();
  const boundary = {
    turnId,
    requestFingerprint: requestFingerprint(requestBody),
    events: [],
    text: '',
    usage: emptyUsage(),
    usageBaseline: {
      ...emptyUsage(),
      ...(usageBaseline || {}),
    },
    deltaItemIds: new Set(),
    finished: false,
    outcome: null,
    error: null,
    done: null,
    emit(event) {
      boundary.events.push(event);
      for (const listener of listeners) {
        listener(event);
      }
    },
    addListener(listener) {
      for (const event of boundary.events) {
        listener(event);
      }
      if (boundary.finished) {
        return function noop() {};
      }

      listeners.add(listener);
      return function removeListener() {
        listeners.delete(listener);
      };
    },
  };

  boundary.done = new Promise(function assignCompletion(resolve, reject) {
    boundary.resolve = resolve;
    boundary.reject = reject;
  });

  return boundary;
}

function extractLatestUserText(requestBody) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }

    const textParts = [];
    for (const block of normalizeContentBlocks(message.content, 'user message')) {
      if (block?.type === 'text') {
        textParts.push(block.text || '');
      }
    }

    return joinTextParts(textParts);
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    'messages must include at least one user message'
  );
}

function renderToolResultContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'tool_result content must be a string or an array of text blocks'
    );
  }

  const parts = [];
  for (const block of content) {
    if (block?.type !== 'text') {
      throw new GatewayError(
        400,
        'invalid_request_error',
        `unsupported tool_result content block type: ${String(block?.type)}`
      );
    }
    parts.push(block.text || '');
  }

  return joinTextParts(parts);
}

function renderTranscriptBlock(block) {
  if (block?.type === 'text') {
    return block.text || '';
  }

  if (block?.type === 'tool_use') {
    return `[tool_use ${block.name || 'tool'} ${block.id || ''}]\n${JSON.stringify(block.input || {})}`;
  }

  if (block?.type === 'tool_result') {
    return `[tool_result ${block.tool_use_id || ''}${block.is_error ? ' error' : ''}]\n${renderToolResultContent(block.content)}`;
  }

  return '';
}

function renderMessageTranscript(message) {
  if (message?.role === 'system') {
    return '';
  }

  const content = normalizeContentBlocks(message?.content, `${message?.role || 'message'} content`)
    .map(renderTranscriptBlock)
    .filter(Boolean)
    .join('\n\n');
  if (!content) {
    return '';
  }

  return `[${message.role || 'unknown'}]\n${content}`;
}

function renderLatestUserTranscriptInput(requestBody, maxTokens = Number.POSITIVE_INFINITY) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }

    const rendered = renderMessageTranscript(message);
    if (rendered) {
      return limitTextByTokenBudget(rendered, maxTokens);
    }

    break;
  }

  return limitTextByTokenBudget(extractLatestUserText(requestBody), maxTokens);
}

function fitTranscriptInputToBudget(selectedMessages, omittedCount, maxTokens) {
  if (omittedCount <= 0) {
    return limitTextByTokenBudget(joinTextParts(selectedMessages), maxTokens);
  }

  const notice = `${TRANSCRIPT_OMISSION_NOTICE}: ${omittedCount} message(s).`;
  const maxChars = maxCharsForTokenBudget(maxTokens);
  if (!Number.isFinite(maxChars)) {
    return joinTextParts([notice, ...selectedMessages]);
  }

  const remainingMessages = selectedMessages.slice();
  let input = joinTextParts([notice, ...remainingMessages]);
  while (remainingMessages.length > 1 && input.length > maxChars) {
    remainingMessages.shift();
    input = joinTextParts([notice, ...remainingMessages]);
  }

  if (input.length <= maxChars) {
    return input;
  }

  const latestMessage = remainingMessages.at(-1) || '';
  const prefix = `${notice}\n\n`;
  if (prefix.length >= maxChars) {
    return prefix.slice(0, maxChars);
  }

  return `${prefix}${latestMessage.slice(-(maxChars - prefix.length))}`;
}

function renderTranscriptInput(requestBody, maxTokens = Number.POSITIVE_INFINITY) {
  const renderedMessages = [];
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];

  for (const message of messages) {
    const rendered = renderMessageTranscript(message);
    if (!rendered) {
      continue;
    }

    renderedMessages.push(rendered);
  }

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return joinTextParts(renderedMessages) || extractLatestUserText(requestBody);
  }

  const selected = [];
  let usedTokens = 0;
  let omittedCount = 0;
  for (let index = renderedMessages.length - 1; index >= 0; index -= 1) {
    const rendered = renderedMessages[index];
    const tokens = estimateTokensFromText(rendered);
    if (usedTokens + tokens <= maxTokens) {
      selected.unshift(rendered);
      usedTokens += tokens;
      continue;
    }

    if (selected.length === 0) {
      selected.unshift(limitTextByTokenBudget(rendered, maxTokens));
      omittedCount = index;
    } else {
      omittedCount = index + 1;
    }
    break;
  }

  if (selected.length > 0) {
    return fitTranscriptInputToBudget(selected, omittedCount, maxTokens);
  }

  return renderLatestUserTranscriptInput(requestBody, maxTokens);
}

function isCodexContextWindowError(error) {
  return CODEX_CONTEXT_WINDOW_ERROR_PATTERN.test(error?.message || '');
}

function isPossibleCodexContextWindowError(error) {
  if (isCodexContextWindowError(error)) {
    return false;
  }

  return (
    error instanceof GatewayError &&
    error.status === 502 &&
    CODEX_CONTEXT_WINDOW_DRIFT_PATTERN.test(error.message || '')
  );
}

function extractToolResultPayload(requestBody, pendingToolCall) {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== 'user') {
      continue;
    }

    for (const block of normalizeContentBlocks(message.content, 'tool_result message')) {
      if (block?.type !== 'tool_result') {
        continue;
      }

      if (block.tool_use_id !== pendingToolCall.callId) {
        continue;
      }

      return {
        text: renderToolResultContent(block.content),
        isError: block.is_error === true,
      };
    }
  }

  throw new GatewayError(
    400,
    'invalid_request_error',
    `missing tool_result for pending tool call ${pendingToolCall.callId}`
  );
}

function mapReasoningEffort(reasoningEffort) {
  if (typeof reasoningEffort !== 'string' || reasoningEffort.trim() === '') {
    return null;
  }

  const normalized = reasoningEffort.trim().toLowerCase();
  if (!CODEX_REASONING_EFFORTS.has(normalized)) {
    return null;
  }

  return normalized;
}

function shortHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function buildSessionIdentityKey(route, req) {
  return `identity:${shortHash(
    JSON.stringify([
      req.get('x-claude-code-session-id') || 'no-session',
      req.get('x-claude-code-agent-id') || 'root-agent',
      req.get('x-claude-code-parent-agent-id') || 'no-parent',
      route.requestedModel,
    ])
  )}`;
}

function buildSessionBaseKey(route, req, requestBody) {
  const identityKey = buildSessionIdentityKey(route, req);
  const toolKey = shortHash(effectiveToolSchemaSignature(requestBody));
  return `${identityKey}:${toolKey}`;
}

function buildForkSessionKey(baseKey, fingerprint) {
  return `${baseKey}:fork:${fingerprint}`;
}

function requestHeader(req, name) {
  return String(req.get(name) || '').trim();
}

function isClaudeWorkflowAgentRequest(req) {
  const agentId = requestHeader(req, 'x-claude-code-agent-id');
  const parentAgentId = requestHeader(req, 'x-claude-code-parent-agent-id');
  return Boolean(agentId || parentAgentId);
}

function codexThreadSourceForRequest(req) {
  return isClaudeWorkflowAgentRequest(req) ? 'subagent' : 'user';
}

function traceLog(tracer, event, details = {}) {
  tracer?.log?.(event, details);
}

function validateCodexRequestControls(requestBody) {
  effectiveCodexTools(requestBody);
  validateCodexContentBlocks(requestBody);
}

function extractToolResultIds(requestBody) {
  const toolResultIds = new Set();
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (const message of messages) {
    const blocks = normalizeContentBlocks(message?.content, 'message content');
    for (const block of blocks) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id) {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }
  return toolResultIds;
}

function validateCodexContentBlocks(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (const message of messages) {
    const blocks = normalizeContentBlocks(
      message?.content,
      `${message?.role || 'message'} content`
    );
    for (const block of blocks) {
      if (block?.type === 'image') {
        throw new GatewayError(
          400,
          'invalid_request_error',
          'Codex-routed gateway requests do not support image content blocks yet'
        );
      }
    }
  }
}

class CodexAppServerConnection extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.child = null;
    this.stopPromise = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.initialized = false;
    this.closed = false;
    this.closing = false;
    this.rpcTimeoutMs = Math.max(
      5_000,
      Math.min(Number(this.config.requestTimeoutMs) || 5 * 60_000, 60_000)
    );
    this.closeKillTimeoutMs = Math.max(
      100,
      Number(this.config.codex.closeKillTimeoutMs) || DEFAULT_CLOSE_KILL_TIMEOUT_MS
    );
    this.on('error', noop);
    this.readyPromise = this.start();
    this.readyPromise.catch(function ignoreReadyPromiseRejection() {});
  }

  async start() {
    this.child = spawn(this.config.codex.command, ['app-server'], {
      cwd: this.config.codex.cwd,
      detached: SUPPORTS_PROCESS_GROUP_SIGNALS,
      env: {
        ...process.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', this.handleStdout.bind(this));
    this.child.stderr.on('data', this.handleStderr.bind(this));
    this.child.on('error', this.handleExit.bind(this));
    this.child.on('close', this.handleClose.bind(this));

    const initializeResult = await this.rawRequest('initialize', {
      clientInfo: {
        name: 'ultrathink_gateway',
        title: 'UltraThink Gateway',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.send({
      method: 'initialized',
      params: {},
    });
    this.initialized = true;
    return initializeResult;
  }

  handleStdout(chunk) {
    this.buffer += chunk;

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf('\n');

      if (!line.trim()) {
        continue;
      }

      let message = null;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.handleExit(
          new GatewayError(502, 'api_error', 'Codex app-server returned invalid JSON')
        );
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleStderr(chunk) {
    const text = chunk.toString('utf8').trim();
    if (!text) {
      return;
    }
    this.emit('stderr', text);
    if (CODEX_APP_SERVER_FATAL_STDERR_PATTERNS.some((pattern) => pattern.test(text))) {
      this.handleExit(
        new GatewayError(502, 'api_error', `Codex app-server transport failed: ${text}`)
      );
    }
  }

  handleExit(error) {
    if (this.closed && this.pendingRequests.size === 0) {
      return;
    }

    const failure =
      error instanceof GatewayError
        ? error
        : new GatewayError(
            502,
            'api_error',
            error instanceof Error ? error.message : 'Codex app-server failed'
          );

    this.closed = true;
    for (const requestId of this.pendingRequests.keys()) {
      this.rejectPendingRequest(requestId, failure);
    }
    this.emit('error', failure);
    void this.stopChild();
  }

  handleClose(code, signal) {
    if (this.closing) {
      this.closed = true;
      return;
    }

    let reason = `code ${String(code)}`;
    if (code === 0 && !signal && this.pendingRequests.size > 0) {
      reason = 'code 0 before pending requests completed';
    } else if (signal) {
      reason = `signal ${signal}`;
    }

    this.handleExit(
      new GatewayError(
        502,
        'api_error',
        `Codex app-server exited unexpectedly with ${reason}`
      )
    );
  }

  handleMessage(message) {
    if (message.id !== undefined && message.method === undefined && message.error === undefined) {
      this.resolvePendingRequest(message.id, message.result ?? null);
      return;
    }

    if (message.id !== undefined && message.error !== undefined) {
      this.rejectPendingRequest(
        message.id,
        new GatewayError(
          502,
          'api_error',
          message.error.message || 'Codex app-server request failed'
        )
      );
      return;
    }

    if (message.method && message.id !== undefined) {
      this.emit('server-request', message);
      return;
    }

    if (message.method) {
      this.emit('notification', message);
    }
  }

  send(message) {
    if (!this.child || this.closed) {
      throw new GatewayError(502, 'api_error', 'Codex app-server is not available');
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params) {
    await this.readyPromise;
    return this.rawRequest(method, params);
  }

  rawRequest(method, params) {
    const requestId = ++this.nextRequestId;

    return new Promise(function waitForResponse(resolve, reject) {
      const timeout = setTimeout(() => {
        this.rejectPendingRequest(
          requestId,
          new GatewayError(
            504,
            'api_error',
            `Codex app-server request timed out while waiting for ${method}`
          )
        );
      }, this.rpcTimeoutMs);
      timeout.unref?.();

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      try {
        this.send({
          id: requestId,
          method,
          params,
        });
      } catch (error) {
        this.rejectPendingRequest(requestId, error);
      }
    }.bind(this));
  }

  resolvePendingRequest(requestId, result) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.resolve(result);
  }

  rejectPendingRequest(requestId, error) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.reject(error);
  }

  async close(reason = null) {
    if (this.closed) {
      await this.stopChild();
      return;
    }

    this.closed = true;
    this.closing = true;
    const failure =
      reason instanceof GatewayError
        ? reason
        : new GatewayError(502, 'api_error', 'Codex app-server was closed');
    for (const requestId of this.pendingRequests.keys()) {
      this.rejectPendingRequest(requestId, failure);
    }

    if (!this.child) {
      return;
    }

    await this.stopChild();
  }

  async stopChild() {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    const child = this.child;
    if (!child) {
      return;
    }

    this.stopPromise = new Promise((resolve) => {
      let settled = false;
      const childAlreadyExited = child.exitCode !== null || child.signalCode !== null;
      const killTimer = setTimeout(function killStubbornChild() {
        const killSignaled = signalChildProcessTree(child, 'SIGKILL');
        const childExited = child.exitCode !== null || child.signalCode !== null;
        if (childAlreadyExited || childExited || !killSignaled) {
          finish();
        }
      }, this.closeKillTimeoutMs);

      function finish() {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(killTimer);
        child.off('close', finishWhenProcessTreeExited);
        resolve();
      }

      function finishWhenProcessTreeExited() {
        if (childProcessTreeExists(child)) {
          return;
        }
        finish();
      }

      if (!childAlreadyExited) {
        child.once('close', finishWhenProcessTreeExited);
      }
      if (!signalChildProcessTree(child, 'SIGTERM')) {
        finish();
      }
    });

    return this.stopPromise;
  }
}

class CodexGatewaySession {
  constructor(config, route, req, requestBody, sessionKey = null, tracer = null, options = {}) {
    this.config = config;
    this.route = route;
    this.requestedModel = route.requestedModel;
    this.effectiveTools = effectiveCodexTools(requestBody);
    this.toolSignature = toolSchemaSignature(this.effectiveTools);
    this.toolRegistry = buildCodexDynamicToolRegistry(this.effectiveTools);
    this.identityKey = buildSessionIdentityKey(route, req);
    this.baseSessionKey = buildSessionBaseKey(route, req, requestBody);
    this.sessionKey = sessionKey || this.baseSessionKey;
    this.tracer = tracer?.scope?.({
      base_session_key: this.baseSessionKey,
      session_key: this.sessionKey,
      requested_model: this.requestedModel,
      upstream_model: this.route.upstreamModel,
      sandbox: this.route.sandbox,
      approval_policy: this.route.approvalPolicy,
    }) || null;
    this.systemPrompt = renderSystemPrompt(requestBody);
    this.connection = new CodexAppServerConnection(config);
    this.bootstrapMode = options.bootstrapMode || '';
    // Shared per-upstream-model context windows learned from app-server usage
    // events, provided by the owning session manager.
    this.contextWindows = options.contextWindows || null;
    this.threadSource = codexThreadSourceForRequest(req);
    this.ephemeralThread = this.threadSource === 'subagent';
    this.threadId = null;
    this.pendingToolCall = null;
    this.activeBoundary = null;
    this.routingReservation = null;
    this.latestTotalUsage = emptyUsage();
    this.idleTimer = null;
    this.lastUsedAt = Date.now();
    this.disposed = false;

    traceLog(this.tracer, 'codex.session.created', {
      tool_count: this.effectiveTools.length,
      thread_source: this.threadSource,
      ephemeral_thread: this.ephemeralThread,
    });
  }

  scopedTracer(requestTracer = null) {
    const rootTracer = requestTracer || this.tracer;
    return rootTracer?.scope?.({
      base_session_key: this.baseSessionKey,
      session_key: this.sessionKey,
      requested_model: this.requestedModel,
      upstream_model: this.route.upstreamModel,
      sandbox: this.route.sandbox,
      approval_policy: this.route.approvalPolicy,
    }) || null;
  }

  touch(onExpire, timeoutMs = this.config.codex.idleTimeoutMs) {
    this.lastUsedAt = Date.now();
    clearTimeout(this.idleTimer);
    const effectiveTimeoutMs = Math.max(0, numberOrDefault(timeoutMs, 0));
    if (effectiveTimeoutMs <= 0 || !this.isIdle()) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      onExpire(this.sessionKey);
    }, effectiveTimeoutMs);
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  isIdle() {
    return !this.routingReservation && (!this.activeBoundary || this.activeBoundary.finished);
  }

  isDisposableIdle() {
    return !this.routingReservation && !this.pendingToolCall && this.isIdle();
  }

  isForkSession() {
    return this.sessionKey !== this.baseSessionKey;
  }

  knownModelContextWindow() {
    const own = Number(this.modelContextWindow || 0);
    if (own > 0) {
      return own;
    }

    const shared = Number(this.contextWindows?.get(this.route.upstreamModel) || 0);
    return shared > 0 ? shared : 0;
  }

  inputMaxTokens() {
    return effectiveCodexInputMaxTokens(this.config, this.knownModelContextWindow());
  }

  bootstrapInputMaxTokens() {
    const budget = this.inputMaxTokens();
    const recycleLimit = codexRecycleContextLimit(this.config, this.knownModelContextWindow());
    if (!Number.isFinite(recycleLimit)) {
      return budget;
    }

    // Keep bootstrap transcript replays strictly below the recycle threshold
    // so a freshly recycled session cannot land above it and thrash into
    // recycling again on its next turn.
    return Math.min(budget, Math.max(1, Math.floor(recycleLimit * CODEX_BOOTSTRAP_RECYCLE_HEADROOM)));
  }

  initialInputMode() {
    if (this.bootstrapMode) {
      return this.bootstrapMode;
    }

    if (this.isForkSession()) {
      return 'latest';
    }

    return 'transcript';
  }

  initialTurnInput(requestBody) {
    const maxTokens = this.bootstrapInputMaxTokens();
    if (this.initialInputMode() === 'latest') {
      return renderLatestUserTranscriptInput(requestBody, maxTokens);
    }

    return renderTranscriptInput(requestBody, maxTokens);
  }

  assertCompatible(route, requestBody, options = {}) {
    if (route.upstreamModel !== this.route.upstreamModel) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'changing the routed Codex model inside an active Claude session is not supported yet'
      );
    }

    if (!options.skipToolSignature && effectiveToolSchemaSignature(requestBody) !== this.toolSignature) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'changing the routed tool schema inside an active Claude session is not supported yet'
      );
    }

    if (route.sandbox !== this.route.sandbox) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'changing the routed Codex sandbox inside an active Claude session is not supported yet'
      );
    }

    if (route.approvalPolicy !== this.route.approvalPolicy) {
      throw new GatewayError(
        400,
        'invalid_request_error',
        'changing the routed Codex approval policy inside an active Claude session is not supported yet'
      );
    }
  }

  async ensureThread() {
    if (this.threadId) {
      return;
    }

    const result = await this.connection.request('thread/start', {
      model: this.route.upstreamModel,
      cwd: this.config.codex.cwd,
      approvalPolicy: this.route.approvalPolicy,
      sandbox: this.route.sandbox,
      developerInstructions: this.systemPrompt || null,
      dynamicTools: this.toolRegistry.dynamicTools,
      serviceName: 'ultrathink_gateway',
      threadSource: this.threadSource,
      ...(this.ephemeralThread ? { ephemeral: true } : {}),
    });

    this.threadId = result.thread?.id || null;
    if (!this.threadId) {
      throw new GatewayError(502, 'api_error', 'Codex app-server did not return a thread id');
    }

    traceLog(this.tracer, 'codex.thread.started', {
      thread_id: this.threadId,
      thread_source: this.threadSource,
      ephemeral_thread: this.ephemeralThread,
    });
  }

  async startTurn(requestBody) {
    const threadExists = Boolean(this.threadId);
    await this.ensureThread();
    const latestUserText = threadExists
      ? limitTextByTokenBudget(extractLatestUserText(requestBody), this.inputMaxTokens())
      : this.initialTurnInput(requestBody);
    const result = await this.connection.request('turn/start', {
      threadId: this.threadId,
      input: [
        {
          type: 'text',
          text: latestUserText,
        },
      ],
      effort: mapReasoningEffort(this.route.reasoningEffort),
    });

    const turnId = result.turn?.id || null;
    if (!turnId) {
      throw new GatewayError(502, 'api_error', 'Codex app-server did not return a turn id');
    }

    return turnId;
  }

  async continuePendingToolCall(requestBody, requestTracer = null) {
    if (!this.pendingToolCall) {
      throw new GatewayError(500, 'api_error', 'no pending Codex tool call exists');
    }

    const rawToolResult = extractToolResultPayload(requestBody, this.pendingToolCall);
    const toolResult = {
      ...rawToolResult,
      text: limitTextByTokenBudget(rawToolResult.text, this.inputMaxTokens()),
    };
    const tracer = this.scopedTracer(requestTracer);
    traceLog(tracer, 'codex.tool_result.continued', {
      call_id: this.pendingToolCall.callId,
      tool_name: this.pendingToolCall.tool,
      result_length: toolResult.text.length,
      is_error: toolResult.isError,
    });
    this.connection.send({
      id: this.pendingToolCall.requestId,
      result: {
        success: !toolResult.isError,
        contentItems: [
          {
            type: 'inputText',
            text: toolResult.text,
          },
        ],
      },
    });

    const turnId = this.pendingToolCall.turnId;
    this.pendingToolCall = null;
    const boundary = createBoundary(turnId, requestBody, this.latestTotalUsage);
    this.activeBoundary = boundary;
    return this.beginBoundary(boundary, turnId, requestBody, requestTracer);
  }

  resolveAdvanceMode(requestBody) {
    const fingerprint = requestFingerprint(requestBody);
    const matchingToolResult = hasMatchingToolResult(requestBody, this.pendingToolCall);

    if (this.pendingToolCall) {
      if (matchingToolResult) {
        return {
          mode: 'continue_tool_result',
        };
      }

      if (this.activeBoundary && this.activeBoundary.requestFingerprint === fingerprint) {
        return {
          mode: 'replay_boundary',
          boundary: this.activeBoundary,
        };
      }

      throw new GatewayError(
        400,
        'invalid_request_error',
        `missing tool_result for pending tool call ${this.pendingToolCall.callId}`
      );
    }

    if (this.activeBoundary) {
      if (this.activeBoundary.requestFingerprint === fingerprint) {
        return {
          mode: 'replay_boundary',
          boundary: this.activeBoundary,
        };
      }

      if (!this.activeBoundary.finished) {
        throw new GatewayError(
          409,
          'invalid_request_error',
          'another routed Codex turn is already in progress for this Claude session'
        );
      }

      this.activeBoundary = null;
    }

    return {
      mode: 'start_new',
    };
  }

  async advanceBoundary(requestBody, requestTracer = null) {
    validateCodexRequestControls(requestBody);
    const resolution = this.resolveAdvanceMode(requestBody);

    if (resolution.mode === 'replay_boundary') {
      traceLog(this.scopedTracer(requestTracer), 'codex.boundary.replay', {
        turn_id: resolution.boundary.turnId,
      });
      return resolution.boundary;
    }

    if (resolution.mode === 'continue_tool_result') {
      return this.continuePendingToolCall(requestBody, requestTracer);
    }

    const boundary = createBoundary(null, requestBody, this.latestTotalUsage);
    this.activeBoundary = boundary;

    try {
      const turnId = await this.startTurn(requestBody);
      return this.beginBoundary(boundary, turnId, requestBody, requestTracer);
    } catch (error) {
      if (this.activeBoundary === boundary) {
        this.activeBoundary = null;
      }
      boundary.finished = true;
      boundary.error = error;
      boundary.done.catch(function ignoreBoundaryStartFailure() {});
      boundary.reject(error);
      throw error;
    }
  }

  async advance(requestBody, requestTracer = null) {
    const boundary = await this.advanceBoundary(requestBody, requestTracer);
    return boundary.done;
  }

  beginBoundary(boundary, turnId, requestBody, requestTracer = null) {
    const tracer = this.scopedTracer(requestTracer);
    boundary.turnId = turnId;
    traceLog(tracer, 'codex.boundary.started', {
      turn_id: turnId,
      request_fingerprint: boundary.requestFingerprint,
    });

    const cleanup = () => {
      clearTimeout(toolUseSettlementTimer);
      clearTimeout(toolUseFallbackTimer);
      this.connection.off('notification', onNotification);
      this.connection.off('server-request', onServerRequest);
      this.connection.off('error', onError);
    };

    let toolUseSettlementTimer = null;
    let toolUseFallbackTimer = null;
    let deferredToolUseOutcome = null;

    const completeDeferredToolUse = () => {
      if (!deferredToolUseOutcome || boundary.finished) {
        return;
      }

      const outcome = deferredToolUseOutcome;
      deferredToolUseOutcome = null;
      completeBoundary(outcome);
    };

    const scheduleDeferredToolUseCompletion = (delayMs) => {
      clearTimeout(toolUseSettlementTimer);
      toolUseSettlementTimer = setTimeout(function settleToolUse() {
        completeDeferredToolUse();
      }, delayMs);
      toolUseSettlementTimer.unref?.();
    };

    const scheduleDeferredToolUseFallback = () => {
      clearTimeout(toolUseFallbackTimer);
      toolUseFallbackTimer = setTimeout(function settleToolUseFallback() {
        completeDeferredToolUse();
      }, 2_000);
      toolUseFallbackTimer.unref?.();
    };

    const failBoundary = (error) => {
      if (boundary.finished) {
        return;
      }

      cleanup();
      boundary.finished = true;
      boundary.error = error;
      traceLog(tracer, 'codex.boundary.failed', {
        turn_id: turnId,
        error_message: error?.message || 'unknown error',
      });
      boundary.reject(error);
    };

    const completeBoundary = (outcome) => {
      if (boundary.finished) {
        return;
      }

      cleanup();
      boundary.finished = true;
      populateEstimatedUsage(boundary, requestBody, outcome);
      boundary.outcome = {
        ...outcome,
        usage: boundary.usage,
      };
      traceLog(tracer, 'codex.boundary.completed', {
        turn_id: turnId,
        outcome_type: outcome.type,
        output_chars: boundary.text.length,
        usage: boundary.usage,
      });
      boundary.emit({
        type: 'boundary',
        outcome: boundary.outcome,
      });
      boundary.resolve(boundary.outcome);
    };

    const onError = (error) => {
      failBoundary(error);
    };

    const onNotification = (message) => {
      if (message.method === 'item/agentMessage/delta' && message.params?.turnId === turnId) {
        boundary.deltaItemIds.add(message.params?.itemId);
        const text = message.params?.delta || '';
        if (text) {
          boundary.text += text;
          boundary.emit({
            type: 'text_delta',
            text,
          });
        }
        return;
      }

      if (
        message.method === 'item/completed' &&
        message.params?.turnId === turnId &&
        message.params?.item?.type === 'agentMessage'
      ) {
        const itemId = message.params.item.id;
        if (!boundary.deltaItemIds.has(itemId) && typeof message.params.item.text === 'string') {
          const text = message.params.item.text;
          if (text) {
            boundary.text += text;
            boundary.emit({
              type: 'text_delta',
              text,
            });
          }
        }
        return;
      }

      if (
        message.method === 'item/completed' &&
        message.params?.turnId === turnId &&
        message.params?.item?.type === 'dynamicToolCall' &&
        deferredToolUseOutcome
      ) {
        scheduleDeferredToolUseCompletion(500);
        return;
      }

      if (
        message.method === 'thread/tokenUsage/updated' &&
        message.params?.turnId === turnId &&
        (message.params?.tokenUsage?.total || message.params?.tokenUsage?.last)
      ) {
        const tokenUsage = normalizeCodexTokenUsage(message.params.tokenUsage);
        if (tokenUsage.total) {
          boundary.usage = usageDelta(tokenUsage.total, boundary.usageBaseline);
          this.latestTotalUsage = tokenUsage.total;
        } else {
          boundary.usage = tokenUsage.last || emptyUsage();
          this.latestTotalUsage = addUsage(boundary.usageBaseline, boundary.usage);
        }
        if (tokenUsage.model_context_window) {
          this.modelContextWindow = tokenUsage.model_context_window;
          this.contextWindows?.set(this.route.upstreamModel, tokenUsage.model_context_window);
        }
        // Prefer the per-turn snapshot (tracks shrinkage after app-server
        // compaction); fall back to the cumulative total, which overestimates
        // live context — the safe direction for recycle pressure.
        this.latestContextTokens =
          contextTokensFromUsage(tokenUsage.last) ||
          contextTokensFromUsage(tokenUsage.total) ||
          this.latestContextTokens ||
          0;
        traceLog(tracer, 'codex.usage.updated', {
          turn_id: turnId,
          usage: boundary.usage,
          total_usage: tokenUsage.total,
          last_usage: tokenUsage.last,
          model_context_window: tokenUsage.model_context_window,
        });
        boundary.emit({
          type: 'usage',
          usage: boundary.usage,
        });
        if (deferredToolUseOutcome) {
          completeDeferredToolUse();
        }
        return;
      }

      if (message.method !== 'turn/completed' || message.params?.turn?.id !== turnId) {
        return;
      }

      const turn = message.params.turn;
      if (turn.status !== 'completed') {
        failBoundary(
          new GatewayError(
            502,
            'api_error',
            turn.error?.message || `Codex turn ended with status ${String(turn.status)}`
          )
        );
        return;
      }

      completeBoundary({
        type: 'final',
        text: boundary.text,
      });
    };

    const onServerRequest = (message) => {
      if (message.method !== 'item/tool/call' || message.params?.turnId !== turnId) {
        return;
      }

      const params = message.params;
      const originalName = originalToolName(this.toolRegistry, params.tool);
      if (this.pendingToolCall) {
        const errorMessage =
          `parallel Codex tool call ${params.callId || 'unknown'} rejected while waiting ` +
          `for tool_result for ${this.pendingToolCall.callId}`;
        traceLog(tracer, 'codex.tool_call.parallel_rejected', {
          turn_id: turnId,
          call_id: params.callId || null,
          tool_name: originalName,
          pending_call_id: this.pendingToolCall.callId,
          pending_tool_name: this.pendingToolCall.tool,
        });
        if (message.id !== undefined) {
          this.connection.send({
            id: message.id,
            error: {
              code: -32000,
              message: errorMessage,
            },
          });
        }
        return;
      }

      this.pendingToolCall = {
        requestId: message.id,
        turnId,
        callId: params.callId,
        tool: originalName,
        arguments: params.arguments || {},
      };
      traceLog(tracer, 'codex.tool_call.pending', {
        turn_id: turnId,
        call_id: params.callId,
        tool_name: originalName,
      });

      deferredToolUseOutcome = {
        type: 'tool_use',
        text: boundary.text,
        toolCall: {
          id: params.callId,
          name: originalName,
          input: params.arguments || {},
        },
      };
      scheduleDeferredToolUseFallback();
    };

    this.connection.on('notification', onNotification);
    this.connection.on('server-request', onServerRequest);
    this.connection.on('error', onError);

    return boundary;
  }

  async stream(requestBody, onEvent, requestTracer = null) {
    const boundary = await this.advanceBoundary(requestBody, requestTracer);
    let eventFailure = null;
    let eventChain = Promise.resolve();
    let notifyEventFailure = null;
    const eventFailureReady = new Promise(function waitForEventFailure(resolve) {
      notifyEventFailure = resolve;
    });

    function recordEventFailure(error) {
      if (eventFailure) {
        return;
      }
      eventFailure = error;
      notifyEventFailure();
    }

    function queueEvent(event) {
      const queued = eventChain.then(function handleQueuedEvent() {
        if (eventFailure) {
          return undefined;
        }
        return onEvent(event);
      });
      queued.catch(recordEventFailure);
      eventChain = queued.catch(function keepEventQueueSettled() {
        return undefined;
      });
      return queued;
    }

    async function flushEvents() {
      await eventChain;
    }

    const removeListener = boundary.addListener(queueEvent);
    try {
      const boundaryResult = boundary.done.then(
        function boundarySucceeded(value) {
          return { type: 'success', value };
        },
        function boundaryFailed(error) {
          return { type: 'failure', error };
        }
      );
      const outcome = await Promise.race([
        boundaryResult,
        eventFailureReady.then(function eventWriteFailed() {
          return { type: 'event_failure' };
        }),
      ]);
      await flushEvents();
      if (eventFailure) {
        throw eventFailure;
      }
      if (outcome.type === 'failure') {
        throw outcome.error;
      }
      return outcome.value;
    } finally {
      removeListener();
    }
  }

  async close(reason = null) {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.idleTimer);
    traceLog(this.tracer, 'codex.session.closed');
    await this.connection.close(reason);
  }
}

export class CodexSessionManager {
  constructor(config, options = {}) {
    this.config = config;
    this.sessions = new Map();
    this.tracer = options.tracer || null;
    this.learnedContextWindows = new Map();
    this.createSession =
      typeof options.createSession === 'function'
        ? options.createSession
        : (route, req, requestBody, sessionKey, requestTracer = null, sessionOptions = {}) =>
            new CodexGatewaySession(
              this.config,
              route,
              req,
              requestBody,
              sessionKey,
              (requestTracer || this.tracer)?.scope?.({
                requested_model: route.requestedModel,
                upstream_model: route.upstreamModel,
              }) || null,
              {
                contextWindows: this.learnedContextWindows,
                ...sessionOptions,
              }
            );
  }

  identityEntries(identityKey) {
    return Array.from(this.sessions.entries()).filter(function matchIdentity([, session]) {
      return (
        session.identityKey === identityKey ||
        (typeof session.baseSessionKey === 'string' &&
          session.baseSessionKey.startsWith(`${identityKey}:`))
      );
    });
  }

  familyEntries(baseSessionKey) {
    return Array.from(this.sessions.entries()).filter(function matchBaseKey([, session]) {
      return session.baseSessionKey === baseSessionKey;
    });
  }

  hasRoutingReservation(session) {
    return Boolean(session?.routingReservation);
  }

  reserveSessionForRequest(session, selection, requestTracer = null) {
    if (!session || NON_RESERVING_SELECTION_REASONS.has(selection.selectionReason)) {
      return null;
    }

    const reservation = {
      requestFingerprint: selection.requestFingerprint,
      createdAt: Date.now(),
    };
    session.routingReservation = reservation;
    traceLog(requestTracer || this.tracer, 'codex.session.reserved', {
      session_key: session.sessionKey,
      selection_reason: selection.selectionReason,
      request_fingerprint: selection.requestFingerprint,
    });
    return reservation;
  }

  clearSessionReservation(session, reservation) {
    if (reservation && session?.routingReservation === reservation) {
      session.routingReservation = null;
    }
  }

  resolveSessionEntry(req, requestBody, route) {
    const identityKey = buildSessionIdentityKey(route, req);
    const baseSessionKey = buildSessionBaseKey(route, req, requestBody);
    const requestIdFingerprint = requestFingerprint(requestBody);
    const toolResultIds = extractToolResultIds(requestBody);
    const identityEntries = this.identityEntries(identityKey);
    const familyEntries = this.familyEntries(baseSessionKey);

    for (const [sessionKey, session] of identityEntries) {
      if (session.pendingToolCall && toolResultIds.has(session.pendingToolCall.callId)) {
        return {
          sessionKey,
          session,
          selectionReason: 'matching_tool_result',
          requestFingerprint: requestIdFingerprint,
        };
      }
    }

    for (const [sessionKey, session] of identityEntries) {
      if (session.activeBoundary?.requestFingerprint === requestIdFingerprint) {
        return {
          sessionKey,
          session,
          selectionReason: 'boundary_replay',
          requestFingerprint: requestIdFingerprint,
        };
      }
    }

    for (const [sessionKey, session] of identityEntries) {
      if (session.routingReservation?.requestFingerprint === requestIdFingerprint) {
        return {
          sessionKey,
          session,
          selectionReason: 'routing_reservation_replay',
          requestFingerprint: requestIdFingerprint,
        };
      }
    }

    const canonical = familyEntries.find(function findCanonical([sessionKey]) {
      return sessionKey === baseSessionKey;
    });
    if (!canonical) {
      return {
        sessionKey: baseSessionKey,
        session: null,
        selectionReason: 'new_canonical',
        requestFingerprint: requestIdFingerprint,
      };
    }

    const [canonicalKey, canonicalSession] = canonical;
    if (canonicalSession.pendingToolCall) {
      const forkSessionKey = buildForkSessionKey(baseSessionKey, requestIdFingerprint);
      return {
        sessionKey: forkSessionKey,
        session: this.sessions.get(forkSessionKey) || null,
        selectionReason: 'fork_pending_tool_call',
        requestFingerprint: requestIdFingerprint,
      };
    }

    if (canonicalSession.activeBoundary && !canonicalSession.activeBoundary.finished) {
      const forkSessionKey = buildForkSessionKey(baseSessionKey, requestIdFingerprint);
      return {
        sessionKey: forkSessionKey,
        session: this.sessions.get(forkSessionKey) || null,
        selectionReason: 'fork_active_boundary',
        requestFingerprint: requestIdFingerprint,
      };
    }

    if (this.hasRoutingReservation(canonicalSession)) {
      const forkSessionKey = buildForkSessionKey(baseSessionKey, requestIdFingerprint);
      return {
        sessionKey: forkSessionKey,
        session: this.sessions.get(forkSessionKey) || null,
        selectionReason: 'fork_routing_reservation',
        requestFingerprint: requestIdFingerprint,
      };
    }

    return {
      sessionKey: canonicalKey,
      session: canonicalSession,
      selectionReason: 'canonical',
      requestFingerprint: requestIdFingerprint,
    };
  }

  ensureSessionEntry(req, requestBody, route, requestTracer = null, options = {}) {
    validateCodexRequestControls(requestBody);
    const selection = this.resolveSessionEntry(req, requestBody, route);
    let session = selection.session;

    traceLog(requestTracer || this.tracer, 'codex.session.selected', {
      requested_model: route.requestedModel,
      upstream_model: route.upstreamModel,
      session_key: selection.sessionKey,
      selection_reason: selection.selectionReason,
      request_fingerprint: selection.requestFingerprint,
    });

    const pressure = session
      ? this.contextPressureDecision(session, selection.selectionReason, requestBody)
      : null;
    if (pressure) {
      traceLog(requestTracer || this.tracer, 'codex.session.recycled', {
        session_key: selection.sessionKey,
        selection_reason: selection.selectionReason,
        context_tokens: pressure.contextTokens,
        incoming_tokens: pressure.incomingTokens,
        recycle_limit: pressure.limit,
        model_context_window: session.knownModelContextWindow?.() || null,
      });
      this.sessions.delete(selection.sessionKey);
      void session.close(new Error('recycled before Codex context window overflow'));
      session = null;
      // The replacement must replay the bounded transcript even under a fork
      // session key, whose default bootstrap mode ('latest') would silently
      // drop all prior context.
      options = { ...options, bootstrapMode: 'transcript' };
    }

    if (!session) {
      session = this.createSession(
        route,
        req,
        requestBody,
        selection.sessionKey,
        requestTracer,
        options
      );
      this.sessions.set(selection.sessionKey, session);
      this.watchSession(selection.sessionKey, session);
    } else {
      session.assertCompatible(route, requestBody, {
        skipToolSignature: selection.selectionReason === 'matching_tool_result',
      });
    }

    session.clearIdleTimer?.();
    return {
      ...selection,
      session,
    };
  }

  ensureSession(req, requestBody, route, requestTracer = null) {
    return this.ensureSessionEntry(req, requestBody, route, requestTracer).session;
  }

  prepareSessionRequest(req, requestBody, route, requestTracer = null, options = {}) {
    const selection = this.ensureSessionEntry(req, requestBody, route, requestTracer, options);
    return {
      ...selection,
      reservation: this.reserveSessionForRequest(selection.session, selection, requestTracer),
    };
  }

  async processRequest(req, requestBody, route, requestTracer = null) {
    return this.runRecoverableSessionRequest({
      req,
      requestBody,
      route,
      requestTracer,
      run(session) {
        return session.advance(requestBody, requestTracer);
      },
    });
  }

  async streamRequest(req, requestBody, route, onEvent, requestTracer = null) {
    let forwardedEventCount = 0;
    function retryAwareOnEvent(event) {
      forwardedEventCount += 1;
      return onEvent(event);
    }

    return this.runRecoverableSessionRequest({
      req,
      requestBody,
      route,
      requestTracer,
      canRetry() {
        return forwardedEventCount === 0;
      },
      run(session) {
        return session.stream(requestBody, retryAwareOnEvent, requestTracer);
      },
    });
  }

  async runRecoverableSessionRequest(options) {
    // Shared across retry attempts (spread copies keep the same reference) so
    // overflow diagnostics always describe the most recently prepared session.
    options.attemptState = options.attemptState || {};
    let lastError = null;
    try {
      return await this.runPreparedSessionRequest(options);
    } catch (error) {
      if (!this.canRecoverFromContextOverflow(error, options)) {
        this.traceContextRecoverySkipped(error, options);
        throw this.describeContextOverflowError(error, options);
      }
      lastError = error;
    }

    // Recover on a fresh thread: first with the bounded full-transcript replay
    // (keeps context; fits the adaptive budget), then with latest-only input.
    // When the failed attempt was itself a fresh transcript bootstrap, a
    // transcript retry would re-send byte-identical input and deterministically
    // fail again, so skip straight to latest-only.
    const failedSession = options.attemptState.lastPreparedSession || null;
    const failedFreshTranscriptBootstrap =
      failedSession &&
      Number(failedSession.latestContextTokens || 0) === 0 &&
      failedSession.initialInputMode?.() === 'transcript';
    const recoveryModes = failedFreshTranscriptBootstrap
      ? ['latest']
      : ['transcript', 'latest'];

    for (const bootstrapMode of recoveryModes) {
      traceLog(options.requestTracer || this.tracer, 'codex.session.context_recovery_retry', {
        bootstrap_mode: bootstrapMode,
        error_message: lastError?.message || String(lastError),
      });

      try {
        return await this.runPreparedSessionRequest({
          ...options,
          sessionOptions: {
            ...(options.sessionOptions || {}),
            bootstrapMode,
          },
        });
      } catch (error) {
        if (!this.canRecoverFromContextOverflow(error, options)) {
          this.traceContextRecoverySkipped(error, options);
          throw this.describeContextOverflowError(error, options);
        }
        lastError = error;
      }
    }

    throw this.describeContextOverflowError(lastError, options);
  }

  describeContextOverflowError(error, options) {
    if (!isCodexContextWindowError(error)) {
      return error;
    }

    const session = options.attemptState?.lastPreparedSession || null;
    const contextTokens = Number(session?.latestContextTokens || 0);
    const window = Number(session?.knownModelContextWindow?.() || 0);
    const budget = session ? session.inputMaxTokens() : codexInputMaxTokens(this.config);
    const details = [
      contextTokens > 0 ? `session context ~${contextTokens} tokens` : null,
      window > 0 ? `model window ${window} tokens` : null,
      Number.isFinite(budget) ? `gateway input budget ${budget} tokens` : null,
    ]
      .filter(Boolean)
      .join(', ');

    return new GatewayError(
      400,
      'invalid_request_error',
      `Codex context window exceeded${details ? ` (${details})` : ''}: ${error?.message || String(error)}`
    );
  }

  traceContextRecoverySkipped(error, options) {
    const tracer = options.requestTracer || this.tracer;
    if (isCodexContextWindowError(error)) {
      traceLog(tracer, 'codex.session.context_recovery_skipped', {
        error_message: error?.message || String(error),
        aborted: options.req?.abortSignal?.aborted === true,
      });
      return;
    }

    if (isPossibleCodexContextWindowError(error)) {
      traceLog(tracer, 'codex.session.context_recovery_unmatched', {
        error_message: error?.message || String(error),
        gateway_error_status: error.status,
        gateway_error_type: error.type,
      });
    }
  }

  recycleContextTokenLimit(session) {
    return codexRecycleContextLimit(this.config, session?.knownModelContextWindow?.() || 0);
  }

  contextPressureDecision(session, selectionReason, requestBody = null) {
    // Only recycle when the session is between turns: a fresh replacement is
    // bootstrapped from the bounded transcript replay, the same path used
    // when an idle-expired session receives a follow-up tool result.
    if (!RECYCLE_ELIGIBLE_SELECTION_REASONS.has(selectionReason)) {
      return null;
    }

    if (session.routingReservation) {
      return null;
    }

    if (session.activeBoundary && !session.activeBoundary.finished) {
      return null;
    }

    const contextTokens = Number(session.latestContextTokens || 0);
    if (contextTokens <= 0) {
      return null;
    }

    // Project the incoming payload on top of the live context so a single
    // oversized tool result cannot leap past the window in one turn.
    const limit = this.recycleContextTokenLimit(session);
    const incomingTokens = estimateIncomingRequestTokens(requestBody);
    if (contextTokens + incomingTokens < limit) {
      return null;
    }

    return { contextTokens, incomingTokens, limit };
  }

  canRecoverFromContextOverflow(error, options) {
    if (!isCodexContextWindowError(error)) {
      return false;
    }

    if (options.req?.abortSignal?.aborted) {
      return false;
    }

    if (typeof options.canRetry === 'function' && !options.canRetry()) {
      return false;
    }

    return true;
  }

  async runPreparedSessionRequest(options) {
    const { req, requestBody, route, requestTracer, sessionOptions = {} } = options;
    const { session, reservation } = this.prepareSessionRequest(
      req,
      requestBody,
      route,
      requestTracer,
      sessionOptions
    );
    if (!options.attemptState) {
      options.attemptState = {};
    }
    options.attemptState.lastPreparedSession = session;

    return this.runSessionRequest(
      session,
      function runSession() {
        return options.run(session);
      },
      req.abortSignal,
      reservation
    );
  }

  watchSession(sessionKey, session) {
    if (!session.connection?.once) {
      return;
    }

    const manager = this;
    session.connection.once('error', function evictErroredSession(error) {
      void manager.evictSession(sessionKey, session, error, 'codex.session.evicted');
    });
  }

  isEvictableFailure(error) {
    if (error instanceof GatewayError) {
      return error.status >= 499 || isCodexContextWindowError(error);
    }

    return true;
  }

  sessionIdleTimeoutMs(session) {
    if (session.isForkSession?.() === true) {
      return Math.max(
        0,
        numberOrDefault(this.config.codex.forkIdleTimeoutMs, DEFAULT_FORK_IDLE_TIMEOUT_MS)
      );
    }

    return Math.max(0, numberOrDefault(this.config.codex.idleTimeoutMs, 0));
  }

  armIdleTimer(session) {
    if (this.sessions.get(session.sessionKey) !== session) {
      return;
    }

    session.touch(this.expireSession.bind(this), this.sessionIdleTimeoutMs(session));
    void this.evictExcessIdleSessions(session).catch((error) => {
      traceLog(this.tracer, 'codex.session.max_pool_cleanup_failed', {
        session_key: session.sessionKey,
        error_message: error?.message || String(error),
      });
    });
  }

  async runSessionRequest(session, run, signal, reservation = null) {
    try {
      return await this.runWithAbort(session, run, signal);
    } catch (error) {
      if (this.isEvictableFailure(error)) {
        await this.evictSession(session.sessionKey, session, error, 'codex.session.evicted');
      }
      throw error;
    } finally {
      this.clearSessionReservation(session, reservation);
      this.armIdleTimer(session);
    }
  }

  async runWithAbort(session, run, signal) {
    if (!signal) {
      return run();
    }

    function abortError() {
      if (signal.reason instanceof GatewayError) {
        return signal.reason;
      }

      return new GatewayError(
        499,
        'api_error',
        'gateway request aborted before Codex turn completed'
      );
    }

    if (signal.aborted) {
      const error = abortError();
      await this.abortSession(session.sessionKey, error);
      throw error;
    }

    const manager = this;
    return new Promise(function waitForAbort(resolve, reject) {
      let settled = false;

      function cleanup() {
        signal.removeEventListener('abort', onAbort);
      }

      function settle(fn, value) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        fn(value);
      }

      function onAbort() {
        const error = abortError();
        void manager.abortSession(session.sessionKey, error).catch(function traceAbortFailure(closeError) {
          traceLog(manager.tracer, 'codex.session.abort_cleanup_failed', {
            session_key: session.sessionKey,
            error_message: closeError?.message || String(closeError),
          });
        });
        settle(reject, error);
      }

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      let runPromise = null;
      try {
        runPromise = Promise.resolve(run());
      } catch (error) {
        settle(reject, error);
        return;
      }

      runPromise.then(
        function resolveRequest(value) {
          settle(resolve, value);
        },
        function rejectRequest(error) {
          settle(reject, error);
        }
      );
    });
  }

  async abortSession(sessionKey, reason) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    await this.evictSession(sessionKey, session, reason, 'codex.session.aborted');
  }

  async evictSession(sessionKey, session, reason, eventName) {
    if (this.sessions.get(sessionKey) !== session) {
      return;
    }

    this.sessions.delete(sessionKey);
    traceLog(this.tracer, eventName, {
      session_key: sessionKey,
      reason: reason?.message || 'gateway request aborted',
    });
    await session.close(reason);
  }

  async expireSession(sessionKey) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionKey);
    traceLog(this.tracer, 'codex.session.expired', {
      session_key: sessionKey,
    });
    await session.close();
  }

  async evictExcessIdleSessions(protectedSession = null) {
    const maxSessions = Math.max(
      1,
      numberOrDefault(this.config.codex.maxSessions, DEFAULT_MAX_SESSIONS)
    );
    if (this.sessions.size <= maxSessions) {
      return;
    }

    const candidates = Array.from(this.sessions.entries())
      .filter(function disposableCandidate([, session]) {
        return session !== protectedSession && session.isDisposableIdle?.();
      })
      .sort(function oldestFirst(left, right) {
        return (left[1].lastUsedAt || 0) - (right[1].lastUsedAt || 0);
      });

    for (const [sessionKey, session] of candidates) {
      if (this.sessions.size <= maxSessions) {
        return;
      }

      this.sessions.delete(sessionKey);
      traceLog(this.tracer, 'codex.session.evicted_max_sessions', {
        session_key: sessionKey,
        max_sessions: maxSessions,
      });
      await session.close(
        new GatewayError(
          499,
          'api_error',
          `Codex session pool exceeded max_sessions=${maxSessions}`
        )
      );
    }
  }

  async close() {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    traceLog(this.tracer, 'codex.session_manager.closed', {
      session_count: sessions.length,
    });
    await Promise.all(
      sessions.map(function closeSession(session) {
        return session.close();
      })
    );
  }
}
