import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandHomePath } from '../utils/safe-path.js';

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

  const traceFilePath = path.join(traceDir, 'gateway-trace.jsonl');
  let initialized = false;
  let lastError = null;
  let warned = false;
  let writeChain = Promise.resolve();

  async function ensureTraceDir() {
    if (initialized) {
      return;
    }

    await fs.mkdir(traceDir, { recursive: true });
    initialized = true;
  }

  function enqueue(entry) {
    writeChain = writeChain
      .then(async function appendEntry() {
        await ensureTraceDir();
        await fs.appendFile(traceFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
      })
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
    enqueue({
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
