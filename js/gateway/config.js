import net from 'node:net';
import path from 'node:path';

import '../utils/env-loader.js';
import { expandHomePath } from '../utils/safe-path.js';

const DEFAULT_EXPOSED_MODELS = Object.freeze([
  'claude-opus-4-8',
  'claude-sonnet-4-7',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
]);
const DEFAULT_ANTHROPIC_PASSTHROUGH_MODELS = Object.freeze(['claude-opus-4-8*']);

const DEFAULT_CODEX_SANDBOX = 'workspace-write';
const DEFAULT_CODEX_APPROVAL_POLICY = 'never';
const DEFAULT_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE = 'body_after_prefix';
const DISABLED_FLAG_VALUES = new Set(['0', 'false', 'no', 'off']);
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);
const CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPES = new Set(['total', 'body_after_prefix']);

const CODEX_PROFILE_ENV = Object.freeze({
  model: ['ULTRATHINK_GATEWAY_CODEX_MODEL', 'ULTRATHINK_GATEWAY_OPENAI_MODEL'],
  reasoningEffort: [
    'ULTRATHINK_GATEWAY_CODEX_REASONING_EFFORT',
    'ULTRATHINK_GATEWAY_OPENAI_REASONING_EFFORT',
  ],
  verbosity: ['ULTRATHINK_GATEWAY_CODEX_VERBOSITY', 'ULTRATHINK_GATEWAY_OPENAI_VERBOSITY'],
});
const DEEPSEEK_PROFILE_ENV = Object.freeze({
  model: ['ULTRATHINK_GATEWAY_DEEPSEEK_MODEL', 'DEEPSEEK_DEFAULT_MODEL_ID'],
  reasoningEffort: [
    'ULTRATHINK_GATEWAY_DEEPSEEK_REASONING_EFFORT',
    'ULTRATHINK_DEEPSEEK_REASONING_EFFORT',
  ],
});
const GLM_PROFILE_ENV = Object.freeze({
  model: ['ULTRATHINK_GATEWAY_GLM_MODEL', 'GLM_DEFAULT_MODEL_ID', 'ZAI_DEFAULT_MODEL_ID'],
  reasoningEffort: [
    'ULTRATHINK_GATEWAY_GLM_REASONING_EFFORT',
    'ULTRATHINK_GLM_REASONING_EFFORT',
    'ZAI_REASONING_EFFORT',
  ],
});

function firstDefinedString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

function firstEnvString(envNames, fallback = '') {
  const values = envNames.map(function readEnv(name) {
    return process.env[name];
  });
  return firstDefinedString(...values, fallback);
}

export function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  return !DISABLED_FLAG_VALUES.has(value.trim().toLowerCase());
}

function clampNumber(value, fallback, options = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  const min = Number.isFinite(options.min) ? options.min : number;
  const max = Number.isFinite(options.max) ? options.max : number;
  return Math.trunc(Math.max(min, Math.min(number, max)));
}

function splitCsv(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback.slice();
  }

  return value
    .split(',')
    .map(function trimPart(part) {
      return part.trim();
    })
    .filter(Boolean);
}

function parseRouteMap(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return {};
  }

  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'ULTRATHINK_GATEWAY_ROUTE_MAP_JSON must be a JSON object keyed by exposed model id'
    );
  }

  return parsed;
}

function optionalTracePath(value) {
  const configured = firstDefinedString(value);
  if (!configured) {
    return '';
  }
  if (DISABLED_FLAG_VALUES.has(configured.toLowerCase())) {
    return '';
  }
  return path.resolve(expandHomePath(configured));
}

function codexAutoCompactTokenLimitScope(value) {
  const normalized = firstDefinedString(
    value,
    DEFAULT_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE
  ).toLowerCase();
  if (!CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPES.has(normalized)) {
    throw new Error(
      'ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE must be total or body_after_prefix'
    );
  }

  return normalized;
}

