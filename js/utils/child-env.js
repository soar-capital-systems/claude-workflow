import process from 'node:process';

import { GATEWAY_PROVIDER_CREDENTIAL_ENV_NAMES } from '../gateway/provider-profiles.js';

export const GATEWAY_ONLY_CREDENTIAL_ENV_NAMES = Object.freeze([
  ...GATEWAY_PROVIDER_CREDENTIAL_ENV_NAMES,
  'ULTRATHINK_GATEWAY_SHARED_SECRET',
]);

export const MANAGED_GATEWAY_AUTH_ENV_NAME =
  'CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN';
export const CLAUDE_TERMINAL_TITLE_ENV_NAME =
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE';
export const MANAGED_TERMINAL_TITLE_ENV_NAME =
  'CLAUDE_WORKFLOW_GATEWAY_MANAGED_TERMINAL_TITLE';
export const PREVIOUS_TERMINAL_TITLE_ENV_NAME =
  'CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE';
export const PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME =
  'CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_TERMINAL_TITLE_SET';
export const MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME =
  'CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_NAMES';
export const MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME =
  'CLAUDE_WORKFLOW_GATEWAY_MANAGED_ENV_SET_NAMES';
export const PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME =
  'CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_SET_NAMES';
export const PREVIOUS_WORKFLOW_ENV_EXPORTED_NAMES_ENV_NAME =
  'CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_ENV_EXPORTED_NAMES';
export const MANAGED_WORKFLOW_ENV_VALUE_PREFIX =
  'CLAUDE_WORKFLOW_GATEWAY_MANAGED_VALUE_';
export const PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX =
  'CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_VALUE_';
const ANTHROPIC_CLIENT_AUTH_ENV_NAMES = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]);
const LEGACY_WORKFLOW_MODEL_ENV_NAMES = Object.freeze([
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
]);
const LEGACY_WORKFLOW_GATEWAY_URL = 'http://127.0.0.1:4318';
const LEGACY_WORKFLOW_AGENT_MODEL = 'codex-terra';
const LEGACY_WORKFLOW_MAIN_MODEL = 'claude-fable-5[1m]';

function workflowEnvironmentNames(value) {
  return new Set(
    String(value || '')
      .split(/\s+/u)
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
  );
}

export function environmentWithoutManagedWorkflowEnvironment(env = process.env) {
  const childEnv = { ...env };
  const managedNames = workflowEnvironmentNames(
    childEnv[MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME]
  );
  const managedSetNames = workflowEnvironmentNames(
    childEnv[MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME]
  );
  const previousSetNames = workflowEnvironmentNames(
    childEnv[PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME]
  );

  for (const name of managedNames) {
    const managedValueName = `${MANAGED_WORKFLOW_ENV_VALUE_PREFIX}${name}`;
    const previousValueName = `${PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX}${name}`;
    const currentIsSet = Object.hasOwn(childEnv, name);
    const workflowStillOwnsValue = managedSetNames.has(name)
      ? currentIsSet &&
        childEnv[name] === String(childEnv[managedValueName] ?? '')
      : !currentIsSet;

    if (workflowStillOwnsValue) {
      if (previousSetNames.has(name) && Object.hasOwn(childEnv, previousValueName)) {
        childEnv[name] = childEnv[previousValueName];
      } else {
        delete childEnv[name];
      }
    }
  }

  for (const name of Object.keys(childEnv)) {
    if (
      name === MANAGED_WORKFLOW_ENV_NAMES_ENV_NAME ||
      name === MANAGED_WORKFLOW_ENV_SET_NAMES_ENV_NAME ||
      name === PREVIOUS_WORKFLOW_ENV_SET_NAMES_ENV_NAME ||
      name === PREVIOUS_WORKFLOW_ENV_EXPORTED_NAMES_ENV_NAME ||
      name.startsWith(MANAGED_WORKFLOW_ENV_VALUE_PREFIX) ||
      name.startsWith(PREVIOUS_WORKFLOW_ENV_VALUE_PREFIX)
    ) {
      delete childEnv[name];
    }
  }

  return childEnv;
}

export function environmentWithoutLegacyWorkflowRouting(env = process.env) {
  const childEnv = environmentWithoutManagedWorkflowEnvironment(env);
  const hasLegacySignature =
    childEnv.ANTHROPIC_BASE_URL === LEGACY_WORKFLOW_GATEWAY_URL &&
    LEGACY_WORKFLOW_MODEL_ENV_NAMES.some(
      (name) => childEnv[name] === LEGACY_WORKFLOW_AGENT_MODEL
    );
  if (!hasLegacySignature) {
    return childEnv;
  }

  delete childEnv.ANTHROPIC_BASE_URL;
  for (const name of LEGACY_WORKFLOW_MODEL_ENV_NAMES) {
    if (childEnv[name] === LEGACY_WORKFLOW_AGENT_MODEL) {
      delete childEnv[name];
    }
  }
  if (
    childEnv.ANTHROPIC_MODEL === 'codex' ||
    childEnv.ANTHROPIC_MODEL === LEGACY_WORKFLOW_MAIN_MODEL
  ) {
    delete childEnv.ANTHROPIC_MODEL;
  }
  if (childEnv.ANTHROPIC_DEFAULT_FABLE_MODEL === LEGACY_WORKFLOW_MAIN_MODEL) {
    delete childEnv.ANTHROPIC_DEFAULT_FABLE_MODEL;
  }
  if (childEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === '0') {
    delete childEnv.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  }
  return childEnv;
}

export function environmentWithoutManagedGatewayAuth(env = process.env) {
  const childEnv = environmentWithoutLegacyWorkflowRouting(env);
  const managedToken = childEnv[MANAGED_GATEWAY_AUTH_ENV_NAME];
  if (typeof managedToken === 'string' && managedToken !== '') {
    for (const name of ANTHROPIC_CLIENT_AUTH_ENV_NAMES) {
      if (childEnv[name] === managedToken) {
        delete childEnv[name];
      }
    }
  }
  delete childEnv[MANAGED_GATEWAY_AUTH_ENV_NAME];
  return childEnv;
}

export function environmentWithoutGatewayCredentials(env = process.env) {
  const childEnv = environmentWithoutManagedGatewayAuth(env);
  const managedTerminalTitle = childEnv[MANAGED_TERMINAL_TITLE_ENV_NAME];
  if (
    typeof managedTerminalTitle === 'string' &&
    managedTerminalTitle !== '' &&
    childEnv[CLAUDE_TERMINAL_TITLE_ENV_NAME] === managedTerminalTitle
  ) {
    if (childEnv[PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME] === '1') {
      childEnv[CLAUDE_TERMINAL_TITLE_ENV_NAME] = String(
        childEnv[PREVIOUS_TERMINAL_TITLE_ENV_NAME] || ''
      );
    } else {
      delete childEnv[CLAUDE_TERMINAL_TITLE_ENV_NAME];
    }
  }
  delete childEnv[MANAGED_TERMINAL_TITLE_ENV_NAME];
  delete childEnv[PREVIOUS_TERMINAL_TITLE_ENV_NAME];
  delete childEnv[PREVIOUS_TERMINAL_TITLE_SET_ENV_NAME];
  for (const name of GATEWAY_ONLY_CREDENTIAL_ENV_NAMES) {
    delete childEnv[name];
  }
  return childEnv;
}

export function environmentWithoutGatewayAndAnthropicCredentials(env = process.env) {
  const childEnv = environmentWithoutGatewayCredentials(env);
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_BETAS;
  delete childEnv.ANTHROPIC_CUSTOM_HEADERS;
  return childEnv;
}
