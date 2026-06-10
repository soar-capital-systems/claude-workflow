#!/usr/bin/env node

import process from 'node:process';

import { createGatewayServer } from './gateway/server.js';

const runtime = createGatewayServer();

runtime.server.on('listening', function onListening() {
  const address = runtime.server.address();
  const host = typeof address === 'object' && address ? address.address : runtime.config.host;
  const port = typeof address === 'object' && address ? address.port : runtime.config.port;
  console.error(`Claude Workflow gateway listening on http://${host}:${port}`);
});

runtime.server.on('error', function onError(error) {
  console.error('Fatal error starting Anthropic gateway:', error);
  process.exitCode = 1;
});

async function closeAndExit() {
  await runtime.close();
  process.exit(0);
}

process.on('SIGINT', closeAndExit);
process.on('SIGTERM', closeAndExit);
