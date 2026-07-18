import process from 'node:process';

export const GATEWAY_ONLY_CREDENTIAL_ENV_NAMES = Object.freeze([
  'DEEPSEEK_API_KEY',
  'GLM_API_KEY',
  'KIMI_API_KEY',
  'OPENAI_API_KEY',
  'ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY',
  'ULTRATHINK_GATEWAY_CODEX_API_KEY',
  'ULTRATHINK_GATEWAY_DEEPSEEK_API_KEY',
  'ULTRATHINK_GATEWAY_GLM_API_KEY',
  'ULTRATHINK_GATEWAY_KIMI_API_KEY',
  'ULTRATHINK_GATEWAY_OPENAI_API_KEY',
  'ULTRATHINK_GATEWAY_SHARED_SECRET',
  'ZAI_API_KEY',
]);

export const MANAGED_GATEWAY_AUTH_ENV_NAME =
  'CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN';
const ANTHROPIC_CLIENT_AUTH_ENV_NAMES = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]);

export function environmentWithoutManagedGatewayAuth(env = process.env) {
  const childEnv = { ...env };
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
