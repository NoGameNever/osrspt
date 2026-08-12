'use strict';

const { config, checkEnv } = require('./config');
const { connectDb, disconnectDb } = require('./db');
const { createApp } = require('./app');
const prices = require('./services/prices');

async function main() {
  const missing = checkEnv();
  if (missing.length > 0) {
    console.warn(
      `[startup] Missing environment variables: ${missing.join(', ')}.\n` +
        '          Copy .env.example to .env and fill them in.\n' +
        '          The server will still start, but features needing them will return clear errors.'
    );
  }

  await connectDb();

  const app = createApp();

  // Bind 0.0.0.0 so Render (and any container host) can route traffic in.
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[startup] OSRSpt listening on port ${config.port} (${config.env})`);
  });

  // Pull the ~860 kB GE item mapping in the background so the first price
  // question does not pay for it. Failure here is non-fatal; the cache will
  // fill on demand instead.
  prices.warmUp();

  const shutdown = async (signal) => {
    console.log(`[shutdown] received ${signal}`);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled rejection:', reason && reason.message ? reason.message : reason);
  });
}

main().catch((err) => {
  console.error('[fatal] failed to start:', err.message);
  process.exit(1);
});
