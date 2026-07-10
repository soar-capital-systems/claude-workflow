import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  daemonPort,
  quotePosixShellValue,
  serializeWorkflowEnvironment,
  writeWorkflowEnvironmentFile,
} from '../js/cli/claude-workflow-daemon.js';
import { createGatewayTracer } from '../js/gateway/trace.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_LOADER_URL = pathToFileURL(path.join(REPO_ROOT, 'js', 'utils', 'env-loader.js')).href;
const PROJECT_MARKER = 'SECURITY_HARDENING_PROJECT_ENV_MARKER';
const PROJECT_ENV_OPT_IN = 'CLAUDE_WORKFLOW_LOAD_PROJECT_ENV';

async function temporaryDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async function removeTemporaryDirectory() {
    await fsp.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function probeEnvironmentLoader(cwd, home, entrypoint, extraEnv = {}) {
  const probe = [
    `process.argv[1] = ${JSON.stringify(entrypoint)};`,
    `await import(${JSON.stringify(ENV_LOADER_URL)});`,
    `process.stdout.write(JSON.stringify({ marker: process.env.${PROJECT_MARKER} || '' }));`,
  ].join('\n');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ...extraEnv,
  };
  if (!Object.hasOwn(extraEnv, PROJECT_MARKER)) {
    delete env[PROJECT_MARKER];
  }
  if (!Object.hasOwn(extraEnv, PROJECT_ENV_OPT_IN)) {
    delete env[PROJECT_ENV_OPT_IN];
  }

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('workflow entrypoints ignore a repository .env unless the parent opts in', async function (t) {
  const root = await temporaryDirectory(t, 'claude-workflow-env-security-');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  await fsp.mkdir(project);
  await fsp.mkdir(home);
  await fsp.writeFile(
    path.join(project, '.env'),
    `${PROJECT_MARKER}=from-project\n${PROJECT_ENV_OPT_IN}=true\n`,
    'utf8'
  );

  for (const entrypoint of [
    '/usr/local/bin/claude-workflow',
    '/opt/app/js/cli/claude-workflow.js',
    '/usr/local/bin/claude-workflow-gateway',
    '/opt/app/js/cli/claude-workflow-daemon.js',
  ]) {
    assert.deepEqual(probeEnvironmentLoader(project, home, entrypoint), { marker: '' });
  }

  assert.deepEqual(
    probeEnvironmentLoader(project, home, '/usr/local/bin/claude-workflow', {
      [PROJECT_ENV_OPT_IN]: 'true',
    }),
    { marker: 'from-project' }
  );
  assert.deepEqual(probeEnvironmentLoader(project, home, '/opt/app/js/index.js'), {
    marker: 'from-project',
  });

  await fsp.writeFile(
    path.join(home, '.ultrathink.env'),
    `${PROJECT_MARKER}=from-legacy-home\n`,
    'utf8'
  );
  await fsp.writeFile(
    path.join(home, '.claude-workflow.env'),
    `${PROJECT_MARKER}=from-workflow-home\n`,
    'utf8'
  );
  assert.deepEqual(probeEnvironmentLoader(project, home, '/usr/local/bin/claude-workflow'), {
    marker: 'from-workflow-home',
  });
  assert.deepEqual(
    probeEnvironmentLoader(project, home, '/usr/local/bin/claude-workflow', {
      [PROJECT_MARKER]: 'from-parent',
    }),
    { marker: 'from-parent' }
  );
});

test(
  'workflow env files are shell-safe, atomic, and private',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'claude-workflow-shell-security-');
    const stateDirectory = path.join(root, 'state');
    const target = path.join(stateDirectory, 'gateway.env');
    const commandSubstitutionMarker = path.join(root, 'command-substitution-ran');
    const backtickMarker = path.join(root, 'backtick-ran');
    await fsp.mkdir(stateDirectory, { mode: 0o755 });
    await fsp.writeFile(target, 'stale=true\n', { mode: 0o644 });

    const dangerousValue =
      `literal ' quote $HOME $(touch ${commandSubstitutionMarker}) ` +
      `\`touch ${backtickMarker}\`\nsecond line`;
    assert.equal(quotePosixShellValue("a'b"), `'a'"'"'b'`);
    assert.throws(() => quotePosixShellValue('bad\0value'), /NUL/u);
    assert.throws(
      () => serializeWorkflowEnvironment({ 'BAD-NAME': 'value' }),
      /invalid workflow environment variable name/u
    );

    const writtenPath = writeWorkflowEnvironmentFile(target, {
      DANGEROUS_VALUE: dangerousValue,
      EMPTY_VALUE: '',
      SIMPLE_VALUE: 'safe',
    });
    assert.equal(writtenPath, path.resolve(target));
    assert.equal((await fsp.stat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await fsp.readdir(stateDirectory)).sort(),
      ['gateway.env'],
      'atomic writer must not leave temporary files behind'
    );

    const shellResult = spawnSync(
      'bash',
      [
        '-c',
        `. "$1"; "$2" -e 'process.stdout.write(JSON.stringify({ dangerous: process.env.DANGEROUS_VALUE, empty: process.env.EMPTY_VALUE, simple: process.env.SIMPLE_VALUE }))'`,
        '_',
        target,
        process.execPath,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(shellResult.status, 0, shellResult.stderr);
    assert.deepEqual(JSON.parse(shellResult.stdout), {
      dangerous: dangerousValue,
      empty: '',
      simple: 'safe',
    });
    assert.equal(fs.existsSync(commandSubstitutionMarker), false);
    assert.equal(fs.existsSync(backtickMarker), false);

    const failedPublishTarget = path.join(stateDirectory, 'failed-publish.env');
    const originalChmodSync = fs.chmodSync;
    fs.chmodSync = function failPublishedFileChmod(targetPath, mode) {
      if (path.resolve(targetPath) === path.resolve(failedPublishTarget)) {
        throw new Error('simulated chmod failure');
      }
      return originalChmodSync(targetPath, mode);
    };
    try {
      assert.throws(
        () => writeWorkflowEnvironmentFile(failedPublishTarget, { VALUE: 'safe' }),
        /simulated chmod failure/u
      );
    } finally {
      fs.chmodSync = originalChmodSync;
    }
    assert.equal(
      fs.existsSync(failedPublishTarget),
      false,
      'a post-rename hardening failure must remove the published env file'
    );

    const unsafeCustomDirectory = path.join(root, 'unsafe-custom-state');
    await fsp.mkdir(unsafeCustomDirectory, { mode: 0o755 });
    await fsp.chmod(unsafeCustomDirectory, 0o755);
    assert.throws(
      () =>
        writeWorkflowEnvironmentFile(
          path.join(unsafeCustomDirectory, 'gateway.env'),
          { VALUE: 'safe' },
          { hardenExistingDirectory: false }
        ),
      /must not be accessible by group or other users/u
    );
  }
);

test('managed daemon rejects an undiscoverable ephemeral port', { concurrency: false }, function () {
  const previous = process.env.ULTRATHINK_GATEWAY_DAEMON_PORT;
  process.env.ULTRATHINK_GATEWAY_DAEMON_PORT = '0';
  try {
    assert.throws(() => daemonPort(), /between 1 and 65535/u);
  } finally {
    if (previous === undefined) {
      delete process.env.ULTRATHINK_GATEWAY_DAEMON_PORT;
    } else {
      process.env.ULTRATHINK_GATEWAY_DAEMON_PORT = previous;
    }
  }
});

test(
  'gateway traces rotate within byte/count limits and harden filesystem modes',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'gateway-trace-security-');
    const traceDirectory = path.join(root, 'trace');
    const activeTrace = path.join(traceDirectory, 'gateway-trace.jsonl');
    await fsp.mkdir(traceDirectory, { mode: 0o700 });
    await fsp.writeFile(
      activeTrace,
      `${JSON.stringify({ ts: new Date().toISOString(), event: 'legacy' })}\n`,
      { mode: 0o644 }
    );

    const tracer = createGatewayTracer({
      traceDir: traceDirectory,
      traceMaxBytes: 1024,
      traceMaxFiles: 3,
    });
    for (let index = 0; index < 12; index += 1) {
      await tracer.log('security.rotation', {
        index,
        payload: `entry-${index}-${'x'.repeat(300)}`,
      });
    }
    await tracer.close();
    assert.equal(tracer.lastError, null);
    assert.equal((await fsp.stat(traceDirectory)).mode & 0o777, 0o700);

    const traceFiles = (await fsp.readdir(traceDirectory))
      .filter((name) => name.startsWith('gateway-trace.jsonl'))
      .sort();
    assert.ok(traceFiles.includes('gateway-trace.jsonl.1'), 'rotation should create a backup');
    assert.ok(traceFiles.length <= 3, `expected at most 3 trace files, got ${traceFiles}`);
    for (const name of traceFiles) {
      const filePath = path.join(traceDirectory, name);
      const stats = await fsp.stat(filePath);
      assert.equal(stats.mode & 0o777, 0o600, `${name} must be private`);
      assert.ok(stats.size <= 1024, `${name} exceeded the configured byte cap`);
      const lines = (await fsp.readFile(filePath, 'utf8')).trim().split('\n').filter(Boolean);
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `${name} contains a partial JSONL record`);
      }
    }
  }
);

