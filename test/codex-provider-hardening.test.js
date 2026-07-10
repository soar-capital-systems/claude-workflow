import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexSessionManager } from '../js/gateway/codex-provider.js';

const MODEL = 'claude-sonnet-4-7';
const activeSessions = new Set();
let currentStage = 'bootstrap';

function beginStage(name) {
  currentStage = name;
  if (process.env.CODEX_HARDENING_DEBUG === '1') {
    process.stderr.write(`Codex hardening stage: ${name}\n`);
  }
}

function trackManager(manager) {
  const createSession = manager.createSession;
  manager.createSession = function createTrackedSession(...args) {
    const session = createSession(...args);
    activeSessions.add(session);
    return session;
  };
  return manager;
}

function forceKillTrackedAppServers() {
  for (const session of activeSessions) {
    const child = session.connection?.child;
    if (!Number.isInteger(child?.pid)) {
      continue;
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
        continue;
      } catch {
        // Fall back to the direct child.
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Best-effort watchdog cleanup.
    }
  }
}

function request(sessionId) {
  const headers = {
    'x-claude-code-session-id': sessionId,
    'x-claude-code-agent-id': 'agent-hardening',
    'x-claude-code-parent-agent-id': 'parent-hardening',
  };
  return {
    get(name) {
      return headers[String(name).toLowerCase()] || '';
    },
  };
}

function route() {
  return {
    provider: 'codex',
    requestedModel: MODEL,
    upstreamModel: 'gpt-5.6-terra',
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    reasoningEffort: 'max',
    verbosity: 'low',
  };
}

function body(text, tools = []) {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: text }],
    tools,
  };
}

function toolResultBody(callId, content, tools) {
  return {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Run the external tool.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: 'Bash', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: callId, content }],
      },
    ],
    tools,
  };
}

function managerConfig(command, cwd, overrides = {}) {
  return {
    requestTimeoutMs: 2_000,
    codex: {
      command,
      cwd,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      idleTimeoutMs: 0,
      forkIdleTimeoutMs: 30,
      closeKillTimeoutMs: 100,
      maxSessions: 16,
      pendingToolTimeoutMs: 1_000,
      ...overrides,
    },
  };
}

async function makeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

async function waitFor(check, description, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise(function pause(resolve) {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map(function parse(line) {
        return JSON.parse(line);
      });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function finalAppServer(logPath, userAgent = 'codex_cli_rs/0.144.1') {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
log({ event: 'process', cwd: process.cwd(), pid: process.pid });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: ${JSON.stringify(userAgent)} } });
    return;
  }
  if (message.method === 'thread/start') {
    log({ event: 'thread', cwd: message.params.cwd, environments: message.params.environments, config: message.params.config });
    send({ id: message.id, result: { thread: { id: 'thread-' + process.pid } } });
    return;
  }
  if (message.method === 'turn/start') {
    log({ event: 'turn', effort: message.params.effort });
    const turnId = 'turn-' + process.pid;
    send({ id: message.id, result: { turn: { id: turnId } } });
    setTimeout(function complete() {
      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: 'message', delta: 'DONE' } });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
    }, 10);
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function toolAppServer(logPath) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const logPath = ${JSON.stringify(logPath)};
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
log({ event: 'process', pid: process.pid });
let turnId = '';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', function onLine(line) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.144.1' } });
    return;
  }
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread-' + process.pid } } });
    return;
  }
  if (message.method === 'turn/start') {
    turnId = 'turn-' + process.pid;
    send({ id: message.id, result: { turn: { id: turnId } } });
    setImmediate(function requestTool() {
      send({ id: 900, method: 'item/tool/call', params: {
        turnId,
        callId: 'call_pending',
        tool: 'ext_tool_001',
        arguments: { command: 'printf hardening' }
      } });
      send({ method: 'thread/tokenUsage/updated', params: {
        turnId,
        tokenUsage: { last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      } });
    });
    return;
  }
  if (message.id === 900 && message.result) {
    log({ event: 'tool_result', pid: process.pid, text: message.result.contentItems?.[0]?.text });
    setImmediate(function complete() {
      send({ method: 'item/agentMessage/delta', params: { turnId, itemId: 'message', delta: 'CONTINUED' } });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
    });
  }
});
setInterval(function keepAlive() {}, 1000);
`;
}

function closedStdinAppServer() {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', function onInitialize(line) {
  const message = JSON.parse(line);
  send({ id: message.id, result: { userAgent: 'codex_cli_rs/0.144.1' } });
  setImmediate(function closeInput() {
    rl.close();
    fs.closeSync(0);
  });
});
setInterval(function keepAlive() {}, 1000);
`;
}

