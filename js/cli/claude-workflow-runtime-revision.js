#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { effectiveCodexHome, executableIdentity } from '../utils/runtime-identity.js';

export { executableIdentity } from '../utils/runtime-identity.js';

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
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_USE_ENV_PROXY',
  'NODE_USE_SYSTEM_CA',
  'OPENAI_API_KEY',
  'OPENSSL_CONF',
  'QWEN_API_KEY',
  'QWEN_BASE_URL',
  'QWEN_MODEL',
  'QWEN_REASONING_EFFORT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
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
const STARTUP_FILE_ENV_NAMES = [
  'NODE_EXTRA_CA_CERTS',
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
];
const STARTUP_FILE_SAMPLE_BYTES = 64 * 1024;
const STARTUP_DIRECTORY_ENTRY_CAP = 4096;
const STARTUP_DIRECTORY_FILE_SAMPLE_BYTES = 8 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function filesystemEntryType(stats) {
  if (stats.isFile()) {
    return 'file';
  }
  if (stats.isDirectory()) {
    return 'directory';
  }
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }
  if (stats.isBlockDevice()) {
    return 'block-device';
  }
  if (stats.isCharacterDevice()) {
    return 'character-device';
  }
  if (stats.isFIFO()) {
    return 'fifo';
  }
  if (stats.isSocket()) {
    return 'socket';
  }
  return 'other';
}

function startupPathStatIdentity(stats) {
  return {
    ctimeNs: String(stats.ctimeNs),
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: String(stats.mode),
    mtimeNs: String(stats.mtimeNs),
    size: String(stats.size),
    type: filesystemEntryType(stats),
  };
}

function readFileSample(filePath, size, maximumBytes = STARTUP_FILE_SAMPLE_BYTES) {
  const boundedSize = Math.min(Number(size), maximumBytes);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    if (boundedSize === 0) {
      return sha256(Buffer.alloc(0));
    }

    const sample = Buffer.allocUnsafe(boundedSize);
    if (size <= BigInt(maximumBytes)) {
      let offset = 0;
      while (offset < boundedSize) {
        const bytesRead = fs.readSync(
          descriptor,
          sample,
          offset,
          boundedSize - offset,
          offset
        );
        if (bytesRead === 0) {
          break;
        }
        offset += bytesRead;
      }
      return sha256(sample.subarray(0, offset));
    }

    const headSize = Math.floor(boundedSize / 2);
    const tailSize = boundedSize - headSize;
    let headRead = 0;
    while (headRead < headSize) {
      const bytesRead = fs.readSync(
        descriptor,
        sample,
        headRead,
        headSize - headRead,
        headRead
      );
      if (bytesRead === 0) {
        break;
      }
      headRead += bytesRead;
    }

    let tailRead = 0;
    if (size <= BigInt(Number.MAX_SAFE_INTEGER)) {
      const tailPosition = Number(size) - tailSize;
      while (tailRead < tailSize) {
        const bytesRead = fs.readSync(
          descriptor,
          sample,
          headSize + tailRead,
          tailSize - tailRead,
          tailPosition + tailRead
        );
        if (bytesRead === 0) {
          break;
        }
        tailRead += bytesRead;
      }
    }

    const hash = crypto.createHash('sha256');
    hash.update('head\0');
    hash.update(sample.subarray(0, headRead));
    hash.update('\0tail\0');
    hash.update(sample.subarray(headSize, headSize + tailRead));
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function errorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'UNKNOWN';
}

function directoryEntriesIdentity(directoryPath) {
  const names = [];
  let directory;
  let scanError = '';
  try {
    directory = fs.opendirSync(directoryPath);
    while (names.length <= STARTUP_DIRECTORY_ENTRY_CAP) {
      const entry = directory.readSync();
      if (!entry) {
        break;
      }
      names.push(entry.name);
    }
  } catch (error) {
    scanError = errorCode(error);
  } finally {
    if (directory) {
      try {
        directory.closeSync();
      } catch (error) {
        scanError ||= errorCode(error);
      }
    }
  }

  if (scanError) {
    return {
      cap: STARTUP_DIRECTORY_ENTRY_CAP,
      error: scanError,
      mode: 'unavailable',
    };
  }

  if (names.length > STARTUP_DIRECTORY_ENTRY_CAP) {
    return {
      cap: STARTUP_DIRECTORY_ENTRY_CAP,
      mode: 'metadata-only-over-cap',
    };
  }

  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    cap: STARTUP_DIRECTORY_ENTRY_CAP,
    entries: names.map((name) => ({
      nameDigest: sha256(name),
      path: startupPathIdentity(name, directoryPath, {
        fileSampleBytes: STARTUP_DIRECTORY_FILE_SAMPLE_BYTES,
      }),
    })),
    mode: 'complete',
  };
}

function startupPathIdentity(
  value,
  cwd,
  { fileSampleBytes = STARTUP_FILE_SAMPLE_BYTES, includeDirectoryEntries = false } = {}
) {
  const resolvedPath = path.resolve(cwd, String(value));
  const identity = {
    pathDigest: sha256(resolvedPath),
  };

  try {
    const entryStats = fs.lstatSync(resolvedPath, { bigint: true });
    identity.entry = startupPathStatIdentity(entryStats);
    if (entryStats.isSymbolicLink()) {
      identity.linkTargetDigest = sha256(fs.readlinkSync(resolvedPath));
    }
  } catch (error) {
    identity.entryError = errorCode(error);
    return identity;
  }

  let realPath;
  try {
    realPath = fs.realpathSync(resolvedPath);
    identity.realPathDigest = sha256(realPath);
  } catch (error) {
    identity.targetError = errorCode(error);
    return identity;
  }

  try {
    const targetStats = fs.statSync(realPath, { bigint: true });
    identity.target = startupPathStatIdentity(targetStats);
    if (targetStats.isFile()) {
      try {
        identity.sampleDigest = readFileSample(realPath, targetStats.size, fileSampleBytes);
      } catch (error) {
        identity.sampleError = errorCode(error);
      }
    } else if (targetStats.isDirectory() && includeDirectoryEntries) {
      identity.directoryEntries = directoryEntriesIdentity(realPath);
    }
  } catch (error) {
    identity.targetError = errorCode(error);
  }
  return identity;
}

function hashStartupPathState(hash, environment, cwd) {
  for (const name of STARTUP_FILE_ENV_NAMES) {
    const value = environment[name];
    if (value === undefined || String(value) === '') {
      continue;
    }
    hashValue(
      hash,
      `environment-path:${name}`,
      JSON.stringify(startupPathIdentity(value, cwd))
    );
  }

  const certificateDirectories = environment.SSL_CERT_DIR;
  if (certificateDirectories === undefined || String(certificateDirectories) === '') {
    return;
  }
  const identities = String(certificateDirectories)
    .split(path.delimiter)
    .filter((value) => value !== '')
    .map((value) =>
      startupPathIdentity(value, cwd, { includeDirectoryEntries: true })
    );
  hashValue(hash, 'environment-path:SSL_CERT_DIR', JSON.stringify(identities));
}

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
        environment,
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
        environment,
      })
    )
  );
  hashValue(
    hash,
    'runtime:codex-home',
    effectiveCodexHome(environment, absoluteStateDirectory)
  );
  hashStartupPathState(hash, environment, absoluteStateDirectory);

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
