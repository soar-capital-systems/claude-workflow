#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function isWsl(env = process.env, osRelease = null) {
  if (process.platform !== 'linux') {
    return false;
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  try {
    const release = osRelease ?? fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8');
    return /microsoft/iu.test(release);
  } catch {
    return false;
  }
}

function decodeMountInfoPath(value) {
  return String(value)
    .replaceAll('\\040', ' ')
    .replaceAll('\\011', '\t')
    .replaceAll('\\012', '\n')
    .replaceAll('\\134', '\\');
}

export function parseMountInfo(content) {
  const mounts = [];
  for (const line of String(content || '').split(/\r?\n/u)) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf(' - ');
    if (separator === -1) {
      continue;
    }
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    if (left.length < 6 || right.length < 3) {
      continue;
    }
    mounts.push({
      mountPoint: decodeMountInfoPath(left[4]),
      mountOptions: left[5],
      optionalFields: left.slice(6).join(' '),
      fsType: right[0],
      source: decodeMountInfoPath(right[1]),
      superOptions: right.slice(2).join(' '),
    });
  }
  return mounts.sort((left, right) => right.mountPoint.length - left.mountPoint.length);
}

function pathIsWithinMount(candidate, mountPoint) {
  if (mountPoint === '/') {
    return candidate.startsWith('/');
  }
  return candidate === mountPoint || candidate.startsWith(`${mountPoint}/`);
}

export function mountForPath(candidate, mounts) {
  const absolutePath = path.resolve(candidate);
  return mounts.find((mount) => pathIsWithinMount(absolutePath, mount.mountPoint)) || null;
}

export function isDrvFsMount(mount) {
  if (!mount) {
    return false;
  }
  const signature = [
    mount.fsType,
    mount.source,
    mount.mountOptions,
    mount.optionalFields,
    mount.superOptions,
  ].join(' ');
  return mount.fsType.toLowerCase() === 'drvfs' || /\bdrvfs\b/iu.test(signature);
}

function resolveThroughExistingAncestor(value, visited = new Set()) {
  const absolute = path.resolve(value);
  if (visited.has(absolute) || visited.size >= 40) {
    throw new Error(`path contains a symlink cycle: ${value}`);
  }
  visited.add(absolute);
  const parsed = path.parse(absolute);
  const parts = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let candidate = parsed.root;

  for (let index = 0; index < parts.length; index += 1) {
    candidate = path.join(candidate, parts[index]);
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return path.join(candidate, ...parts.slice(index + 1));
      }
      if (error?.code === 'ENOTDIR') {
        throw new Error(`path has a non-directory ancestor: ${candidate}`);
      }
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      continue;
    }

    const linkTarget = fs.readlinkSync(candidate);
    const resolvedTarget = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(path.dirname(candidate), linkTarget);
    return resolveThroughExistingAncestor(
      path.join(resolvedTarget, ...parts.slice(index + 1)),
      visited
    );
  }

  return candidate;
}

function isConventionalWindowsMount(candidate) {
  return /^\/mnt\/[a-z](?:\/|$)/iu.test(String(candidate).replaceAll('\\', '/'));
}

export function unsafeWslInstallPaths(candidates, mountInfo) {
  const mounts = parseMountInfo(mountInfo);
  const unsafe = [];
  for (const [label, value] of candidates) {
    if (!value) {
      continue;
    }
    const resolved = resolveThroughExistingAncestor(value);
    const mount = mountForPath(resolved, mounts);
    if (isDrvFsMount(mount) || isConventionalWindowsMount(resolved)) {
      unsafe.push({
        label,
        path: resolved,
        mountPoint: mount?.mountPoint || null,
      });
    }
  }
  return unsafe;
}

export function validateLocalInstall(options = {}) {
  const env = options.env || process.env;
  if (!isWsl(env, options.osRelease)) {
    return [];
  }
  const mountInfo =
    options.mountInfo ?? fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const candidates = options.candidates || [
    ['Project directory', options.projectRoot],
    ['Project dependencies', path.join(options.projectRoot, 'node_modules')],
    ['UI dependencies', path.join(options.projectRoot, 'ui', 'node_modules')],
    [
      'Svelte UI dependencies',
      path.join(options.projectRoot, 'ui', 'svelte-app', 'node_modules'),
    ],
    ['Node.js', process.execPath],
    ['npm', options.npmPath],
    ['npm global prefix', options.npmGlobalPrefix],
    ['npm cache', options.npmCache],
    ['Home directory', env.HOME || env.USERPROFILE || os.homedir()],
  ];
  return unsafeWslInstallPaths(candidates, mountInfo);
}

function npmPathSetting(npmPath, args, label) {
  const result = spawnSync(npmPath, args, {
    env: process.env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const value = String(result.stdout || '').trim();
  if (result.status !== 0 || result.error || !path.isAbsolute(value)) {
    const detail = result.error?.message || String(result.stderr || '').trim() || 'no path returned';
    throw new Error(`setup-local: could not resolve ${label}: ${detail}`);
  }
  return value;
}

function main() {
  const projectRoot = process.argv[2];
  const npmPath = process.argv[3];
  if (!projectRoot || !npmPath) {
    throw new Error('setup-local: project root and npm path are required');
  }
  if (!isWsl()) {
    return;
  }
  const npmGlobalPrefix = npmPathSetting(npmPath, ['prefix', '--global'], 'npm global prefix');
  const npmCache = npmPathSetting(npmPath, ['config', 'get', 'cache'], 'npm cache');
  const unsafe = validateLocalInstall({
    projectRoot,
    npmPath,
    npmGlobalPrefix,
    npmCache,
  });
  if (unsafe.length === 0) {
    return;
  }
  const details = unsafe
    .map(({ label, path: unsafePath, mountPoint }) =>
      `${label}: ${unsafePath}${mountPoint ? ` (DrvFS mount ${mountPoint})` : ''}`
    )
    .join('\n  - ');
  console.error(
    'setup-local: refusing to mutate a WSL install on Windows-mounted storage.\n' +
      `  - ${details}\n` +
      'setup-local: clone under /home/<user> and use Linux-native Node.js/npm.'
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
