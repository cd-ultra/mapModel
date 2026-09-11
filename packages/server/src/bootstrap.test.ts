import { describe, expect, it } from 'vitest';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { MemoryRepository } from './db/repository.js';

function config(overrides: Partial<Parameters<typeof loadConfig>[0]> = {}) {
  return loadConfig({ ...overrides } as NodeJS.ProcessEnv);
}

describe('bootstrap', () => {
  it('refuses to build an authenticated server with no JWT_SECRET', () => {
    expect(() => bootstrap(config({ AUTH_REQUIRED: 'true' }))).toThrow(/JWT_SECRET/);
  });

  it('falls back to the in-memory repository with no DATABASE_URL', () => {
    const deps = bootstrap(config());
    expect(deps.repository).toBeInstanceOf(MemoryRepository);
    expect(deps.pool).toBeNull();
  });

  it('wires a real verifyToken once a secret is configured', () => {
    const deps = bootstrap(config({ AUTH_REQUIRED: 'true', JWT_SECRET: 'shh' }));
    expect(deps.verifyToken).toBeTypeOf('function');
  });
});
