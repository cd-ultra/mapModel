/**
 * Express application assembly.
 *
 * Built as a factory taking its dependencies explicitly so tests can construct
 * an app with an in-memory repository, a local storage directory, and a stubbed
 * Overpass client — no network, no database, no S3.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { OSM_ATTRIBUTION } from '@gme/shared';
import type { ServerConfig } from './config.js';
import { authenticate, AuthError, type TokenVerifier } from './auth/middleware.js';
import { OverpassClient, OverpassError } from './osm/overpassClient.js';
import type { Repository } from './db/repository.js';
import { contentKey, type StorageAdapter } from './storage/index.js';
import {
  createEditedModelSchema,
  createExtractionSchema,
  footprintQuerySchema,
} from './schemas.js';

export interface AppDependencies {
  config: ServerConfig;
  repository: Repository;
  storage: StorageAdapter;
  overpass: OverpassClient;
  verifyToken?: TokenVerifier;
}

/** Wrap an async handler so rejections reach the error middleware. */
function route(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/**
 * Read a path parameter as a single string.
 *
 * Express 5 types params as possibly-repeated, and a request like
 * `/api/models/a/mesh?id=b` can genuinely produce an array. Collapsing it here
 * keeps every handler from having to think about it.
 */
function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Uploaded GLB ceiling. A single OSM building is a few hundred KB at most. */
const MAX_GLB_BYTES = 32 * 1024 * 1024;

export function createApp(deps: AppDependencies) {
  const { config, repository, storage, overpass } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      // The API serves JSON and binary assets to a separate origin; CSP is the
      // web app's concern, and the default one here blocks asset fetches.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '2mb' }));

  /**
   * Footprint lookup. This is the endpoint that exists so browsers never talk
   * to Overpass directly — see `osm/overpassClient.ts` for why.
   *
   * Registered ahead of `authenticate` deliberately: it serves public OSM
   * data, never reads `req.userId`, and is on the "pick a building" path
   * that the app is designed to work on with no login at all. Gating it
   * behind a bearer token would break anonymous browsing entirely once
   * AUTH_REQUIRED is on, for a route that has nothing user-specific to
   * protect.
   */
  app.get(
    '/api/osm/footprint',
    route(async (req, res) => {
      const query = footprintQuerySchema.parse(req.query);
      const result = await overpass.getFootprint(
        { id: query.id, type: query.type },
        query.tileHeight ?? null,
      );

      // Footprints are immutable enough to cache hard at the edge too.
      res.set('cache-control', 'public, max-age=3600');
      res.json(result);
    }),
  );

  app.use(
    authenticate({
      required: config.authRequired,
      ...(deps.verifyToken ? { verifyToken: deps.verifyToken } : {}),
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      storage: storage.driver,
      database: config.databaseUrl ? 'postgres' : 'memory',
      authRequired: config.authRequired,
      overpassCache: overpass.stats(),
    });
  });

  app.get(
    '/api/extractions',
    route(async (req, res) => {
      res.json(await repository.listExtractions(req.userId ?? null));
    }),
  );

  app.post(
    '/api/extractions',
    route(async (req, res) => {
      const input = createExtractionSchema.parse(req.body);
      const userId = req.userId ?? null;

      // Re-extracting the same building is normal (the user tries different
      // edits); reuse the row rather than accumulating duplicates.
      const existing = await repository.findExtractionByOsm(userId, input.osm);
      if (existing) {
        res.status(200).json(existing);
        return;
      }

      const created = await repository.createExtraction(userId, input);
      res.status(201).json(created);
    }),
  );

  app.get(
    '/api/extractions/:id',
    route(async (req, res) => {
      const record = await repository.getExtraction(pathParam(req, 'id'));
      if (!record) {
        res.status(404).json({ error: 'Extraction not found' });
        return;
      }
      res.json(record);
    }),
  );

  app.get(
    '/api/models',
    route(async (req, res) => {
      res.json(await repository.listEditedModels(req.userId ?? null));
    }),
  );

  app.post(
    '/api/models',
    route(async (req, res) => {
      const input = createEditedModelSchema.parse(req.body);

      const extraction = await repository.getExtraction(input.extractionId);
      if (!extraction) {
        res.status(422).json({ error: 'Unknown extractionId' });
        return;
      }

      const created = await repository.createEditedModel(req.userId ?? null, input, null);
      res.status(201).json(created);
    }),
  );

  /**
   * Upload the exported GLB for a model.
   *
   * Kept separate from the JSON create call because the binary is large and
   * optional: the edit state alone is enough to reconstruct the mesh, so a
   * failed upload should not lose the user's work.
   */
  app.put(
    '/api/models/:id/mesh',
    express.raw({ type: ['model/gltf-binary', 'application/octet-stream'], limit: MAX_GLB_BYTES }),
    route(async (req, res) => {
      const model = await repository.getEditedModel(pathParam(req, 'id'));
      if (!model) {
        res.status(404).json({ error: 'Model not found' });
        return;
      }
      if (model.userId !== (req.userId ?? null)) {
        res.status(403).json({ error: 'Not your model' });
        return;
      }

      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        res.status(400).json({
          error: 'Expected a binary glTF body with content-type model/gltf-binary',
        });
        return;
      }

      // Cheap sanity check that this really is a GLB before it lands in the
      // bucket: the container starts with the magic "glTF".
      if (body.subarray(0, 4).toString('ascii') !== 'glTF') {
        res.status(400).json({ error: 'Body is not a binary glTF (missing glTF magic)' });
        return;
      }

      const stored = await storage.put(
        contentKey(`models/${model.id}`, body),
        body,
        'model/gltf-binary',
      );
      res.json({ ...stored, attribution: OSM_ATTRIBUTION });
    }),
  );

  app.delete(
    '/api/models/:id',
    route(async (req, res) => {
      const deleted = await repository.deleteEditedModel(req.userId ?? null, pathParam(req, 'id'));
      res.status(deleted ? 204 : 404).end();
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: error.issues });
      return;
    }
    if (error instanceof AuthError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof OverpassError) {
      res.status(error.status).json({ error: error.message });
      return;
    }

    // Anything unrecognised is a bug: log it server-side, tell the client
    // nothing that could leak internals.
    console.error('Unhandled error', error);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
