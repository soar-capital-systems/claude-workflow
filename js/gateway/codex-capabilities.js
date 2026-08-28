import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { environmentWithoutGatewayAndAnthropicCredentials } from '../utils/child-env.js';

const DEFAULT_RAW_CONTEXT_TOKENS = 272_000;
const DEFAULT_MAX_RAW_CONTEXT_TOKENS = 272_000;
const DEFAULT_EFFECTIVE_CONTEXT_PERCENT = 95;
const CODEX_NATIVE_COMPACT_PERCENT = 90;
const GATEWAY_OUTPUT_RESERVE_TOKENS = 64_000;
const GATEWAY_PROMPT_HEADROOM_TOKENS = 32_000;
const CATALOG_TIMEOUT_MS = 5_000;
const CATALOG_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_TOOL_OUTPUT_TRUNCATION_POLICY = Object.freeze({
  mode: 'bytes',
  limit: 10_000,
});
const KNOWN_TOOL_OUTPUT_TRUNCATION_POLICY = Object.freeze({
  mode: 'tokens',
  limit: 10_000,
});

const KNOWN_MODEL_CAPABILITIES = Object.freeze({
  'gpt-5.4': Object.freeze({
    contextWindow: 272_000,
    maxContextWindow: 1_000_000,
    effectiveContextWindowPercent: 95,
    reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh']),
    toolOutputTruncationPolicy: KNOWN_TOOL_OUTPUT_TRUNCATION_POLICY,
  }),
  'gpt-5.6-sol': Object.freeze({
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    effectiveContextWindowPercent: 95,
    reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    toolOutputTruncationPolicy: KNOWN_TOOL_OUTPUT_TRUNCATION_POLICY,
  }),
  'gpt-5.6-terra': Object.freeze({
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    effectiveContextWindowPercent: 95,
    reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
    toolOutputTruncationPolicy: KNOWN_TOOL_OUTPUT_TRUNCATION_POLICY,
  }),
  'gpt-5.6-luna': Object.freeze({
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    effectiveContextWindowPercent: 95,
    reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    toolOutputTruncationPolicy: KNOWN_TOOL_OUTPUT_TRUNCATION_POLICY,
  }),
});

const catalogCache = new Map();

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.trunc(number);
}

function percent(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100) {
    return fallback;
  }
  return number;
}

function normalizedToolOutputTruncationPolicy(value, fallback = null) {
  const mode = String(value?.mode || '').trim().toLowerCase();
  const limit = positiveInteger(value?.limit, 0);
  if ((mode !== 'tokens' && mode !== 'bytes') || !limit) {
    return fallback ? { ...fallback } : null;
  }

  return { mode, limit };
}

function parseCatalog(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    return [];
  }

  // `codex debug models` owns stdout and emits one JSON document. Parse that
  // document strictly so indentation is harmless but trailing diagnostics or
  // a second payload cannot be mistaken for trusted model metadata.
  const parsed = JSON.parse(text);
  return Array.isArray(parsed?.models) ? parsed.models : [];
}

function readCatalog(command, cwd, env, bundledOnly) {
  const catalogCwd = path.resolve(String(cwd || process.cwd()));
  const cacheKey = `${command}\u0000${catalogCwd}\u0000${env?.CODEX_HOME || ''}\u0000${bundledOnly ? 'bundled' : 'online'}`;
  if (catalogCache.has(cacheKey)) {
    return catalogCache.get(cacheKey);
  }

  const args = ['debug', 'models'];
  if (bundledOnly) {
    args.push('--bundled');
  }
  const result = spawnSync(command, args, {
    cwd: catalogCwd,
    encoding: 'utf8',
    // Model discovery is local metadata lookup. Never expose unrelated
    // provider or gateway credentials to the Codex subprocess.
    env: environmentWithoutGatewayAndAnthropicCredentials(env),
    maxBuffer: CATALOG_MAX_BUFFER_BYTES,
    shell: process.platform === 'win32',
    timeout: CATALOG_TIMEOUT_MS,
    windowsHide: true,
  });
  let catalog = null;
  if (!result.error && result.status === 0) {
    try {
      catalog = parseCatalog(result.stdout);
    } catch {
      catalog = null;
    }
  }
  catalogCache.set(cacheKey, catalog);
  return catalog;
}

