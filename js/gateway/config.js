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
const DISABLED_FLAG_VALUES = new Set(['0', 'false', 'no', 'off']);
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);

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

function optionalResolvedPath(value) {
  const configured = firstDefinedString(value);
  if (!configured) {
    return '';
  }
  return path.resolve(expandHomePath(configured));
}

function codexProfileValue(key, fallback) {
  return firstEnvString(CODEX_PROFILE_ENV[key], fallback);
}

function deepSeekProfileValue(key, fallback) {
  return firstEnvString(DEEPSEEK_PROFILE_ENV[key], fallback);
}

function deepSeekThinking() {
  const thinkingLevel = firstEnvString(['ULTRATHINK_THINKING_LEVEL']).toUpperCase();
  if (thinkingLevel === 'OFF') {
    return { type: 'disabled' };
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
    host: process.env.ULTRATHINK_GATEWAY_HOST || '127.0.0.1',
    port: clampNumber(process.env.ULTRATHINK_GATEWAY_PORT, 4318, {
      min: 1,
      max: 65535,
    }),
    traceDir: optionalResolvedPath(process.env.ULTRATHINK_GATEWAY_TRACE_DIR),
    displayRoutedModel: envFlag('ULTRATHINK_GATEWAY_DISPLAY_ROUTED_MODEL', false),
    sharedSecret: process.env.ULTRATHINK_GATEWAY_SHARED_SECRET || '',
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
      enabled: firstEnvString(['ULTRATHINK_GATEWAY_CODEX_ENABLED'], 'true') !== 'false',
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
      model: codexProfileValue('model', 'gpt-5.5'),
      reasoningEffort: codexProfileValue('reasoningEffort', 'low'),
      verbosity: codexProfileValue('verbosity', 'low'),
      inputMaxTokens: clampNumber(
        process.env.ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS,
        256_000,
        { min: 0, max: 1_000_000 }
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
      model: codexProfileValue('model', 'gpt-5.5'),
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
      thinking: deepSeekThinking(),
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