test(
  'gateway tracing rejects an existing shared directory without changing its mode',
  { skip: process.platform === 'win32' },
  async function (t) {
    const root = await temporaryDirectory(t, 'gateway-trace-shared-directory-');
    const traceDirectory = path.join(root, 'shared');
    await fsp.mkdir(traceDirectory, { mode: 0o755 });
    await fsp.chmod(traceDirectory, 0o755);

    const tracer = createGatewayTracer({ traceDir: traceDirectory });
    await tracer.log('security.must-not-write');
    await tracer.close();

    assert.match(
      tracer.lastError?.message || '',
      /must not be accessible by group or other users/u
    );
    assert.equal((await fsp.stat(traceDirectory)).mode & 0o777, 0o755);
    assert.equal(fs.existsSync(path.join(traceDirectory, 'gateway-trace.jsonl')), false);
  }
);

test('an oversized trace event is replaced by a bounded metadata record', async function (t) {
  const root = await temporaryDirectory(t, 'gateway-trace-entry-security-');
  const tracer = createGatewayTracer({
    traceDir: root,
    traceMaxBytes: 512,
    traceMaxFiles: 1,
  });
  await tracer.log('security.oversized', { payload: 'x'.repeat(10_000) });
  await tracer.close();

  const traceText = await fsp.readFile(tracer.traceFilePath, 'utf8');
  assert.ok(Buffer.byteLength(traceText) <= 512);
  const entry = JSON.parse(traceText);
  assert.equal(entry.event, 'security.oversized');
  assert.equal(entry.trace_entry_truncated, true);
  assert.ok(entry.original_bytes > 10_000);
});