function normalizedCatalogModel(model) {
  if (!model || typeof model !== 'object') {
    return null;
  }
  const contextWindow = positiveInteger(model.context_window, 0);
  if (!contextWindow) {
    return null;
  }

  return {
    contextWindow,
    maxContextWindow: positiveInteger(model.max_context_window, contextWindow),
    effectiveContextWindowPercent: percent(
      model.effective_context_window_percent,
      DEFAULT_EFFECTIVE_CONTEXT_PERCENT
    ),
    reasoningEfforts: Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
          .map((entry) => String(entry?.effort || '').trim().toLowerCase())
          .filter(Boolean)
      : [],
    toolOutputTruncationPolicy: normalizedToolOutputTruncationPolicy(
      model.truncation_policy,
      DEFAULT_TOOL_OUTPUT_TRUNCATION_POLICY
    ),
  };
}

function modelCapabilities(command, cwd, model, env) {
  // The installed binary's bundled catalog is deterministic and typically
  // loads in milliseconds. Only ask Codex to refresh its online catalog when
  // the selected model is absent, which keeps normal Claude startup off the
  // network while preserving support for remotely introduced models.
  const bundledCatalog = readCatalog(command, cwd, env, true);
  let catalogModel = bundledCatalog?.find((entry) => entry?.slug === model);
  if (!catalogModel) {
    const onlineCatalog = readCatalog(command, cwd, env, false);
    catalogModel = onlineCatalog?.find((entry) => entry?.slug === model);
  }
  const discovered = normalizedCatalogModel(catalogModel);
  if (discovered) {
    return { ...discovered, source: 'codex-catalog' };
  }

  const known = KNOWN_MODEL_CAPABILITIES[model];
  if (known) {
    return {
      ...known,
      reasoningEfforts: [...known.reasoningEfforts],
      toolOutputTruncationPolicy: { ...known.toolOutputTruncationPolicy },
      source: 'known-model',
    };
  }

  return {
    contextWindow: DEFAULT_RAW_CONTEXT_TOKENS,
    maxContextWindow: DEFAULT_MAX_RAW_CONTEXT_TOKENS,
    effectiveContextWindowPercent: DEFAULT_EFFECTIVE_CONTEXT_PERCENT,
    reasoningEfforts: [],
    toolOutputTruncationPolicy: { ...DEFAULT_TOOL_OUTPUT_TRUNCATION_POLICY },
    source: 'conservative-fallback',
  };
}

export function normalizeCodexContextProfile(value, fallback = 'standard') {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (normalized === 'standard' || normalized === 'long') {
    return normalized;
  }
  throw new Error('ULTRATHINK_GATEWAY_CODEX_CONTEXT must be standard or long');
}

export function resolveCodexCapabilities({
  command = 'codex',
  cwd = process.cwd(),
  model,
  contextProfile = 'standard',
  requestedContextWindow = 0,
  reasoningEffort = '',
  env = process.env,
} = {}) {
  const normalizedModel = String(model || '').trim();
  const profile = normalizeCodexContextProfile(contextProfile);
  const available = modelCapabilities(command, cwd, normalizedModel, env);
  const requested = positiveInteger(
    requestedContextWindow,
    profile === 'long' ? available.maxContextWindow : available.contextWindow
  );
  const resolvedRawContextTokens = Math.min(requested, available.maxContextWindow);
  const usableContextTokens = Math.floor(
    (resolvedRawContextTokens * available.effectiveContextWindowPercent) / 100
  );
  const autoCompactTokens = Math.min(
    usableContextTokens,
    Math.floor((resolvedRawContextTokens * CODEX_NATIVE_COMPACT_PERCENT) / 100)
  );
  const inputBudgetTokens = Math.max(
    1,
    Math.min(
      autoCompactTokens - GATEWAY_PROMPT_HEADROOM_TOKENS,
      usableContextTokens - GATEWAY_OUTPUT_RESERVE_TOKENS
    )
  );
  const normalizedEffort = String(reasoningEffort || '').trim().toLowerCase();
  const effortSupported =
    !normalizedEffort ||
    available.reasoningEfforts.length === 0 ||
    available.reasoningEfforts.includes(normalizedEffort);

  return Object.freeze({
    model: normalizedModel,
    profile,
    source: available.source,
    requestedRawContextTokens: requested,
    resolvedRawContextTokens,
    usableContextTokens,
    autoCompactTokens,
    inputBudgetTokens,
    maxRawContextTokens: available.maxContextWindow,
    effectiveContextWindowPercent: available.effectiveContextWindowPercent,
    reasoningEfforts: Object.freeze([...available.reasoningEfforts]),
    toolOutputTruncationPolicy: Object.freeze({
      ...available.toolOutputTruncationPolicy,
    }),
    effortSupported,
  });
}

export function clearCodexCapabilityCacheForTests() {
  catalogCache.clear();
}
