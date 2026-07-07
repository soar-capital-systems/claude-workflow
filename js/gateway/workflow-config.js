/**
 * Shared Claude-workflow gateway configuration.
 *
 * Builds the routing config used by both the per-session `claude-workflow`
 * launcher and the shared `claude-workflow-gateway` daemon: the frontier main
 * model stays on Anthropic passthrough while workflow/subagent traffic and
 * every other Claude model id route to Codex-backed profiles.
 */
import process from 'node:process';

import { envFlag, loadGatewayConfig } from './config.js';
import {
  ROUTE_ENTRY_REASONING_KEYS,
  ROUTE_ENTRY_UPSTREAM_MODEL_KEYS,
  modelIdWithoutBracketQualifiers,
  routeEntryValue,
} from './model-routing.js';
import { proxyExclusionEnvForHost } from './proxy.js';

const WORKFLOW_CODEX_IDLE_TIMEOUT_MS = 120_000;
// Workflow-profile ceiling for the Codex input budget. The codex provider also
// caps this against the live app-server window when one is reported.
const WORKFLOW_CODEX_INPUT_MAX_TOKENS = 180_000;
const WORKFLOW_CODEX_AUTO_COMPACT_NUMERATOR = 7;
const WORKFLOW_CODEX_AUTO_COMPACT_DENOMINATOR = 10;
const GLM_AUTO_COMPACT_WINDOW = '1000000';
const DEFAULT_MAIN_MODEL_ID = 'claude-fable-5[1m]';
const DEFAULT_FABLE_PASSTHROUGH_PATTERN = 'claude-fable-5*';