function codexProfileValue(key, fallback) {
  return firstEnvString(CODEX_PROFILE_ENV[key], fallback);
}

function deepSeekProfileValue(key, fallback) {
  return firstEnvString(DEEPSEEK_PROFILE_ENV[key], fallback);
}

function glmProfileValue(key, fallback) {
  return firstEnvString(GLM_PROFILE_ENV[key], fallback);
}

function thinkingForProvider(provider) {
  const thinkingLevel = firstEnvString(['ULTRATHINK_THINKING_LEVEL']).toUpperCase();
  if (thinkingLevel === 'OFF') {
    return { type: 'disabled' };
  }

  if (provider === 'glm') {
    return {
      type: 'enabled',
      clear_thinking: false,
    };
  }

  return { type: 'enabled' };
}

export function isGatewayLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) {
    return true;
  }

  return net.isIP(normalized) === 4 && normalized.startsWith('127.');
}

export function loadGatewayConfig() {
  const routeMap = parseRouteMap(process.env.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON);
  const exactRouteMapModels = Object.keys(routeMap).filter(function isExactRouteKey(modelId) {
    return !modelId.endsWith('*');
  });
  const defaultExposedModels =
    exactRouteMapModels.length > 0 ? exactRouteMapModels : DEFAULT_EXPOSED_MODELS;

  return {
    host: firstDefinedString(process.env.ULTRATHINK_GATEWAY_HOST, '127.0.0.1'),
    port: clampNumber(process.env.ULTRATHINK_GATEWAY_PORT, 4319, {
      min: 1,
      max: 65535,
    }),
    traceDir: optionalTracePath(process.env.ULTRATHINK_GATEWAY_TRACE_DIR),
    traceMaxBytes: clampNumber(
      process.env.ULTRATHINK_GATEWAY_TRACE_MAX_BYTES,
      8 * 1024 * 1024,
      { min: 256, max: 1024 * 1024 * 1024 }
    ),
    traceMaxFiles: clampNumber(process.env.ULTRATHINK_GATEWAY_TRACE_MAX_FILES, 3, {
      min: 1,
      max: 16,
    }),
    runtimeRevision: firstDefinedString(process.env.ULTRATHINK_GATEWAY_RUNTIME_REVISION),
    runtimeStartedAt: firstDefinedString(
      process.env.ULTRATHINK_GATEWAY_RUNTIME_STARTED_AT,
      new Date().toISOString()
    ),
    displayRoutedModel: envFlag('ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL', false),
    sharedSecret: firstDefinedString(process.env.ULTRATHINK_GATEWAY_SHARED_SECRET),
    requestTimeoutMs: clampNumber(
      process.env.ULTRATHINK_GATEWAY_REQUEST_TIMEOUT_MS,
      5 * 60_000,
      { min: 1_000, max: 30 * 60_000 }
    ),
    exposedModels: splitCsv(process.env.ULTRATHINK_GATEWAY_EXPOSED_MODELS, defaultExposedModels),
    routeMap,
    anthropicPassthroughModels: splitCsv(
      firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS,
        process.env.ULTRATHINK_GATEWAY_PASSTHROUGH_MODEL_IDS
      ),
      DEFAULT_ANTHROPIC_PASSTHROUGH_MODELS
    ),
    codex: {
      enabled: envFlag('ULTRATHINK_GATEWAY_CODEX_ENABLED', true),
      command: firstEnvString(['ULTRATHINK_GATEWAY_CODEX_COMMAND'], 'codex'),
      cwd: path.resolve(
        expandHomePath(
          firstEnvString(['ULTRATHINK_GATEWAY_CODEX_CWD'], process.cwd())
        )
      ),
      sandbox: firstEnvString(
        ['ULTRATHINK_GATEWAY_CODEX_SANDBOX'],
        DEFAULT_CODEX_SANDBOX
      ),
      approvalPolicy: firstEnvString(
        ['ULTRATHINK_GATEWAY_CODEX_APPROVAL_POLICY'],
        DEFAULT_CODEX_APPROVAL_POLICY
      ),
      model: codexProfileValue('model', 'gpt-5.6-terra'),
      reasoningEffort: codexProfileValue('reasoningEffort', 'max'),
      verbosity: codexProfileValue('verbosity', 'low'),
      inputMaxTokens: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS,
        192_000,
        { min: 0, max: 1_000_000 }
      ),
      toolResultMaxBytes: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_MAX_BYTES,
        10_000,
        { min: 0, max: 10_000_000 }
      ),
      toolResultWindowMaxBytes: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_TOOL_RESULT_WINDOW_MAX_BYTES,
        64_000,
        { min: 0, max: 100_000_000 }
      ),
      autoCompactTokenLimit: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT,
        0,
        { min: 0, max: 1_000_000 }
      ),
      autoCompactTokenLimitScope: codexAutoCompactTokenLimitScope(
        process.env.ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT_SCOPE
      ),
      idleTimeoutMs: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_IDLE_TIMEOUT_MS,
        10 * 60_000,
        { min: 0, max: 24 * 60 * 60_000 }
      ),
      forkIdleTimeoutMs: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_FORK_IDLE_TIMEOUT_MS,
        30_000,
        { min: 0, max: 24 * 60 * 60_000 }
      ),
      pendingToolTimeoutMs: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_PENDING_TOOL_TIMEOUT_MS,
        10 * 60_000,
        { min: 0, max: 24 * 60 * 60_000 }
      ),
      maxSessions: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_MAX_SESSIONS,
        16,
        { min: 1, max: 256 }
      ),
      closeKillTimeoutMs: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_CLOSE_KILL_TIMEOUT_MS,
        2_000,
        { min: 100, max: 60_000 }
      ),
    },
    openai: {
      apiKey: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_CODEX_API_KEY,
        process.env.ULTRATHINK_GATEWAY_OPENAI_API_KEY,
        process.env.OPENAI_API_KEY,
        ''
      ),
      baseUrl: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_CODEX_BASE_URL,
        process.env.ULTRATHINK_GATEWAY_OPENAI_BASE_URL,
        'https://api.openai.com/v1'
      ),
      model: codexProfileValue('model', 'gpt-5.6-terra'),
      reasoningEffort: codexProfileValue('reasoningEffort', 'low'),
      verbosity: codexProfileValue('verbosity', 'low'),
    },
    deepseek: {
      apiKey: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY,
        process.env.DEEPSEEK_API_KEY,
        ''
      ),
      baseUrl: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_DEEPSEEK_BASE_URL,
        process.env.DEEPSEEK_BASE_URL,
        'https://api.deepseek.com'
      ),
      model: deepSeekProfileValue('model', 'deepseek-v4-pro'),
      reasoningEffort: deepSeekProfileValue('reasoningEffort', 'max'),
      thinking: thinkingForProvider('deepseek'),
    },
    glm: {
      apiKey: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_GLM_API_KEY,
        process.env.ZAI_API_KEY,
        process.env.GLM_API_KEY,
        ''
      ),
      baseUrl: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_GLM_BASE_URL,
        process.env.ZAI_BASE_URL,
        process.env.GLM_BASE_URL,
        'https://api.z.ai/api/coding/paas/v4'
      ),
      model: glmProfileValue('model', 'glm-5.2'),
      reasoningEffort: glmProfileValue('reasoningEffort', 'max'),
      thinking: thinkingForProvider('glm'),
    },
    anthropic: {
      apiKey: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY,
        process.env.ANTHROPIC_API_KEY,
        ''
      ),
      baseUrl: firstDefinedString(
        process.env.ULTRATHINK_GATEWAY_ANTHROPIC_BASE_URL,
        'https://api.anthropic.com'
      ),
      version: firstEnvString(['ULTRATHINK_GATEWAY_ANTHROPIC_VERSION'], '2023-06-01'),
    },
  };
}
