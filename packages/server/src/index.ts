/**
 * Server entrypoint: resolve dependencies from the environment and listen.
 */

import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';

const { pool, ...deps } = bootstrap();
const app = createApp(deps);

const server = app.listen(deps.config.port, () => {
  console.log(`geo-model-editor API listening on :${deps.config.port}`);
});

/** Drain in-flight requests before exiting so a deploy does not drop them. */
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    void pool?.end().finally(() => process.exit(0));
    if (!pool) process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
