#!/usr/bin/env node
/*
  PotDB start script
  - Reads peers and bearer token from env/config
  - Starts Express server on configurable port
  - Ensures LevelDB initialized by importing storage
  - Handles graceful shutdown and cleanup
  - Logs replication events, conflicts, and transaction commits (emitted by modules)
*/

const { startServer } = require('./dist/index.js');
const { closeDb } = require('./dist/storage/index.js');
const { getPeers } = require('./dist/config/index.js');
const { getLocalAuthToken } = require('./dist/auth/index.js');

function maskToken(token) {
  if (!token) return undefined;
  if (token.length <= 4) return '****';
  return token.slice(0, 2) + '***' + token.slice(-2);
}

async function main() {
  const PORT = Number(process.env.PORT || process.env.POTDB_PORT || 3000);

  // Log startup config
  // eslint-disable-next-line no-console
  console.log('[start] PotDB starting...');
  // eslint-disable-next-line no-console
  console.log('[start] Time:', new Date().toISOString());
  // eslint-disable-next-line no-console
  console.log('[start] Port:', PORT);
  // eslint-disable-next-line no-console
  console.log('[start] Peers:', getPeers());
  const token = getLocalAuthToken();
  // eslint-disable-next-line no-console
  console.log('[start] Auth token:', token ? maskToken(token) : 'none');

  // Start HTTP server
  const server = startServer(PORT);

  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[start] Shutting down (${reason})...`);

    // Stop accepting new connections
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });

    // Close LevelDB
    try {
      await closeDb();
    } catch (e) {
      // ignore
    }

    // eslint-disable-next-line no-console
    console.log('[start] Shutdown complete.');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    // eslint-disable-next-line no-console
    console.error('[start] Unhandled rejection:', err);
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error('[start] Uncaught exception:', err);
    shutdown('uncaughtException');
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[start] Fatal error:', e);
  process.exit(1);
});
