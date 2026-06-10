/**
 * Safe path utilities to prevent unintended file access outside a configured root.
 *
 * The MCP server can use this to enforce a "safe root" for file access.
 * - Set ULTRATHINK_SAFE_ROOT to override the allowed root.
 * - Set ULTRATHINK_DISABLE_SAFE_ROOT=true to disable the restriction.
 *
 * NOTE: Safe-root enforcement should be opt-in at call sites. The Inspector UI
 * needs to read files outside the server repo, so shared utilities should not
 * implicitly restrict paths unless a safeRoot is explicitly provided.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export function expandHomePath(inputPath) {
  const p = String(inputPath || '');
  return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

export function resolveSafeRoot() {
  if (process.env.ULTRATHINK_DISABLE_SAFE_ROOT === 'true') return null;
  const configured = process.env.ULTRATHINK_SAFE_ROOT;
  const root = configured ? expandHomePath(configured) : process.cwd();
  return path.resolve(root);
}

function realpathOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isPathWithin(baseDir, targetPath) {
  const base = realpathOrResolved(baseDir);
  const target = realpathOrResolved(targetPath);
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolvePathFromBaseDir(baseDir, inputPath) {
  const expanded = expandHomePath(inputPath);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

export function resolvePathFromCwd(inputPath) {
  return resolvePathFromBaseDir(process.cwd(), inputPath);
}

export function resolveSafePath(inputPath, safeRootOrOptions = null) {
  const options =
    safeRootOrOptions &&
    typeof safeRootOrOptions === 'object' &&
    !Array.isArray(safeRootOrOptions)
      ? safeRootOrOptions
      : { safeRoot: safeRootOrOptions };

  const safeRootInput = options.safeRoot ?? null;
  const safeRoot = safeRootInput ? path.resolve(expandHomePath(safeRootInput)) : null;
  const baseDirInput = options.baseDir ?? (safeRoot || process.cwd());
  const baseDir = path.resolve(expandHomePath(baseDirInput));

  const absolutePath = resolvePathFromBaseDir(baseDir, inputPath);
  if (!safeRoot) return { absolutePath };
  if (!isPathWithin(safeRoot, absolutePath)) {
    return { error: 'Access denied: path is outside the allowed directory.' };
  }
  return { absolutePath };
}
