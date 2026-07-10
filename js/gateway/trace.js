import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandHomePath } from '../utils/safe-path.js';

const DEFAULT_TRACE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TRACE_MAX_FILES = 3;
const MIN_TRACE_MAX_BYTES = 256;
const MAX_TRACE_FILES = 16;
const TRACE_FILE_NAME = 'gateway-trace.jsonl';
const TRACE_LOCK_NAME = '.gateway-trace.lock';
const TRACE_LOCK_STALE_MS = 30_000;
const TRACE_LOCK_RETRY_MS = 10;
// A writer killed while holding the mkdir lock leaves a directory behind.
// Keep trying past the stale threshold so the queue can recover instead of
// dropping every trace entry for the rest of that window.
const TRACE_LOCK_ATTEMPTS = Math.ceil(
  (TRACE_LOCK_STALE_MS + 5_000) / TRACE_LOCK_RETRY_MS
);

function noop() {}

function createTraceId() {
  return crypto.randomBytes(8).toString('hex');
}

function normalizeTraceDir(traceDir) {
  if (typeof traceDir !== 'string' || traceDir.trim() === '') {
    return '';
  }

  return path.resolve(expandHomePath(traceDir.trim()));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function traceFileAtIndex(traceDir, index) {
  return path.join(traceDir, index === 0 ? TRACE_FILE_NAME : `${TRACE_FILE_NAME}.${index}`);
}

function assertOwnerOnlyMode(stats, description, targetPath) {
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `${description} does not enforce owner-only permissions: ${targetPath}. ` +
        'On WSL, use the Linux filesystem or enable DrvFS metadata.'
    );
  }
}

async function regularFileStats(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`gateway trace path must be a regular file: ${filePath}`);
    }
    return stats;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function serializedTraceEntry(entry, maxBytes) {
  const serialized = `${JSON.stringify(entry)}\n`;
  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= maxBytes) {
    return serialized;
  }

  const summary = {
    ts: entry?.ts || new Date().toISOString(),
    event: String(entry?.event || 'gateway.trace.entry').slice(0, 128),
    trace_entry_truncated: true,
    original_bytes: originalBytes,
    detail_keys: Object.keys(entry || {})
      .filter((key) => key !== 'ts' && key !== 'event')
      .slice(0, 24)
      .map((key) => key.slice(0, 64)),
  };
  const summarized = `${JSON.stringify(summary)}\n`;
  if (Buffer.byteLength(summarized) <= maxBytes) {
    return summarized;
  }

  return `${JSON.stringify({
    trace_entry_truncated: true,
    original_bytes: originalBytes,
  })}\n`;
}

function createNoopScope() {
  return {
    log: noop,
    scope() {
      return createNoopScope();
    },
  };
}

