#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DISABLED_VALUES = new Set(['', '0', 'false', 'no', 'off']);
const REVISION_ENV_PREFIXES = ['CLAUDE_WORKFLOW_GATEWAY_', 'ULTRATHINK_GATEWAY_'];
const REVISION_ENV_NAMES = new Set([
  'ALL_PROXY',
  'ANTHROPIC_API_KEY',
  'BAILIAN_TOKEN_PLAN_API_KEY',
  'CLAUDE_WORKFLOW_DISPLAY_ROUTED_MODEL',
  'CLAUDE_WORKFLOW_MAIN_PROVIDER',
  'CLAUDE_WORKFLOW_SUBAGENT_MODEL_ID',
  'CODEX_HOME',
  'DASHSCOPE_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_DEFAULT_MODEL_ID',
  'GLM_API_KEY',
  'GLM_BASE_URL',
  'GLM_DEFAULT_MODEL_ID',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'KIMI_API_KEY',
  'OPENAI_API_KEY',
  'QWEN_API_KEY',
  'QWEN_BASE_URL',
  'QWEN_MODEL',
  'QWEN_REASONING_EFFORT',
  'ULTRATHINK_DEEPSEEK_REASONING_EFFORT',
  'ULTRATHINK_GLM_REASONING_EFFORT',
  'ULTRATHINK_THINKING_LEVEL',
  'ZAI_API_KEY',
  'ZAI_BASE_URL',
  'ZAI_DEFAULT_MODEL_ID',
  'ZAI_REASONING_EFFORT',
  'all_proxy',
  'https_proxy',
  'http_proxy',
]);
const REVISION_ENV_EXCLUSIONS = new Set([
  'CLAUDE_WORKFLOW_LOAD_PROJECT_ENV',
  'CLAUDE_WORKFLOW_RECONCILE_INSTALL',
  'ULTRATHINK_GATEWAY_CODEX_COMMAND',
  'ULTRATHINK_GATEWAY_RUNTIME_REVISION',
  'ULTRATHINK_GATEWAY_RUNTIME_STARTED_AT',
]);

function hashValue(hash, label, value) {
  hash.update(`${label}\0`);
  hash.update(crypto.createHash('sha256').update(String(value)).digest());
  hash.update('\0');
}

function visitSourceTree(hash, root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  const entries = fs
    .readdirSync(absolutePath, { withFileTypes: true })
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );

  for (const entry of entries) {
    const childRelativePath = path.posix.join(relativePath, entry.name);
    const childAbsolutePath = path.join(root, childRelativePath);
    if (entry.isDirectory()) {
      visitSourceTree(hash, root, childRelativePath);
      continue;
    }

    hash.update(childRelativePath);
    hash.update('\0');
    if (entry.isSymbolicLink()) {
      hash.update('symlink\0');
      hash.update(fs.readlinkSync(childAbsolutePath));
    } else if (entry.isFile()) {
      hash.update('file\0');
      hash.update(fs.readFileSync(childAbsolutePath));
    } else {
      hash.update('other\0');
    }
    hash.update('\0');
  }
}

function hashInstalledSource(hash, root) {
  visitSourceTree(hash, root, 'js');
  visitSourceTree(hash, root, 'scripts');
  for (const relativePath of ['package.json', 'package-lock.json']) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    hash.update(relativePath);
    hash.update('\0file\0');
    hash.update(fs.readFileSync(absolutePath));
    hash.update('\0');
  }
}

function executableCandidate(command, cwd, environmentPath) {
  const containsSeparator = command.includes('/') || command.includes(path.sep);
  const searchPath =
    environmentPath === undefined ? '/usr/bin:/bin' : String(environmentPath);
  const candidates = containsSeparator
    ? [path.resolve(cwd, command)]
    : searchPath
        .split(path.delimiter)
        .map((entry) => path.resolve(cwd, entry || '.', command));

  for (const candidate of candidates) {
    try {
      const stats = fs.statSync(candidate);
      fs.accessSync(candidate, fs.constants.X_OK);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // Match executable search semantics: keep looking through PATH.
    }
  }
  return '';
}

function statIdentity(stats) {
  return {
    ctimeNs: String(stats.ctimeNs),
    dev: String(stats.dev),
    gid: String(stats.gid),
    ino: String(stats.ino),
    mode: String(stats.mode),
    mtimeNs: String(stats.mtimeNs),
    size: String(stats.size),
    uid: String(stats.uid),
  };
}