async function testDynamicToolsOnlyThreadMode() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-environments-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, finalAppServer(logPath));

  const configuredManager = trackManager(
    new CodexSessionManager(managerConfig(command, tempDir, { dynamicToolsOnly: false }))
  );
  const dynamicOnlyManager = trackManager(
    new CodexSessionManager(managerConfig(command, tempDir, { dynamicToolsOnly: true }))
  );
  try {
    await configuredManager.processRequest(request('configured-cwd'), body('Configured cwd.'), route());
    await dynamicOnlyManager.processRequest(request('dynamic-only'), body('Dynamic tools only.'), route());

    const threadStarts = (await readJsonLines(logPath)).filter(function thread(entry) {
      return entry.event === 'thread';
    });
    assert.equal(threadStarts.length, 2);
    const turns = (await readJsonLines(logPath)).filter(function turn(entry) {
      return entry.event === 'turn';
    });
    assert.equal(turns.length, 2);
    assert.equal(Object.hasOwn(threadStarts[0], 'environments'), false);
    assert.deepEqual(threadStarts[1].environments, []);
    assert.equal(turns[0].effort, 'max');
    assert.equal(turns[1].effort, 'max');
    assert.equal(threadStarts[0].config.model_verbosity, 'low');
    assert.equal(threadStarts[1].config.model_verbosity, 'low');
  } finally {
    await Promise.all([configuredManager.close(), dynamicOnlyManager.close()]);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testDynamicToolsOnlyVersionGate() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-version-'));
  const command = path.join(tempDir, 'fake-codex-old');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, finalAppServer(logPath, 'codex_cli_rs/0.143.0'));
  const manager = trackManager(
    new CodexSessionManager(managerConfig(command, tempDir, { dynamicToolsOnly: true }))
  );
  try {
    await assert.rejects(
      manager.processRequest(request('old-dynamic-only'), body('Reject old Codex.'), route()),
      /requires Codex CLI 0\.144\.1 or newer/u
    );
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testPendingToolRetentionAndHardCapacity() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-pending-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, toolAppServer(logPath));
  const tools = [
    {
      name: 'Bash',
      description: 'Run a shell command.',
      input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ];
  const manager = trackManager(
    new CodexSessionManager(
      managerConfig(command, tempDir, {
        idleTimeoutMs: 15,
        forkIdleTimeoutMs: 15,
        pendingToolTimeoutMs: 500,
        maxSessions: 1,
      })
    )
  );

  try {
    const first = await manager.processRequest(
      request('pending-session'),
      body('Run the external tool.', tools),
      route()
    );
    assert.equal(first.type, 'tool_use');
    assert.equal(first.toolCall.id, 'call_pending');

    await new Promise(function waitPastIdle(resolve) {
      setTimeout(resolve, 60);
    });
    assert.equal(manager.sessions.size, 1, 'pending tool call expired on the ordinary idle timer');

    await assert.rejects(
      manager.processRequest(request('capacity-session'), body('A second session.', tools), route()),
      function atCapacity(error) {
        return error?.status === 503 && /max_sessions=1/u.test(error.message);
      }
    );
    assert.equal(manager.sessions.size, 1);
    const processesBeforeContinuation = (await readJsonLines(logPath)).filter(function processEntry(entry) {
      return entry.event === 'process';
    });
    assert.equal(processesBeforeContinuation.length, 1, 'capacity rejection spawned another app-server');

    const continued = await manager.processRequest(
      request('pending-session'),
      toolResultBody('call_pending', 'TOOL_RESULT_OK', tools),
      route()
    );
    assert.equal(continued.type, 'final');
    assert.equal(continued.text, 'CONTINUED');
    const toolResults = (await readJsonLines(logPath)).filter(function result(entry) {
      return entry.event === 'tool_result';
    });
    assert.deepEqual(toolResults.map(function text(entry) { return entry.text; }), ['TOOL_RESULT_OK']);
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testPendingToolTimeout() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-pending-timeout-'));
  const command = path.join(tempDir, 'fake-codex');
  const logPath = path.join(tempDir, 'app-server.jsonl');
  await makeExecutable(command, toolAppServer(logPath));
  const tools = [{ name: 'Bash', description: 'Run.', input_schema: { type: 'object' } }];
  const manager = trackManager(
    new CodexSessionManager(
      managerConfig(command, tempDir, {
        idleTimeoutMs: 5,
        pendingToolTimeoutMs: 50,
        maxSessions: 1,
      })
    )
  );

  try {
    const outcome = await manager.processRequest(
      request('pending-timeout'),
      body('Leave the tool pending.', tools),
      route()
    );
    assert.equal(outcome.type, 'tool_use');
    await waitFor(
      function expired() {
        return manager.sessions.size === 0;
      },
      'pending tool timeout'
    );
    await manager.close();
    const processes = (await readJsonLines(logPath)).filter((entry) => entry.event === 'process');
    assert.equal(processes.length, 1);
    await waitFor(
      function appServerExited() {
        return !processExists(processes[0].pid);
      },
      'pending-timeout app-server exit'
    );
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testStdinEpipeDoesNotCrashGateway() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-provider-epipe-'));
  const command = path.join(tempDir, 'fake-codex');
  await makeExecutable(command, closedStdinAppServer());
  const manager = trackManager(new CodexSessionManager(managerConfig(command, tempDir)));

  try {
    await assert.rejects(
      manager.processRequest(request('stdin-epipe'), body('Trigger EPIPE.'), route()),
      /stdin failed|EPIPE|not available/u
    );
    await waitFor(
      function evicted() {
        return manager.sessions.size === 0;
      },
      'EPIPE session eviction'
    );
  } finally {
    await manager.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testProviderInChildProcess() {
  if (process.argv.includes('--epipe-child')) {
    await testStdinEpipeDoesNotCrashGateway();
    return true;
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--epipe-child'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', function collect(chunk) {
    stderr += chunk.toString();
  });
  const result = await new Promise(function wait(resolve, reject) {
    child.once('error', reject);
    child.once('close', function closed(code, signal) {
      resolve({ code, signal });
    });
  });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  return false;
}

const watchdog = setTimeout(function hardeningWatchdogExpired() {
  const diagnostics = Array.from(activeSessions, (session) => ({
    disposed: session.disposed,
    pendingToolCall: Boolean(session.pendingToolCall),
    childPid: session.connection?.child?.pid || null,
    childExitCode: session.connection?.child?.exitCode ?? null,
    childSignalCode: session.connection?.child?.signalCode ?? null,
    pendingRequests: session.connection?.pendingRequests?.size ?? null,
  }));
  forceKillTrackedAppServers();
  process.stderr.write(
    `FAIL Codex provider hardening exceeded its 20-second watchdog during ${currentStage}: ` +
      `${JSON.stringify(diagnostics)}\n`
  );
  process.exit(1);
}, 20_000);

try {
  beginStage('EPIPE child process');
  const epipeChild = await testProviderInChildProcess();
  if (!epipeChild) {
    beginStage('dynamic-tools thread mode');
    await testDynamicToolsOnlyThreadMode();
    beginStage('dynamic-tools version gate');
    await testDynamicToolsOnlyVersionGate();
    beginStage('pending-tool retention and capacity');
    await testPendingToolRetentionAndHardCapacity();
    beginStage('pending-tool timeout');
    await testPendingToolTimeout();
    process.stdout.write('PASS Codex provider environment, capacity, pending-tool, and EPIPE hardening\n');
  }
} finally {
  clearTimeout(watchdog);
}
