import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

function environmentValue(environment, name) {
  if (environment && Object.hasOwn(environment, name)) {
    return environment[name];
  }
  if (process.platform !== 'win32' || !environment) {
    return undefined;
  }

  const normalizedName = name.toLowerCase();
  const matchingName = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === normalizedName
  );
  return matchingName === undefined ? undefined : environment[matchingName];
}

function executableExtensions(command, environment) {
  if (process.platform !== 'win32' || path.extname(command)) {
    return [''];
  }

  const configured = String(
    environmentValue(environment, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD'
  );
  return [
    '',
    ...configured
      .split(';')
      .map((extension) => extension.trim())
      .filter(Boolean),
  ];
}

function executableCandidates(command, cwd, environmentPath, environment) {
  const containsSeparator = command.includes('/') || command.includes(path.sep);
  const searchPath =
    environmentPath === undefined
      ? process.platform === 'win32'
        ? String(environmentValue(environment, 'PATH') || '')
        : '/usr/bin:/bin'
      : String(environmentPath);
  const bases = containsSeparator
    ? [path.resolve(cwd, command)]
    : searchPath
        .split(path.delimiter)
        .map((entry) => path.resolve(cwd, entry || '.', command));
  const extensions = executableExtensions(command, environment);
  return bases.flatMap((base) => extensions.map((extension) => `${base}${extension}`));
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

export function executableIdentity(
  command,
  {
    cwd = process.cwd(),
    environment = process.env,
    environmentPath = environmentValue(environment, 'PATH'),
  } = {}
) {
  const normalizedCommand = String(command || '').trim();
  if (!normalizedCommand) {
    return { command: '', missing: true };
  }

  for (const candidate of executableCandidates(
    normalizedCommand,
    cwd,
    environmentPath,
    environment
  )) {
    try {
      const candidateStats = fs.statSync(candidate);
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!candidateStats.isFile()) {
        continue;
      }
      const realPath = fs.realpathSync(candidate);
      return {
        command: normalizedCommand,
        realPath,
        stats: statIdentity(fs.statSync(realPath, { bigint: true })),
      };
    } catch {
      // Match executable search semantics: keep looking through PATH.
    }
  }
  return { command: normalizedCommand, missing: true };
}

export function effectiveCodexHome(environment = process.env, cwd = process.cwd()) {
  const home = String(
    environmentValue(environment, 'HOME') ||
      (process.platform === 'win32' ? environmentValue(environment, 'USERPROFILE') : '') ||
      os.homedir()
  ).trim();
  const configured = String(environmentValue(environment, 'CODEX_HOME') || '').trim();
  if (!configured) {
    return path.join(path.resolve(home), '.codex');
  }
  if (configured === '~') {
    return path.resolve(home);
  }
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.resolve(home, configured.slice(2));
  }
  return path.resolve(cwd, configured);
}
