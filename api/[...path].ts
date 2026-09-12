/**
 * Vercel serverless entrypoint for the Express API. Uses the same
 * `bootstrap()` as `packages/server/src/index.ts`, but skips `listen`/signal
 * handling — Vercel's Node runtime invokes the exported handler per-request.
 * Module-scope state (the pool, the app) is reused across warm invocations of
 * the same instance, so it is built once here rather than per-request.
 */

import { createApp } from '@gme/server/app';
import { bootstrap } from '@gme/server/bootstrap';

const { pool: _pool, ...deps } = bootstrap(undefined, {
  // Serverless scales by spawning instances, not by opening more connections
  // per instance — keep each instance's pool small so a burst of concurrent
  // invocations doesn't exhaust the database's connection limit.
  max: 1,
});

export default createApp(deps);