export function executableIdentity(command, {
  cwd = process.cwd(),
  environmentPath = process.env.PATH,
} = {}) {
  const normalizedCommand = String(command || '').trim();
  if (!normalizedCommand) {
    return { command: '', missing: true };
  }
  const candidate = executableCandidate(normalizedCommand, cwd, environmentPath);
  if (!candidate) {
    return { command: normalizedCommand, missing: true };
  }

  const realPath = fs.realpathSync(candidate);
  return {
    command: normalizedCommand,
    realPath,
    stats: statIdentity(fs.statSync(realPath, { bigint: true })),
  };
}

function canonicalNoProxy(environment) {
  const entries = [environment.no_proxy, environment.NO_PROXY]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join(',')
    .split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const seen = new Set();
  const canonicalEntries = entries.filter((entry) => {
    const normalized = entry.toLowerCase();
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
  const proxyConfigured = [
    'ALL_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'all_proxy',
    'https_proxy',
    'http_proxy',
  ].some((name) => String(environment[name] || '').trim() !== '');
  const gatewayHost = String(environment.ULTRATHINK_GATEWAY_HOST || '127.0.0.1')
    .trim()
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .replace(/\.$/u, '')
    .toLowerCase();
  if (proxyConfigured && gatewayHost && !seen.has(gatewayHost)) {
    canonicalEntries.push(gatewayHost);
  }
  return canonicalEntries.join(',');
}

function effectiveCodexHome(environment, cwd) {
  const home = String(environment.HOME || os.homedir()).trim();
  const configured = String(environment.CODEX_HOME || '').trim();
  if (!configured) {
    return path.join(path.resolve(home), '.codex');
  }
  if (configured === '~') {
    return path.resolve(home);
  }
  if (configured.startsWith('~/')) {
    return path.resolve(home, configured.slice(2));
  }
  return path.resolve(cwd, configured);
}

function ambientAnthropicApiKeyIsEffective(environment) {
  if (String(environment.ULTRATHINK_GATEWAY_ANTHROPIC_API_KEY || '').trim()) {
    return false;
  }
  try {
    const routeMap = JSON.parse(environment.ULTRATHINK_GATEWAY_ROUTE_MAP_JSON || '{}');
    if (
      routeMap &&
      typeof routeMap === 'object' &&
      !Array.isArray(routeMap) &&
      Object.values(routeMap).some(
        (route) =>
          String(route?.provider || route?.target?.provider || '')
            .trim()
            .toLowerCase() === 'anthropic'
      )
    ) {
      return true;
    }
  } catch {
    return true;
  }
  const passthrough = String(
    environment.ULTRATHINK_GATEWAY_ANTHROPIC_PASSTHROUGH_MODELS ||
      environment.ULTRATHINK_GATEWAY_PASSTHROUGH_MODEL_IDS ||
      ''
  ).trim();
  if (passthrough) {
    return passthrough.toLowerCase() !== 'none';
  }
  return String(
    environment.ULTRATHINK_GATEWAY_MAIN_PROVIDER ||
      environment.CLAUDE_WORKFLOW_MAIN_PROVIDER ||
      'anthropic'
  )
    .trim()
    .toLowerCase() === 'anthropic';
}

async function effectiveSharedEnvironment(root, stateDirectory, port) {
  const previousArgvEntry = process.argv[1];
  const projectEnvSetting = process.env.CLAUDE_WORKFLOW_LOAD_PROJECT_ENV;
  const projectEnvSettingWasPresent = Object.hasOwn(
    process.env,
    'CLAUDE_WORKFLOW_LOAD_PROJECT_ENV'
  );
  try {
    delete process.env.CLAUDE_WORKFLOW_LOAD_PROJECT_ENV;
    process.argv[1] = path.join(root, 'js', 'cli', 'claude-workflow-daemon.js');
    const envLoaderUrl = pathToFileURL(path.join(root, 'js', 'utils', 'env-loader.js'));
    envLoaderUrl.searchParams.set('runtime-revision', String(process.pid));
    await import(envLoaderUrl.href);
  } finally {
    process.argv[1] = previousArgvEntry;
    if (projectEnvSettingWasPresent) {
      process.env.CLAUDE_WORKFLOW_LOAD_PROJECT_ENV = projectEnvSetting;
    } else {
      delete process.env.CLAUDE_WORKFLOW_LOAD_PROJECT_ENV;
    }
  }

  const environment = { ...process.env };
  delete environment.CLAUDE_WORKFLOW_LOAD_PROJECT_ENV;
  environment.CLAUDE_WORKFLOW_GATEWAY_STATE_DIR = stateDirectory;
  environment.CLAUDE_WORKFLOW_GATEWAY_ENV_FILE = path.join(
    stateDirectory,
    'claude-workflow-gateway.env'
  );
  environment.ULTRATHINK_GATEWAY_CODEX_CWD = stateDirectory;
  environment.ULTRATHINK_GATEWAY_DAEMON_PORT = String(port);
  environment.ULTRATHINK_GATEWAY_HOST = '127.0.0.1';
  environment.ULTRATHINK_GATEWAY_PORT = String(port);

  const traceValue = Object.hasOwn(environment, 'ULTRATHINK_GATEWAY_TRACE_DIR')
    ? String(environment.ULTRATHINK_GATEWAY_TRACE_DIR).trim()
    : path.join(stateDirectory, 'gateway-trace');
  if (DISABLED_VALUES.has(traceValue.toLowerCase())) {
    environment.ULTRATHINK_GATEWAY_TRACE_DIR = 'off';
  } else {
    const defaultTraceDirectory = path.join(stateDirectory, 'gateway-trace');
    if (traceValue !== defaultTraceDirectory) {
      throw new Error(
        `shared-daemon ULTRATHINK_GATEWAY_TRACE_DIR must be ${defaultTraceDirectory} or disabled`
      );
    }
    environment.ULTRATHINK_GATEWAY_TRACE_DIR = defaultTraceDirectory;
  }
  return environment;
}

export async function computeRuntimeRevision({ root, stateDirectory, port }) {
  const absoluteRoot = path.resolve(root);
  const absoluteStateDirectory = path.resolve(stateDirectory);
  const environment = await effectiveSharedEnvironment(
    absoluteRoot,
    absoluteStateDirectory,
    port
  );
  const hash = crypto.createHash('sha256');

  hashInstalledSource(hash, absoluteRoot);
  hashValue(
    hash,
    'runtime:node',
    JSON.stringify({
      arch: process.arch,
      executable: executableIdentity(process.execPath, {
        cwd: absoluteStateDirectory,
        environmentPath: environment.PATH,
      }),
      platform: process.platform,
      version: process.version,
    })
  );
  hashValue(
    hash,
    'runtime:codex',
    JSON.stringify(
      executableIdentity(environment.ULTRATHINK_GATEWAY_CODEX_COMMAND || 'codex', {
        cwd: absoluteStateDirectory,
        environmentPath: environment.PATH,
      })
    )
  );
  hashValue(
    hash,
    'runtime:codex-home',
    effectiveCodexHome(environment, absoluteStateDirectory)
  );

  const noProxy = canonicalNoProxy(environment);
  if (noProxy) {
    hashValue(hash, 'environment:NO_PROXY', noProxy);
  }
  const includeAmbientAnthropicApiKey = ambientAnthropicApiKeyIsEffective(environment);
  for (const name of Object.keys(environment).sort()) {
    if (
      !REVISION_ENV_NAMES.has(name) &&
      !REVISION_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      continue;
    }
    if (REVISION_ENV_EXCLUSIONS.has(name)) {
      continue;
    }
    if (
      name.startsWith('CLAUDE_WORKFLOW_GATEWAY_MANAGED_') ||
      name.startsWith('CLAUDE_WORKFLOW_GATEWAY_PREVIOUS_')
    ) {
      continue;
    }
    if (
      name === 'ANTHROPIC_API_KEY' &&
      (!includeAmbientAnthropicApiKey ||
        (environment.CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN &&
          environment.ANTHROPIC_API_KEY ===
            environment.CLAUDE_WORKFLOW_GATEWAY_MANAGED_AUTH_TOKEN))
    ) {
      continue;
    }
    hashValue(hash, `environment:${name}`, environment[name] || '');
  }
  return hash.digest('hex');
}

async function main() {
  const [root, stateDirectory, port] = process.argv.slice(2);
  if (!root || !stateDirectory || !port) {
    throw new Error(
      'usage: claude-workflow-runtime-revision.js <root> <state-directory> <port>'
    );
  }
  process.stdout.write(`${await computeRuntimeRevision({ root, stateDirectory, port })}\n`);
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(`claude-workflow-gateway: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