export function envString(name, fallback = '') {
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

function workflowAutoCompactTokenLimit(inputMaxTokens) {
  const tokens = Number(inputMaxTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return 0;
  }

  const scaledTokens =
    (tokens * WORKFLOW_CODEX_AUTO_COMPACT_NUMERATOR) / WORKFLOW_CODEX_AUTO_COMPACT_DENOMINATOR;
  return Math.max(1, Math.floor(scaledTokens));
}

function defaultAnthropicPassthroughPattern(mainModelId) {
  if (String(mainModelId || '').startsWith('claude-fable-5')) {
    return DEFAULT_FABLE_PASSTHROUGH_PATTERN;
  }

  return `${mainModelId}*`;
}

function routeModelAliases(modelId) {
  const normalized = typeof modelId === 'string' ? modelId.trim() : '';
  const strippedBracketQualifiers = modelIdWithoutBracketQualifiers(normalized);
  return dedupeStrings([normalized, strippedBracketQualifiers]);
}

function isFableModelAlias(modelId) {
  return modelId.startsWith('claude-fable-5');
}

function routeModelPatterns(modelId) {
  const aliases = routeModelAliases(modelId);
  if (aliases.some(isFableModelAlias)) {
    return dedupeStrings([...aliases, DEFAULT_FABLE_PASSTHROUGH_PATTERN]);
  }

  return aliases;
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

export function routeProvider(route, fallback = 'codex') {
  return routeEntryValue(route, ['provider'], fallback);
}

function routeUpstreamModel(route, fallback) {
  return routeEntryValue(route, ROUTE_ENTRY_UPSTREAM_MODEL_KEYS, fallback);
}

function routeReasoningEffort(route, fallback = '') {
  return routeEntryValue(route, ROUTE_ENTRY_REASONING_KEYS, fallback);
}

function normalizedRouteProvider(value, fallback = 'anthropic') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function mainRouteDefaultModel(provider, mainModelId, baseConfig) {
  switch (provider) {
    case 'anthropic':
      return modelIdWithoutBracketQualifiers(mainModelId);
    case 'codex':
      return baseConfig.codex.model;
    case 'deepseek':
      return baseConfig.deepseek.model;
    case 'glm':
      return baseConfig.glm.model;
    case 'openai':
      return baseConfig.openai.model;
    default:
      return mainModelId;
  }
}

function mainRouteDefaultReasoningEffort(provider, baseConfig) {
  switch (provider) {
    case 'codex':
      return baseConfig.codex.reasoningEffort;
    case 'deepseek':
      return baseConfig.deepseek.reasoningEffort;
    case 'glm':
      return baseConfig.glm.reasoningEffort;
    case 'openai':
      return baseConfig.openai.reasoningEffort;
    default:
      return '';
  }
}

function mainRouteDisplayName(provider) {
  switch (provider) {
    case 'anthropic':
      return 'Claude Workflow Frontier Route';
    case 'codex':
      return 'Codex Main Route';
    case 'deepseek':
      return 'DeepSeek Main Route';
    case 'glm':
      return 'GLM Main Route';
    case 'openai':
      return 'OpenAI-Compatible Main Route';
    default:
      return 'Claude Workflow Main Route';
  }
}

function routedModelId(provider, upstreamModel, reasoningEffort, requestedModel) {
  const effort = reasoningEffort ? `-${modelIdPart(reasoningEffort)}` : '';
  return [
    `${modelIdPart(provider)}-${modelIdPart(upstreamModel)}${effort}`,
    modelIdPart(requestedModel),
  ].join('-via-');
}

export function routeTargetSummary(route) {
  const provider = routeProvider(route);
  if (provider === 'anthropic') {
    return 'anthropic';
  }

  const model = routeUpstreamModel(route, 'default');
  const effort = routeReasoningEffort(route);
  return `${provider}:${model}${effort ? `/${effort}` : ''}`;
}

function parseRequestedPort(defaultPort = 0) {
  const configuredPort = envString('ULTRATHINK_GATEWAY_PORT');
  if (!configuredPort) {
    return defaultPort;
  }

  const parsed = Number(configuredPort);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(
      `ULTRATHINK_GATEWAY_PORT must be an integer between 0 and 65535, got ${configuredPort}`
    );
  }

  return parsed;
}

export function buildWorkflowGatewayConfig({ defaultPort = 0, port = null } = {}) {
  const baseConfig = loadGatewayConfig();
  const mainModelId = envString('ULTRATHINK_GATEWAY_MAIN_MODEL_ID', DEFAULT_MAIN_MODEL_ID);
  const mainProvider = normalizedRouteProvider(
    envString('ULTRATHINK_GATEWAY_MAIN_PROVIDER', envString('CLAUDE_WORKFLOW_MAIN_PROVIDER'))
  );
  const mainUpstreamModel = envString(
    'ULTRATHINK_GATEWAY_MAIN_UPSTREAM_MODEL',
    mainRouteDefaultModel(mainProvider, mainModelId, baseConfig)
  );
  const mainReasoningEffort = envString(
    'ULTRATHINK_GATEWAY_MAIN_REASONING_EFFORT',
    mainRouteDefaultReasoningEffort(mainProvider, baseConfig)
  );
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
    provider: mainProvider,
    model: mainUpstreamModel,
    ...(mainReasoningEffort ? { reasoningEffort: mainReasoningEffort } : {}),
    displayName: mainRouteDisplayName(mainProvider),
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
  const codexInputMaxTokens = envString('ULTRATHINK_GATEWAY_CODEX_INPUT_MAX_TOKENS')
    ? baseConfig.codex.inputMaxTokens
    : WORKFLOW_CODEX_INPUT_MAX_TOKENS;
  const codexAutoCompactTokenLimit = envString(
    'ULTRATHINK_GATEWAY_CODEX_AUTO_COMPACT_TOKEN_LIMIT'
  )
    ? baseConfig.codex.autoCompactTokenLimit
    : workflowAutoCompactTokenLimit(codexInputMaxTokens);
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
  const mainRouteMap = Object.fromEntries(
    routeModelPatterns(mainModelId).map(function mapMainRoute(modelId) {
      return [modelId, defaultMainRoute];
    })
  );
  const routeMap = {
    [rawSubagentModelId]: defaultSubagentRoute,
    [subagentModelId]: subagentRoute,
    ...mainRouteMap,
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
      port: port ?? parseRequestedPort(defaultPort),
      displayRoutedModel: displayModels,
      routeMap,
      anthropicPassthroughModels,
      codex: {
        ...baseConfig.codex,
        idleTimeoutMs: envString('ULTRATHINK_GATEWAY_CODEX_IDLE_TIMEOUT_MS')
          ? baseConfig.codex.idleTimeoutMs
          : WORKFLOW_CODEX_IDLE_TIMEOUT_MS,
        inputMaxTokens: codexInputMaxTokens,
        autoCompactTokenLimit: codexAutoCompactTokenLimit,
      },
      exposedModels: dedupeStrings([
        ...routeModelAliases(mainModelId),
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

export function buildWorkflowClientEnv(config, gatewayBaseUrl, subagentModelId) {
  const clientEnv = {
    ...proxyExclusionEnvForHost(config.host),
    ...buildWorkflowClaudeEnv(gatewayBaseUrl, subagentModelId),
  };

  if (routeMapUsesProvider(config, 'glm') && !envString('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) {
    clientEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = GLM_AUTO_COMPACT_WINDOW;
  }

  if (config.sharedSecret) {
    clientEnv.ANTHROPIC_AUTH_TOKEN = config.sharedSecret;
    clientEnv.ANTHROPIC_API_KEY = config.sharedSecret;
  }

  return clientEnv;
}

function routeMapUsesProvider(config, provider) {
  return Object.values(config.routeMap || {}).some(function hasProvider(route) {
    return routeProvider(route, '') === provider;
  });
}

export function buildWorkflowClaudeEnv(gatewayBaseUrl, subagentModelId) {
  return {
    ANTHROPIC_BASE_URL: gatewayBaseUrl,
    CLAUDE_CODE_SUBAGENT_MODEL: subagentModelId,
    // Newer Claude Code resolves agent-definition models through the
    // sonnet/haiku/opus alias slots and shows those labels in the TUI.
    // Remap the slots to the routed subagent model id so alias-pinned
    // agents display and request the Codex-backed id instead of raw
    // Anthropic sonnet/haiku ids. User-provided values win.
    ANTHROPIC_DEFAULT_SONNET_MODEL: envString(
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      subagentModelId
    ),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: envString(
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      subagentModelId
    ),
    ANTHROPIC_DEFAULT_OPUS_MODEL: envString(
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      subagentModelId
    ),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: envString(
      'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
      '0'
    ),
  };
}
