/**
 * Vercel serverless entrypoint for the Express API. Uses the same
 * `bootstrap()` as `packages/server/src/index.ts`, but skips `listen`/signal
 * handling — Vercel's Node runtime invokes the exported handler per-request.
 * Module-scope state (the pool, the app) is reused across warm invocations of
 * the same instance, so it is built once here rather than per-request.
 */

import { createApp } from '@gme/server/app';
import { bootstrap, migrate } from '@gme/server/bootstrap';

const bootstrapped = bootstrap(undefined, {
  // Serverless scales by spawning instances, not by opening more connections
  // per instance — keep each instance's pool small so a burst of concurrent
  // invocations doesn't exhaust the database's connection limit.
  max: 1,
});

// Cold starts pay for this once (module-scope state is reused across warm
// invocations); it also means a fresh deploy's database is never queried
// against a schema that hasn't caught up yet — there is no separate
// deploy-time migration step on Vercel.
await migrate(bootstrapped);

const { pool: _pool, ...deps } = bootstrapped;

export default createApp(deps);
