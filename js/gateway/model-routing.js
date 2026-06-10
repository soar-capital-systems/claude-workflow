function formatClaudeFamily(modelId) {
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    return 'Claude model';
  }

  return modelId
    .split('-')
    .map(function normalizePart(part) {
      if (/^\d/u.test(part)) {
        return part;
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

export class GatewayError extends Error {
  constructor(status, type, message) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.type = type;
  }
}

const ROUTE_PROVIDERS = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  CODEX: 'codex',
});

const ROUTE_PROVIDER_BUILDERS = Object.freeze({
  [ROUTE_PROVIDERS.ANTHROPIC]: buildAnthropicRoute,
  [ROUTE_PROVIDERS.OPENAI]: buildOpenAiRoute,
  [ROUTE_PROVIDERS.CODEX]: buildCodexRoute,
});

export const ROUTE_ENTRY_UPSTREAM_MODEL_KEYS = Object.freeze([
  'upstreamModel',
  'upstream_model',
  'model',
]);
export const ROUTE_ENTRY_REASONING_KEYS = Object.freeze([
  'reasoningEffort',
  'reasoning_effort',
]);
const ROUTE_ENTRY_DISPLAY_NAME_KEYS = Object.freeze([
  'displayName',
  'display_name',
]);

const VALID_CODEX_SANDBOXES = Object.freeze([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
const VALID_CODEX_APPROVAL_POLICIES = Object.freeze([
  'untrusted',
  'on-failure',
  'on-request',
  'never',
]);

const DEFAULT_CODEX_SANDBOX = 'workspace-write';
const DEFAULT_CODEX_APPROVAL_POLICY = 'never';
const DEFAULT_ANTHROPIC_PASSTHROUGH_MODELS = Object.freeze(['claude-opus-4-8*']);

function routeValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

export function routeEntryValue(entry, keys, ...fallbacks) {
  const values = keys.map(function readKey(key) {
    return entry?.[key];
  });
  return routeValue(...values, ...fallbacks);
}

function formatAllowedValues(values) {
  return values.map(function quoteValue(value) {
    return `"${value}"`;
  }).join(', ');
}

function validateCodexRouteOption(modelId, optionName, value, validValues) {
  if (!value) {
    return '';
  }

  if (validValues.includes(value)) {
    return value;
  }

  throw new GatewayError(
    500,
    'api_error',
    `Codex route for ${modelId} must set ${optionName} to ${formatAllowedValues(validValues)}`
  );
}

function buildDisplayName(modelId, entry, fallback) {
  return routeEntryValue(entry, ROUTE_ENTRY_DISPLAY_NAME_KEYS, fallback);
}

function routeMapEntry(modelId, config) {
  const routeMap = config.routeMap || {};
  const entry = routeMap[modelId];
  if (entry === undefined) {
    return null;
  }

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new GatewayError(
      500,
      'api_error',
      `ULTRATHINK_GATEWAY_ROUTE_MAP_JSON entry for ${modelId} must be an object`
    );
  }

  return entry;
}

function buildAnthropicRoute(modelId, config, entry = null) {
  const upstreamModel = routeEntryValue(entry, ROUTE_ENTRY_UPSTREAM_MODEL_KEYS, modelId);

  return {
    provider: ROUTE_PROVIDERS.ANTHROPIC,
    requestedModel: modelId,
    upstreamModel,
    displayName: buildDisplayName(modelId, entry, `${formatClaudeFamily(modelId)} direct`),
  };
}

function buildOpenAiRoute(modelId, config, entry = null) {
  if (!config.openai.apiKey) {
    throw new GatewayError(
      500,
      'api_error',
      'Codex-targeted OpenAI routing is configured but ULTRATHINK_GATEWAY_CODEX_API_KEY, ULTRATHINK_GATEWAY_OPENAI_API_KEY, or OPENAI_API_KEY is missing'
    );
  }

  const upstreamModel = routeEntryValue(
    entry,
    ROUTE_ENTRY_UPSTREAM_MODEL_KEYS,
    config.openai.model
  );
  const reasoningEffort = routeEntryValue(
    entry,
    ROUTE_ENTRY_REASONING_KEYS,
    config.openai.reasoningEffort
  );
  const verbosity = routeValue(entry?.verbosity, config.openai.verbosity);

  return {
    provider: ROUTE_PROVIDERS.OPENAI,
    requestedModel: modelId,
    upstreamModel,
    reasoningEffort,
    verbosity,
    displayName: buildDisplayName(
      modelId,
      entry,
      `${formatClaudeFamily(modelId)} via Codex profile ${upstreamModel}/${reasoningEffort}`
    ),
  };
}

function buildCodexRoute(modelId, config, entry = null) {
  if (!config.codex?.enabled) {
    throw new GatewayError(
      500,
      'api_error',
      'Codex routing is disabled. Set ULTRATHINK_GATEWAY_CODEX_ENABLED=true to enable it.'
    );
  }

  const upstreamModel = routeEntryValue(
    entry,
    ROUTE_ENTRY_UPSTREAM_MODEL_KEYS,
    config.codex.model
  );
  const sandbox = validateCodexRouteOption(
    modelId,
    'sandbox',
    routeValue(entry?.sandbox, config.codex.sandbox, DEFAULT_CODEX_SANDBOX),
    VALID_CODEX_SANDBOXES
  );
  const approvalPolicy = validateCodexRouteOption(
    modelId,
    'approvalPolicy',
    routeValue(
      entry?.approvalPolicy,
      entry?.approval_policy,
      config.codex.approvalPolicy,
      DEFAULT_CODEX_APPROVAL_POLICY
    ),
    VALID_CODEX_APPROVAL_POLICIES
  );
  const reasoningEffort = routeEntryValue(
    entry,
    ROUTE_ENTRY_REASONING_KEYS,
    config.codex.reasoningEffort
  );
  const verbosity = routeValue(entry?.verbosity, config.codex.verbosity);

  return {
    provider: ROUTE_PROVIDERS.CODEX,
    requestedModel: modelId,
    upstreamModel,
    sandbox,
    approvalPolicy,
    reasoningEffort,
    verbosity,
    displayName: buildDisplayName(
      modelId,
      entry,
      `${formatClaudeFamily(modelId)} via Codex ${upstreamModel}/${reasoningEffort}`
    ),
  };
}

function configuredProvider(entry, modelId) {
  const provider = routeValue(entry?.provider).toLowerCase();
  if (provider in ROUTE_PROVIDER_BUILDERS) {
    return provider;
  }

  throw new GatewayError(
    500,
    'api_error',
    `ULTRATHINK_GATEWAY_ROUTE_MAP_JSON entry for ${modelId} must set provider to "codex", "openai", or "anthropic"`
  );
}

export function isOpusPassthroughModel(modelId) {
  return matchesModelPattern(modelId, 'claude-opus-4-8*');
}

function matchesModelPattern(modelId, pattern) {
  if (
    typeof modelId !== 'string' ||
    typeof pattern !== 'string' ||
    modelId.trim() === '' ||
    pattern.trim() === ''
  ) {
    return false;
  }

  const normalizedPattern = pattern.trim();
  if (normalizedPattern.endsWith('*')) {
    return modelId.startsWith(normalizedPattern.slice(0, -1));
  }

  return modelId === normalizedPattern;
}

export function isAnthropicPassthroughModel(modelId, config) {
  const configuredModels = Array.isArray(config?.anthropicPassthroughModels)
    ? config.anthropicPassthroughModels
    : [];
  const passthroughModels =
    configuredModels.length > 0
      ? configuredModels
      : DEFAULT_ANTHROPIC_PASSTHROUGH_MODELS;

  return passthroughModels.some(function matchesPassthroughModel(pattern) {
    return matchesModelPattern(modelId, pattern);
  });
}

export function resolveModelRoute(modelId, config) {
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    throw new GatewayError(
      400,
      'invalid_request_error',
      'messages requests must include a non-empty model id'
    );
  }

  const configuredRoute = routeMapEntry(modelId, config);
  if (configuredRoute) {
    const provider = configuredProvider(configuredRoute, modelId);
    return ROUTE_PROVIDER_BUILDERS[provider](modelId, config, configuredRoute);
  }

  if (isAnthropicPassthroughModel(modelId, config)) {
    return buildAnthropicRoute(modelId, config);
  }

  if (config.codex?.enabled) {
    return buildCodexRoute(modelId, config);
  }

  return buildOpenAiRoute(modelId, config);
}

function resolveModelRouteForDiscovery(modelId, config) {
  try {
    return resolveModelRoute(modelId, config);
  } catch (error) {
    if (error instanceof GatewayError) {
      return {
        provider: 'unavailable',
        displayName: `${formatClaudeFamily(modelId)} unavailable`,
      };
    }
    throw error;
  }
}

export function listGatewayModels(config) {
  return config.exposedModels.map(function buildModel(exposedModelId) {
    const route = resolveModelRouteForDiscovery(exposedModelId, config);
    return {
      type: 'model',
      id: exposedModelId,
      display_name: route.displayName,
    };
  });
}
