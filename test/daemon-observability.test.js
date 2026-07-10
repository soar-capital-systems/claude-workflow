import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { loadGatewayConfig } from '../js/gateway/config.js';

const DAEMON_SCRIPT = path.resolve('scripts/claude-workflow-daemon.sh');
const DAEMON_JS = path.resolve('js/cli/claude-workflow-daemon.js');

function freePort() {
  return new Promise(function reservePort(resolve, reject) {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function resolvePort() {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(function closeServer(error) {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function runProcess(command, args, env) {
  return new Promise(function waitForProcess(resolve, reject) {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', function collectStdout(chunk) {
      stdout += chunk.toString();
    });
    child.stderr.on('data', function collectStderr(chunk) {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', function resolveProcess(code, signal) {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition(check, description, attempts = 80) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(function pause(resolve) {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function readPid(pidFile) {
  return Number((await fs.readFile(pidFile, 'utf8')).trim());
}

async function readHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.ok, true);
  return response.json();
}

async function stopDaemon(env, pidFile) {
  let pid = 0;
  try {
    pid = await readPid(pidFile);
  } catch {
    // The daemon may already be stopped.
  }
  await runProcess('bash', [DAEMON_SCRIPT, 'stop'], env);
  if (pid > 0) {
    await waitForCondition(
      function processExited() {
        return !processExists(pid);
      },
      `daemon process ${pid} to exit`
    );
  }
}

async function testTraceDisableAndRuntimeConfig() {
  const previous = {
    trace: process.env.ULTRATHINK_GATEWAY_TRACE_DIR,
    revision: process.env.ULTRATHINK_GATEWAY_RUNTIME_REVISION,
    startedAt: process.env.ULTRATHINK_GATEWAY_RUNTIME_STARTED_AT,
  };
  try {
    process.env.ULTRATHINK_GATEWAY_TRACE_DIR = 'off';
    process.env.ULTRATHINK_GATEWAY_RUNTIME_REVISION = 'revision-for-test';
    process.env.ULTRATHINK_GATEWAY_RUNTIME_STARTED_AT = '2026-07-10T00:00:00Z';
    const config = loadGatewayConfig();
    assert.equal(config.traceDir, '');
    assert.equal(config.runtimeRevision, 'revision-for-test');
    assert.equal(config.runtimeStartedAt, '2026-07-10T00:00:00Z');
  } finally {
    for (const [key, value] of Object.entries({
      ULTRATHINK_GATEWAY_TRACE_DIR: previous.trace,
      ULTRATHINK_GATEWAY_RUNTIME_REVISION: previous.revision,
      ULTRATHINK_GATEWAY_RUNTIME_STARTED_AT: previous.startedAt,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function testDaemonRevisionAndHealth() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-daemon-revision-'));
  const pidFile = path.join(stateDir, 'claude-workflow-gateway.pid');
  const revisionFile = path.join(stateDir, 'claude-workflow-gateway.revision');
  const envFile = path.join(stateDir, 'gateway.env');
  const traceDir = path.join(stateDir, 'gateway-trace');
  const port = await freePort();
  const env = {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: envFile,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDir,
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(port),
  };
  delete env.ULTRATHINK_GATEWAY_TRACE_DIR;
  delete env.ULTRATHINK_GATEWAY_RUNTIME_REVISION;
  delete env.ULTRATHINK_GATEWAY_RUNTIME_STARTED_AT;

  try {
    const start = await runProcess('bash', [DAEMON_SCRIPT, 'start'], env);
    assert.equal(start.code, 0, start.stderr || start.stdout);
    const firstPid = await readPid(pidFile);
    const firstRevision = (await fs.readFile(revisionFile, 'utf8')).trim();
    assert.match(firstRevision, /^[a-f0-9]{64}$/u);
    assert.equal(processExists(firstPid), true);
    if (process.platform !== 'win32') {
      const stateMode = (await fs.stat(stateDir)).mode & 0o777;
      const pidMode = (await fs.stat(pidFile)).mode & 0o777;
      const revisionMode = (await fs.stat(revisionFile)).mode & 0o777;
      const envMode = (await fs.stat(envFile)).mode & 0o777;
      assert.equal(stateMode & 0o077, 0);
      assert.equal(pidMode & 0o077, 0);
      assert.equal(revisionMode & 0o077, 0);
      assert.equal(envMode & 0o077, 0);
    }

    const firstHealth = await readHealth(port);
    assert.equal(firstHealth.runtime_revision, firstRevision);
    assert.equal(firstHealth.runtime_pid, firstPid);
    assert.equal(Number.isNaN(Date.parse(firstHealth.runtime_started_at)), false);
    assert.equal(firstHealth.trace_enabled, true);
    assert.equal(firstHealth.trace_dir, traceDir);
    assert.equal(firstHealth.trace_file, path.join(traceDir, 'gateway-trace.jsonl'));
    assert.equal(firstHealth.trace_max_bytes, 8 * 1024 * 1024);
    assert.equal(firstHealth.trace_max_files, 3);
    assert.equal(typeof firstHealth.codex_input_max_tokens, 'number');
    assert.equal(typeof firstHealth.codex_tool_result_max_bytes, 'number');
    assert.equal(typeof firstHealth.codex_tool_result_window_max_bytes, 'number');
    assert.equal(typeof firstHealth.codex_auto_compact_token_limit, 'number');
    assert.equal(typeof firstHealth.codex_auto_compact_token_limit_scope, 'string');

    await fs.writeFile(revisionFile, 'stale-revision\n', { mode: 0o600 });
    const restart = await runProcess('bash', [DAEMON_SCRIPT, 'start'], env);
    assert.equal(restart.code, 0, restart.stderr || restart.stdout);
    assert.match(restart.stdout, /healthy daemon is stale; restarting/u);
    const secondPid = await readPid(pidFile);
    assert.notEqual(secondPid, firstPid);
    await waitForCondition(function oldProcessExited() {
      return !processExists(firstPid);
    }, `stale daemon process ${firstPid} to exit`);
    const secondRevision = (await fs.readFile(revisionFile, 'utf8')).trim();
    const secondHealth = await readHealth(port);
    assert.equal(secondHealth.runtime_revision, secondRevision);
    assert.equal(secondHealth.runtime_pid, secondPid);

    await fs.writeFile(revisionFile, 'stale-again\n', { mode: 0o600 });
    const ensure = await runProcess('bash', [DAEMON_SCRIPT, 'ensure'], env);
    assert.equal(ensure.code, 0, ensure.stderr || ensure.stdout);
    const ensured = await waitForCondition(async function daemonWasReplaced() {
      const candidate = await readPid(pidFile);
      if (candidate === secondPid || !processExists(candidate)) {
        return null;
      }
      const revision = (await fs.readFile(revisionFile, 'utf8')).trim();
      const health = await readHealth(port);
      if (health.runtime_pid !== candidate || health.runtime_revision !== revision) {
        return null;
      }
      return { health, pid: candidate, revision };
    }, 'ensure to replace a healthy stale daemon');
    await waitForCondition(function secondProcessExited() {
      return !processExists(secondPid);
    }, `second stale daemon process ${secondPid} to exit`);
    assert.equal(ensured.health.runtime_revision, ensured.revision);
    assert.equal(ensured.health.runtime_pid, ensured.pid);

    await stopDaemon(env, pidFile);

    const traceDisabledEnv = {
      ...env,
      ULTRATHINK_GATEWAY_TRACE_DIR: 'off',
    };
    const disabledStart = await runProcess('bash', [DAEMON_SCRIPT, 'start'], traceDisabledEnv);
    assert.equal(disabledStart.code, 0, disabledStart.stderr || disabledStart.stdout);
    const disabledHealth = await readHealth(port);
    assert.equal(disabledHealth.trace_enabled, false);
    assert.equal(disabledHealth.trace_dir, null);
    assert.equal(disabledHealth.trace_file, null);
    await stopDaemon(traceDisabledEnv, pidFile);
  } finally {
    try {
      await stopDaemon(env, pidFile);
    } catch {
      // Best-effort cleanup for failed assertions.
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function testManagedPortValidation() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-daemon-port-'));
  const pidFile = path.join(stateDir, 'claude-workflow-gateway.pid');
  const env = {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDir,
    ULTRATHINK_GATEWAY_DAEMON_PORT: '0',
  };

  try {
    const result = await runProcess('bash', [DAEMON_SCRIPT, 'start'], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must be between 1 and 65535/u);
    await assert.rejects(fs.access(pidFile));
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function testRelativeManagerPathsAreRejected() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-daemon-paths-'));
  const absoluteState = path.join(root, 'state');
  const baseEnv = {
    ...process.env,
    HOME: root,
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(await freePort()),
  };

  try {
    const relativeState = await runProcess('bash', [DAEMON_SCRIPT, 'status'], {
      ...baseEnv,
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: 'relative-state',
    });
    assert.equal(relativeState.code, 1);
    assert.match(relativeState.stderr, /must resolve to an absolute path/u);

    const relativeEnvFile = await runProcess('bash', [DAEMON_SCRIPT, 'status'], {
      ...baseEnv,
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: absoluteState,
      CLAUDE_WORKFLOW_GATEWAY_ENV_FILE: 'relative.env',
    });
    assert.equal(relativeEnvFile.code, 1);
    assert.match(relativeEnvFile.stderr, /ENV_FILE must be an absolute path/u);

    const relativeTrace = await runProcess('bash', [DAEMON_SCRIPT, 'status'], {
      ...baseEnv,
      CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: absoluteState,
      ULTRATHINK_GATEWAY_TRACE_DIR: 'relative-trace',
    });
    assert.equal(relativeTrace.code, 1);
    assert.match(relativeTrace.stderr, /TRACE_DIR must be absolute/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testStateDirectorySymlinkIsRejected() {
  if (process.platform === 'win32') {
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-daemon-state-link-'));
  const target = path.join(root, 'target');
  const stateLink = path.join(root, 'state');
  await fs.mkdir(target, { mode: 0o755 });
  await fs.chmod(target, 0o755);
  await fs.symlink(target, stateLink);
  const env = {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateLink,
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(await freePort()),
  };

  try {
    const result = await runProcess('bash', [DAEMON_SCRIPT, 'start'], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /state directory must not be a symlink/u);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testStopRejectsUnrelatedPidWithDaemonPathArgument() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workflow-daemon-pid-'));
  const pidFile = path.join(stateDir, 'claude-workflow-gateway.pid');
  const innocent = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);', DAEMON_JS],
    { stdio: 'ignore' }
  );
  const env = {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDir,
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(await freePort()),
  };

  try {
    await waitForCondition(() => processExists(innocent.pid), 'innocent process to start');
    await fs.writeFile(pidFile, `${innocent.pid}\n`, { mode: 0o600 });
    const stopped = await runProcess('bash', [DAEMON_SCRIPT, 'stop'], env);
    assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
    assert.match(stopped.stdout, /not running/u);
    assert.equal(
      processExists(innocent.pid),
      true,
      'manager must not signal a process that only mentions the daemon path in a later argument'
    );
    await assert.rejects(fs.access(pidFile));
  } finally {
    if (processExists(innocent.pid)) {
      innocent.kill('SIGTERM');
      await waitForCondition(() => !processExists(innocent.pid), 'innocent process to exit');
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function testManagedPortChangeReplacesRecordedDaemon() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-daemon-port-change-'));
  const pidFile = path.join(stateDir, 'claude-workflow-gateway.pid');
  const firstPort = await freePort();
  const secondPort = await freePort();
  const baseEnv = {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDir,
  };
  const firstEnv = { ...baseEnv, ULTRATHINK_GATEWAY_DAEMON_PORT: String(firstPort) };
  const secondEnv = { ...baseEnv, ULTRATHINK_GATEWAY_DAEMON_PORT: String(secondPort) };

  try {
    const firstStart = await runProcess('bash', [DAEMON_SCRIPT, 'start'], firstEnv);
    assert.equal(firstStart.code, 0, firstStart.stderr || firstStart.stdout);
    const firstPid = await readPid(pidFile);

    const secondStart = await runProcess('bash', [DAEMON_SCRIPT, 'start'], secondEnv);
    assert.equal(secondStart.code, 0, secondStart.stderr || secondStart.stdout);
    assert.match(secondStart.stdout, /recorded daemon is not healthy on requested port/u);
    const secondPid = await readPid(pidFile);
    assert.notEqual(secondPid, firstPid);
    await waitForCondition(() => !processExists(firstPid), `old port daemon ${firstPid} to exit`);
    const health = await readHealth(secondPort);
    assert.equal(health.runtime_pid, secondPid);
    await assert.rejects(fetch(`http://127.0.0.1:${firstPort}/healthz`));
  } finally {
    try {
      await stopDaemon(secondEnv, pidFile);
    } catch {
      // Best-effort cleanup for failed assertions.
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function testForeignHealthCannotClaimDaemonOwnership() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ultrathink-daemon-foreign-health-'));
  const pidFile = path.join(stateDir, 'claude-workflow-gateway.pid');
  const daemonPort = await freePort();
  const foreignPort = await freePort();
  const daemonEnv = {
    ...process.env,
    CLAUDE_WORKFLOW_GATEWAY_STATE_DIR: stateDir,
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(daemonPort),
  };
  const foreignEnv = {
    ...daemonEnv,
    ULTRATHINK_GATEWAY_DAEMON_PORT: String(foreignPort),
  };
  const foreignServer = net.createServer(function replyToHealth(socket) {
    const body = JSON.stringify({ ok: true, service: 'unrelated-service' });
    socket.end(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
  });
  const foreignSockets = new Set();
  foreignServer.on('connection', function trackSocket(socket) {
    foreignSockets.add(socket);
    socket.once('close', () => foreignSockets.delete(socket));
  });

  try {
    const started = await runProcess('bash', [DAEMON_SCRIPT, 'start'], daemonEnv);
    assert.equal(started.code, 0, started.stderr || started.stdout);
    const daemonPid = await readPid(pidFile);
    foreignServer.listen(foreignPort, '127.0.0.1');
    await new Promise((resolve, reject) => {
      foreignServer.once('listening', resolve);
      foreignServer.once('error', reject);
    });

    const collision = await runProcess('bash', [DAEMON_SCRIPT, 'start'], foreignEnv);
    assert.equal(collision.code, 1);
    assert.match(collision.stderr, /belongs to another process/u);
    assert.equal(processExists(daemonPid), true);
    assert.equal(await readPid(pidFile), daemonPid);
  } finally {
    if (foreignServer.listening) {
      for (const socket of foreignSockets) {
        socket.destroy();
      }
      await new Promise((resolve) => foreignServer.close(resolve));
    }
    try {
      await stopDaemon(daemonEnv, pidFile);
    } catch {
      // Best-effort cleanup for failed assertions.
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

await testTraceDisableAndRuntimeConfig();
await testManagedPortValidation();
await testRelativeManagerPathsAreRejected();
await testStateDirectorySymlinkIsRejected();
await testStopRejectsUnrelatedPidWithDaemonPathArgument();
await testForeignHealthCannotClaimDaemonOwnership();
await testManagedPortChangeReplacesRecordedDaemon();
await testDaemonRevisionAndHealth();
process.stdout.write('PASS daemon revision recycling and health diagnostics\n');
