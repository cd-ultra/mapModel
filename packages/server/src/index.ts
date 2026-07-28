/**
 * Server entrypoint: resolve dependencies from the environment and listen.
 */

import { Pool } from 'pg';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { MemoryRepository, PostgresRepository, type Repository } from './db/repository.js';
import { OverpassClient } from './osm/overpassClient.js';
import { createStorage } from './storage/index.js';

const config = loadConfig();

let repository: Repository;
let pool: Pool | null = null;

if (config.databaseUrl) {
  pool = new Pool({ connectionString: config.databaseUrl });
  repository = new PostgresRepository(pool);
} else {
  console.warn(
    'DATABASE_URL is not set — using the in-memory repository. Data will not survive a restart.',
  );
  repository = new MemoryRepository();
}

const app = createApp({
  config,
  repository,
  storage: createStorage(config),
  overpass: new OverpassClient(config.overpass),
});

const server = app.listen(config.port, () => {
  console.log(`geo-model-editor API listening on :${config.port}`);
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
