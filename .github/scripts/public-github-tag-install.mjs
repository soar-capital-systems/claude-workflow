#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PACKAGE_NAME = '@onetool/claude-workflow';
const REPOSITORIES = Object.freeze([
  {
    label: 'canonical',
    url: 'https://github.com/yshaaban/claude-workflow.git',
  },
  {
    label: 'mirror',
    url: 'https://github.com/soar-capital-systems/claude-workflow.git',
  },
]);
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env || process.env,
    timeout: options.timeout || 300_000,
    windowsHide: true,
  });
  const expectedStatus = options.expectedStatus ?? 0;
  if (result.error || result.status !== expectedStatus) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(
      `${command} ${args.join(' ')} failed` +
        (result.error ? `: ${result.error.message}` : ` with status ${String(result.status)}`) +
        (detail ? `\n${detail}` : '')
    );
  }
  return result;
}

function remoteTags(repository, environment) {
  const output = run('git', ['ls-remote', '--tags', repository.url], {
    env: environment,
    timeout: 60_000,
  }).stdout;
  const catalog = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\S+)\s+refs\/tags\/(v[^\s^]+)(\^\{\})?$/u.exec(line);
    if (!match) {
      continue;
    }
    const [, objectId, tag, peeled] = match;
    const entry = catalog.get(tag) || {};
    entry[peeled ? 'peeled' : 'direct'] = objectId;
    catalog.set(tag, entry);
  }
  return catalog;
}

function tagCommit(catalog, tag) {
  const entry = catalog.get(tag);
  return entry?.peeled || entry?.direct || null;
}

function latestStableTag(catalog) {
  const stable = [...catalog.keys()]
    .map((tag) => ({ tag, version: STABLE_TAG.exec(tag) }))
    .filter((entry) => entry.version)
    .sort((left, right) => {
      for (let index = 1; index <= 3; index += 1) {
        const difference = Number(right.version[index]) - Number(left.version[index]);
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    });
  if (stable.length === 0) {
    throw new Error('canonical repository has no stable vMAJOR.MINOR.PATCH tag');
  }
  return stable[0].tag;
}

function isolatedEnvironment(root) {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: '1',
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_USERCONFIG: path.join(root, 'npm-userconfig'),
    NPM_CONFIG_GLOBALCONFIG: path.join(root, 'npm-globalconfig'),
    npm_config_cache: path.join(root, 'npm-cache'),
  };
}

async function validateInstall(repository, tag, commit, temporaryRoot) {
  const installRoot = path.join(temporaryRoot, repository.label);
  const prefix = path.join(installRoot, 'prefix');
  const environment = isolatedEnvironment(installRoot);
  await fs.mkdir(installRoot, { recursive: true });
  await Promise.all([
    fs.mkdir(prefix, { recursive: true }),
    fs.mkdir(environment.HOME, { recursive: true }),
    fs.mkdir(environment.XDG_CACHE_HOME, { recursive: true }),
    fs.mkdir(environment.XDG_CONFIG_HOME, { recursive: true }),
    fs.mkdir(environment.XDG_STATE_HOME, { recursive: true }),
    fs.mkdir(environment.npm_config_cache, { recursive: true }),
    fs.writeFile(environment.NPM_CONFIG_USERCONFIG, '', { mode: 0o600 }),
    fs.writeFile(environment.NPM_CONFIG_GLOBALCONFIG, '', { mode: 0o600 }),
  ]);

  run(
    'npm',
    [
      'install',
      '--global',
      '--allow-git=root',
      '--no-audit',
      '--no-fund',
      '--prefix',
      prefix,
      `git+${repository.url}#${tag}`,
    ],
    { cwd: installRoot, env: environment }
  );

  const installedPackage = path.join(
    prefix,
    'lib',
    'node_modules',
    ...PACKAGE_NAME.split('/')
  );
  assert.equal(
    (await fs.lstat(installedPackage)).isSymbolicLink(),
    false,
    `${repository.label} install unexpectedly points outside its clean prefix`
  );
  const metadata = JSON.parse(
    await fs.readFile(path.join(installedPackage, 'package.json'), 'utf8')
  );
  assert.equal(metadata.name, PACKAGE_NAME);
  assert.equal(metadata.version, tag.slice(1));

  const workflow = path.join(prefix, 'bin', 'claude-workflow');
  const gateway = path.join(prefix, 'bin', 'claude-workflow-gateway');
  assert.equal(
    run(workflow, ['--version'], { cwd: installRoot, env: environment }).stdout.trim(),
    tag.slice(1)
  );
  run(workflow, ['--help'], { cwd: installRoot, env: environment });
  run(workflow, ['setup', '--help'], { cwd: installRoot, env: environment });
  const status = run(gateway, ['status'], {
    cwd: installRoot,
    env: {
      ...environment,
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: path.join(installRoot, 'gateway-state'),
      ULTRATHINK_GATEWAY_DAEMON_PORT: '65534',
    },
    expectedStatus: 1,
    timeout: 10_000,
  });
  assert.match(`${status.stdout}\n${status.stderr}`, /not running/u);
  process.stdout.write(
    `Validated ${repository.label} GitHub install at ${tag} (${commit.slice(0, 12)}).\n`
  );
}

async function main() {
  if (process.platform === 'win32') {
    throw new Error('public GitHub install validation requires a Linux or macOS runner');
  }

  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'claude-workflow-public-github-')
  );
  try {
    const remoteRoot = path.join(temporaryRoot, 'remote-probe');
    const remoteEnvironment = isolatedEnvironment(remoteRoot);
    await fs.mkdir(remoteEnvironment.HOME, { recursive: true });
    const catalogs = new Map(
      REPOSITORIES.map((repository) => [
        repository.label,
        remoteTags(repository, remoteEnvironment),
      ])
    );
    const requestedTag = String(process.env.CLAUDE_WORKFLOW_PUBLIC_TAG || '').trim();
    if (requestedTag && !STABLE_TAG.test(requestedTag)) {
      throw new Error('CLAUDE_WORKFLOW_PUBLIC_TAG must use vMAJOR.MINOR.PATCH');
    }
    const tag = requestedTag || latestStableTag(catalogs.get('canonical'));
    const canonicalCommit = tagCommit(catalogs.get('canonical'), tag);
    if (!canonicalCommit) {
      throw new Error(`canonical repository does not publish ${tag}`);
    }
    for (const repository of REPOSITORIES.slice(1)) {
      const mirrorCommit = tagCommit(catalogs.get(repository.label), tag);
      if (!mirrorCommit) {
        throw new Error(`${repository.label} repository does not publish ${tag}`);
      }
      if (mirrorCommit !== canonicalCommit) {
        throw new Error(
          `${repository.label} ${tag} resolves to ${mirrorCommit}, not canonical ${canonicalCommit}`
        );
      }
    }

    for (const repository of REPOSITORIES) {
      await validateInstall(repository, tag, canonicalCommit, temporaryRoot);
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch(function fail(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
