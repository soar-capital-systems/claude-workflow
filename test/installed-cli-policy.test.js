import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSTALLED_CLI_REQUIRED_ENV_NAME,
  installedCliPolicy,
} from './helpers/installed-cli-policy.js';

const MISSING_COMMAND = 'claude-workflow-cli-that-does-not-exist';

test('missing installed CLIs remain an explicit optional-test skip by default', function () {
  const policy = installedCliPolicy({
    command: MISSING_COMMAND,
    displayName: 'Fixture CLI',
    env: {},
  });

  assert.equal(policy.available, false);
  assert.equal(policy.required, false);
  assert.match(policy.skip, /Fixture CLI is unavailable/u);
});

test('required installed CLIs fail instead of silently skipping', function () {
  assert.throws(
    () =>
      installedCliPolicy({
        command: MISSING_COMMAND,
        displayName: 'Fixture CLI',
        env: { [INSTALLED_CLI_REQUIRED_ENV_NAME]: '1' },
      }),
    /requires installed CLI contract tests to run/u
  );
});

test('an available required CLI reports its version and never skips', function () {
  const policy = installedCliPolicy({
    command: process.execPath,
    displayName: 'Node.js',
    env: { ...process.env, [INSTALLED_CLI_REQUIRED_ENV_NAME]: 'true' },
  });

  assert.equal(policy.available, true);
  assert.equal(policy.required, true);
  assert.equal(policy.skip, false);
  assert.match(policy.version, /^v\d+/u);
});
