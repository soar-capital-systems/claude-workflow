import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('../scripts/astra-workflow', import.meta.url).pathname;
const configModule = new URL('../js/gateway/workflow-config.js', import.meta.url).href;
const routingModule = new URL('../js/gateway/model-routing.js', import.meta.url).href;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mock = path.join(root, 'claude-workflow');
  fs.writeFileSync(mock, `#!/usr/bin/env node
(async () => {
  const { buildWorkflowGatewayConfig } = await import(${JSON.stringify(configModule)});
  const { resolveModelRoute } = await import(${JSON.stringify(routingModule)});
  const { config, mainModelId, subagentModelId } = buildWorkflowGatewayConfig();
  console.log(JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(),
    main: resolveModelRoute(mainModelId, config),
    agent: resolveModelRoute(subagentModelId, config),
    requestTimeoutMs: config.requestTimeoutMs,
    clientTimeoutMs: process.env.API_TIMEOUT_MS,
  }));
})();
`, { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(ASTRA_WORKFLOW_|ULTRATHINK_|CLAUDE_|ANTHROPIC_|API_TIMEOUT_MS$)/.test(key)));
  return (args = [], overrides = {}) => spawnSync('bash', [script, ...args], {
    env: { ...env, HOME: root, CLAUDE_CONFIG_DIR: root, PATH: `${root}:${process.env.PATH}`, ...overrides },
    encoding: 'utf8',
  });
}

function output(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('Astra main and agent resolve to independent efforts on the same model', t => {
  const [launch] = output(fixture(t)(['Review this diff.']));
  assert.equal(launch.main.provider, 'codex');
  assert.equal(launch.main.upstreamModel, 'gpt-6-astra');
  assert.equal(launch.main.reasoningEffort, 'xhigh');
  assert.equal(launch.agent.upstreamModel, 'gpt-6-astra');
  assert.equal(launch.agent.reasoningEffort, 'low');
  assert.equal(launch.requestTimeoutMs, 900000);
  assert.equal(launch.clientTimeoutMs, '1860000');
  assert.deepEqual(launch.args, ['Review this diff.']);
});

test('CLI overrides environment defaults and preserves native arguments after --', t => {
  const [launch] = output(fixture(t)([
    '--main-model=gpt-5.6-sol', '--main-effort', 'high',
    '--agent-model', 'gpt-5.6-terra', '--agent-effort=max',
    '--resume', 'session with spaces', '--', '--main-effort', 'untouched',
  ], { ASTRA_WORKFLOW_MAIN_EFFORT: 'low', ASTRA_WORKFLOW_AGENT_MODEL: 'gpt-6-astra' }));
  assert.equal(launch.main.upstreamModel, 'gpt-5.6-sol');
  assert.equal(launch.main.reasoningEffort, 'high');
  assert.equal(launch.agent.upstreamModel, 'gpt-5.6-terra');
  assert.equal(launch.agent.reasoningEffort, 'max');
  assert.deepEqual(launch.args, ['--resume', 'session with spaces', '--', '--main-effort', 'untouched']);
});

test('environment overrides and workspace selection work', t => {
  const [launch] = output(fixture(t)(['--workspace', os.tmpdir()], {
    ASTRA_WORKFLOW_MAIN_MODEL: 'gpt-5.6-sol', ASTRA_WORKFLOW_MAIN_EFFORT: 'medium',
    ASTRA_WORKFLOW_AGENT_MODEL: 'gpt-5.6-luna', ASTRA_WORKFLOW_AGENT_EFFORT: 'high',
  }));
  assert.equal(fs.realpathSync(launch.cwd), fs.realpathSync(os.tmpdir()));
  assert.equal(launch.main.upstreamModel, 'gpt-5.6-sol');
  assert.equal(launch.main.reasoningEffort, 'medium');
  assert.equal(launch.agent.upstreamModel, 'gpt-5.6-luna');
  assert.equal(launch.agent.reasoningEffort, 'high');
  assert.deepEqual(launch.args, []);
});

test('invalid or missing options fail before launching', t => {
  const run = fixture(t);
  for (const args of [ ['--main-model'], ['--agent-model='], ['--workspace'],
    ['--main-effort', 'typo'], ['--agent-effort', 'ultra'], ['--main-effort', '--resume'] ]) {
    const result = run(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /astra-workflow:/);
  }
});

test('operators can override Astra gateway and client deadlines', t => {
  const [launch] = output(fixture(t)([], {
    ULTRATHINK_GATEWAY_REQUEST_TIMEOUT_MS: '1200000', API_TIMEOUT_MS: '1260000',
  }));
  assert.equal(launch.requestTimeoutMs, 1200000);
  assert.equal(launch.clientTimeoutMs, '1260000');
});

test('launch and doctor use session settings without preparing persistent Claude state', t => {
  const run = fixture(t);
  const prepared = output(run(['hello']));
  assert.deepEqual(prepared.map(call => call.args), [['hello']]);
  const doctor = output(run(['doctor', '--json']));
  assert.deepEqual(doctor.map(call => call.args), [['doctor', '--json']]);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /ASTRA_WORKFLOW_MAIN_MODEL/);
  assert.equal(help.stderr, '');
});
