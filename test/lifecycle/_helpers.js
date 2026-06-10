/**
 * Tiny zero-dep helpers for lifecycle tests. Each test file is a standalone
 * Node script: it sets a TIMEOUT, runs an async main(), and exits 0/1.
 */
import { strict as assert } from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import crypto from 'crypto';

export { assert };

export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

export function setTimeoutGuard(label, ms = 30000) {
  const t = setTimeout(() => {
    console.error(`TIMEOUT (${ms}ms) in ${label}`);
    process.exit(2);
  }, ms);
  t.unref();
  return t;
}

export async function makeTempDir(prefix) {
  const dir = path.join(tmpdir(), `claude-workflow-test-${prefix}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupDir(dir) {
  try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
}

export async function writeFiles(rootDir, fileMap) {
  for (const [rel, content] of Object.entries(fileMap)) {
    const abs = path.join(rootDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

export function ok(msg) { console.log(`  ok  ${msg}`); }
export function bail(msg, err) {
  console.error(`  FAIL ${msg}`);
  if (err) console.error(err);
  process.exit(1);
}

export async function runTest(label, fn) {
  const guard = setTimeoutGuard(label, 30000);
  console.log(`# ${label}`);
  try {
    await fn();
    console.log(`PASS ${label}\n`);
  } catch (e) {
    clearTimeout(guard);
    bail(label, e);
  } finally {
    clearTimeout(guard);
  }
}
