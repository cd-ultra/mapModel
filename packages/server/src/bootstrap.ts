/**
 * Wires `AppDependencies` from environment/config. Shared by the long-running
 * server entrypoint (`index.ts`) and the Vercel serverless entrypoint
 * (`api/[...path].ts` at the repo root) so the two never drift.
 */

import { Pool } from 'pg';
import type { AppDependencies } from './app.js';
import { loadConfig, type ServerConfig } from './config.js';
import { createJwtVerifier } from './auth/jwtVerifier.js';
import { MemoryRepository, PostgresRepository, type Repository } from './db/repository.js';
import { OverpassClient } from './osm/overpassClient.js';
import { createStorage } from './storage/index.js';

export interface Bootstrapped extends AppDependencies {
  /** Exposed so the caller can drain/close it on shutdown; null in-memory. */
  pool: Pool | null;
}

export function bootstrap(
  config: ServerConfig = loadConfig(),
  poolOptions: { max?: number } = {},
): Bootstrapped {
  if (config.authRequired && !config.jwtSecret) {
    throw new Error(
      'AUTH_REQUIRED is true but JWT_SECRET is not set: no bearer token could ever verify.',
    );
  }

  let repository: Repository;
  let pool: Pool | null = null;

  if (config.databaseUrl) {
    pool = new Pool({ connectionString: config.databaseUrl, ...poolOptions });
    repository = new PostgresRepository(pool);
  } else {
    console.warn(
      'DATABASE_URL is not set — using the in-memory repository. Data will not survive a restart.',
    );
    repository = new MemoryRepository();
  }

  return {
    config,
    repository,
    storage: createStorage(config),
    overpass: new OverpassClient(config.overpass),
    ...(config.jwtSecret ? { verifyToken: createJwtVerifier(config.jwtSecret) } : {}),
    pool,
  };
}