export function createGatewayTracer(config = {}) {
  const traceDir = normalizeTraceDir(config.traceDir);
  if (!traceDir) {
    return {
      enabled: false,
      traceDir: '',
      traceFilePath: '',
      log: noop,
      scope() {
        return createNoopScope();
      },
      async close() {},
      createId: createTraceId,
    };
  }

  const traceFilePath = traceFileAtIndex(traceDir, 0);
  const traceMaxBytes = boundedInteger(
    config.traceMaxBytes,
    DEFAULT_TRACE_MAX_BYTES,
    MIN_TRACE_MAX_BYTES,
    Number.MAX_SAFE_INTEGER
  );
  const traceMaxFiles = boundedInteger(
    config.traceMaxFiles,
    DEFAULT_TRACE_MAX_FILES,
    1,
    MAX_TRACE_FILES
  );
  let initialized = false;
  let existingFilesHardened = false;
  let lastError = null;
  let warned = false;
  let writeChain = Promise.resolve();

  async function ensureTraceDir() {
    if (initialized) {
      return;
    }

    let existed = true;
    try {
      await fs.lstat(traceDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      existed = false;
    }
    await fs.mkdir(traceDir, { recursive: true, mode: 0o700 });
    let stats = await fs.lstat(traceDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`gateway trace directory must be a real directory: ${traceDir}`);
    }
    if (!existed) {
      await fs.chmod(traceDir, 0o700);
      stats = await fs.lstat(traceDir);
      assertOwnerOnlyMode(stats, 'gateway trace directory', traceDir);
    } else if ((stats.mode & 0o077) !== 0) {
      throw new Error(
        `gateway trace directory must not be accessible by group or other users: ${traceDir}`
      );
    }

    initialized = true;
  }

  async function hardenExistingTraceFiles() {
    if (existingFilesHardened) {
      return;
    }

    const entries = await fs.readdir(traceDir);
    for (const entry of entries) {
      const match = entry.match(/^gateway-trace\.jsonl\.(\d+)$/u);
      if (!match) {
        continue;
      }
      const index = Number(match[1]);
      const backupPath = path.join(traceDir, entry);
      const backupStats = await regularFileStats(backupPath);
      if (index >= traceMaxFiles || (backupStats && backupStats.size > traceMaxBytes)) {
        await fs.rm(backupPath, { force: true });
        continue;
      }
      await fs.chmod(backupPath, 0o600);
      assertOwnerOnlyMode(
        await fs.lstat(backupPath),
        'gateway trace file',
        backupPath
      );
    }
    const activeStats = await regularFileStats(traceFilePath);
    if (activeStats) {
      await fs.chmod(traceFilePath, 0o600);
      assertOwnerOnlyMode(
        await fs.lstat(traceFilePath),
        'gateway trace file',
        traceFilePath
      );
    }
    existingFilesHardened = true;
  }

  async function acquireTraceLock() {
    const lockPath = path.join(traceDir, TRACE_LOCK_NAME);
    for (let attempt = 0; attempt < TRACE_LOCK_ATTEMPTS; attempt += 1) {
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        return async function releaseTraceLock() {
          await fs.rm(lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }

        try {
          const stats = await fs.stat(lockPath);
          if (Date.now() - stats.mtimeMs > TRACE_LOCK_STALE_MS) {
            await fs.rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError?.code === 'ENOENT') {
            continue;
          }
          throw statError;
        }

        await new Promise(function waitForTraceLock(resolve) {
          setTimeout(resolve, TRACE_LOCK_RETRY_MS);
        });
      }
    }

    throw new Error(`timed out waiting for gateway trace lock in ${traceDir}`);
  }

  async function rotateTraceFiles() {
    if (traceMaxFiles <= 1) {
      await fs.rm(traceFilePath, { force: true });
      return;
    }

    for (let index = traceMaxFiles - 1; index >= 1; index -= 1) {
      const sourcePath = traceFileAtIndex(traceDir, index - 1);
      const destinationPath = traceFileAtIndex(traceDir, index);
      await fs.rm(destinationPath, { force: true });
      try {
        await fs.rename(sourcePath, destinationPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          continue;
        }
        throw error;
      }

      const rotatedStats = await regularFileStats(destinationPath);
      if (rotatedStats && rotatedStats.size > traceMaxBytes) {
        await fs.rm(destinationPath, { force: true });
      } else if (rotatedStats) {
        await fs.chmod(destinationPath, 0o600);
        assertOwnerOnlyMode(
          await fs.lstat(destinationPath),
          'gateway trace file',
          destinationPath
        );
      }
    }
  }

  async function appendTraceEntry(entry) {
    await ensureTraceDir();
    const releaseTraceLock = await acquireTraceLock();
    try {
      await hardenExistingTraceFiles();
      const line = serializedTraceEntry(entry, traceMaxBytes);
      const lineBytes = Buffer.byteLength(line);
      const currentStats = await regularFileStats(traceFilePath);
      if (currentStats && currentStats.size + lineBytes > traceMaxBytes) {
        await rotateTraceFiles();
      }
      await fs.appendFile(traceFilePath, line, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.chmod(traceFilePath, 0o600);
      assertOwnerOnlyMode(
        await fs.lstat(traceFilePath),
        'gateway trace file',
        traceFilePath
      );
    } finally {
      await releaseTraceLock();
    }
  }

  function enqueue(entry) {
    writeChain = writeChain
      .then(() => appendTraceEntry(entry))
      .catch(function recordTraceError(error) {
        lastError = error;
        if (!warned) {
          warned = true;
          process.stderr.write(
            `claude-workflow-gateway: trace write failed; suppressing further trace errors: ${error?.message || error}\n`
          );
        }
      });

    return writeChain;
  }

  function log(event, details = {}) {
    return enqueue({
      ts: new Date().toISOString(),
      event,
      ...details,
    });
  }

  function scope(scopeFields = {}) {
    return {
      log(event, details = {}) {
        log(event, {
          ...scopeFields,
          ...details,
        });
      },
      scope(childFields = {}) {
        return scope({
          ...scopeFields,
          ...childFields,
        });
      },
    };
  }

  return {
    enabled: true,
    traceDir,
    traceFilePath,
    traceMaxBytes,
    traceMaxFiles,
    log,
    scope,
    async close() {
      await writeChain;
    },
    get lastError() {
      return lastError;
    },
    createId: createTraceId,
  };
}