test('a trace queue recovers a lock abandoned by a killed writer', async function (t) {
  const root = await temporaryDirectory(t, 'gateway-trace-stale-lock-');
  const lockDirectory = path.join(root, '.gateway-trace.lock');
  await fsp.mkdir(lockDirectory, { mode: 0o700 });
  const staleTime = new Date(Date.now() - 31_000);
  await fsp.utimes(lockDirectory, staleTime, staleTime);

  const tracer = createGatewayTracer({
    traceDir: root,
    traceMaxBytes: 512,
    traceMaxFiles: 1,
  });
  await tracer.log('security.stale-lock-recovered');
  await tracer.close();

  assert.equal(tracer.lastError, null);
  assert.equal(fs.existsSync(lockDirectory), false);
  const entry = JSON.parse(await fsp.readFile(tracer.traceFilePath, 'utf8'));
  assert.equal(entry.event, 'security.stale-lock-recovered');
});

test('concurrent tracers coordinate rotation in one directory', async function (t) {
  const root = await temporaryDirectory(t, 'gateway-trace-concurrent-');
  const config = { traceDir: root, traceMaxBytes: 1024, traceMaxFiles: 3 };
  const first = createGatewayTracer(config);
  const second = createGatewayTracer(config);
  await Promise.all(
    Array.from({ length: 80 }, function writeEntry(_, index) {
      const tracer = index % 2 === 0 ? first : second;
      return tracer.log('security.concurrent', {
        index,
        payload: 'x'.repeat(180),
      });
    })
  );
  await Promise.all([first.close(), second.close()]);
  assert.equal(first.lastError, null);
  assert.equal(second.lastError, null);

  const traceFiles = (await fsp.readdir(root)).filter((name) =>
    name.startsWith('gateway-trace.jsonl')
  );
  assert.ok(traceFiles.length <= 3);
  for (const name of traceFiles) {
    const lines = (await fsp.readFile(path.join(root, name), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  }
});
