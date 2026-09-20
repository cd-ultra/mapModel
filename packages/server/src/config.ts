/**
 * Server configuration from the environment.
 *
 * Every external dependency is optional and has an in-process fallback, so the
 * API can be started and exercised with nothing installed: no Postgres, no S3,
 * no Overpass credentials. That keeps `npm run dev:server` useful on day one
 * and makes the route tests hermetic.
 */

export interface ServerConfig {
  port: number;
  /** Postgres connection string. Unset means the in-memory repository is used. */
  databaseUrl: string | null;
  /** Origins allowed to call the API. */
  corsOrigins: string[];
  overpass: {
    endpoint: string;
    /** How long a footprint stays cached. OSM buildings change rarely. */
    cacheTtlMs: number;
    maxCacheEntries: number;
    timeoutMs: number;
  };
  storage: {
    /**
     * 's3' when a bucket is configured, 'blob' when a Vercel Blob store is
     * connected (BLOB_READ_WRITE_TOKEN is injected automatically), otherwise
     * local disk.
     */
    driver: 's3' | 'blob' | 'local';
    bucket: string | null;
    region: string | null;
    endpoint: string | null;
    /** Directory used by the local driver. */
    localDir: string;
    publicBaseUrl: string | null;
  };
  /** When false, requests are attributed to an anonymous development user. */
  authRequired: boolean;
  /** HS256 signing secret for bearer tokens. Null means no token can verify. */
  jwtSecret: string | null;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const bucket = env['S3_BUCKET'] ?? null;

  return {
    port: envInt('PORT', 8787),
    databaseUrl: env['DATABASE_URL'] ?? null,
    corsOrigins: envList('CORS_ORIGINS', ['http://localhost:5173']),
    overpass: {
      endpoint: env['OVERPASS_ENDPOINT'] ?? 'https://overpass-api.de/api/interpreter',
      // 24h: building footprints are effectively static, and this is the whole
      // point of proxying rather than letting browsers hit Overpass directly.
      cacheTtlMs: envInt('OVERPASS_CACHE_TTL_MS', 24 * 60 * 60 * 1000),
      maxCacheEntries: envInt('OVERPASS_CACHE_MAX', 5000),
      timeoutMs: envInt('OVERPASS_TIMEOUT_MS', 30_000),
    },
    storage: {
      driver: bucket ? 's3' : env['BLOB_READ_WRITE_TOKEN'] ? 'blob' : 'local',
      bucket,
      region: env['S3_REGION'] ?? null,
      endpoint: env['S3_ENDPOINT'] ?? null,
      localDir: env['LOCAL_STORAGE_DIR'] ?? '.storage',
      publicBaseUrl: env['STORAGE_PUBLIC_BASE_URL'] ?? null,
    },
    authRequired: env['AUTH_REQUIRED'] === 'true',
    jwtSecret: env['JWT_SECRET'] ?? null,
  };
}
