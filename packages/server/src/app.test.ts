/**
 * HTTP-level tests. The app is built with an in-memory repository, a temp
 * directory for storage, and a stubbed Overpass client, so these run with no
 * database, no bucket, and no network.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { CreateExtractionRequest } from '@gme/shared';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { MemoryRepository } from './db/repository.js';
import { OverpassClient } from './osm/overpassClient.js';
import { LocalStorage } from './storage/index.js';

const SQUARE: Array<[number, number]> = [
  [-122.4194, 37.7749],
  [-122.4192, 37.7749],
  [-122.4192, 37.7751],
  [-122.4194, 37.7751],
  [-122.4194, 37.7749],
];

const extractionBody: CreateExtractionRequest = {
  osm: { id: 24950831, type: 'way' },
  footprint: { type: 'Polygon', coordinates: [SQUARE] },
  heightMeters: 30,
  minHeightMeters: 0,
  origin: { lon: -122.4193, lat: 37.775, alt: 0 },
  tags: { building: 'yes' },
};

let storageDir: string;

function buildApp(
  overrides: { fetchImpl?: typeof fetch; env?: Record<string, string> } = {},
) {
  const config = loadConfig({
    CORS_ORIGINS: 'http://localhost:5173',
    ...overrides.env,
  } as NodeJS.ProcessEnv);
  const fetchImpl =
    overrides.fetchImpl ??
    ((async () =>
      new Response(
        JSON.stringify({
          elements: [
            {
              type: 'way',
              id: 24950831,
              tags: { building: 'yes', height: '30' },
              geometry: SQUARE.map(([lon, lat]) => ({ lon, lat })),
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch);

  return createApp({
    config,
    repository: new MemoryRepository(),
    storage: new LocalStorage(storageDir, '/assets'),
    overpass: new OverpassClient({
      ...config.overpass,
      fetchImpl,
      // Retry backoff is real time by default; nothing here needs to wait
      // out an actual 1s/2s between attempts.
      sleep: async () => {},
    }),
  });
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'gme-storage-'));
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('reports which drivers are active', async () => {
    const res = await request(buildApp()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, storage: 'local', database: 'memory' });
  });
});

describe('GET /api/osm/footprint', () => {
  it('returns a parsed footprint', async () => {
    const res = await request(buildApp())
      .get('/api/osm/footprint?id=24950831&type=way')
      .expect(200);

    expect(res.body.footprint.osm).toEqual({ id: 24950831, type: 'way' });
    expect(res.body.footprint.polygon.coordinates).toHaveLength(1);
    expect(res.body.attribution).toContain('OpenStreetMap');
  });

  it('rejects a non-numeric id', async () => {
    await request(buildApp()).get('/api/osm/footprint?id=abc').expect(400);
  });

  it('rejects an unsupported element type', async () => {
    await request(buildApp()).get('/api/osm/footprint?id=1&type=node').expect(400);
  });

  it('stays open with no token even when AUTH_REQUIRED is set — it serves public OSM data', async () => {
    const app = buildApp({ env: { AUTH_REQUIRED: 'true', JWT_SECRET: 'test-secret' } });

    await request(app).get('/api/osm/footprint?id=24950831&type=way').expect(200);
    // Contrast: a route that does read req.userId is still locked down.
    await request(app).get('/api/extractions').expect(401);
  });

  it('passes the tile height through as an override', async () => {
    const res = await request(buildApp())
      .get('/api/osm/footprint?id=24950831&type=way&tileHeight=55')
      .expect(200);
    expect(res.body.footprint.heightMeters).toBeCloseTo(55);
    expect(res.body.heightSource).toBe('tile-feature');
  });

  it('propagates an upstream rate limit as 429', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('slow down', { status: 429 }),
    ) as unknown as typeof fetch;

    await request(buildApp({ fetchImpl }))
      .get('/api/osm/footprint?id=24950831&type=way')
      .expect(429);
  });

  it('reports a deleted OSM element as 404', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ elements: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await request(buildApp({ fetchImpl }))
      .get('/api/osm/footprint?id=24950831&type=way')
      .expect(404);
  });
});

describe('extractions', () => {
  it('creates and reads back an extraction', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/extractions').send(extractionBody).expect(201);

    expect(created.body.id).toBeTruthy();
    expect(created.body.osm).toEqual(extractionBody.osm);

    const fetched = await request(app).get(`/api/extractions/${created.body.id}`).expect(200);
    expect(fetched.body.id).toBe(created.body.id);
  });

  it('reuses the existing row when the same building is extracted twice', async () => {
    const app = buildApp();
    const first = await request(app).post('/api/extractions').send(extractionBody).expect(201);
    const second = await request(app).post('/api/extractions').send(extractionBody).expect(200);

    expect(second.body.id).toBe(first.body.id);
    const list = await request(app).get('/api/extractions').expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('rejects a polygon ring with too few points', async () => {
    await request(buildApp())
      .post('/api/extractions')
      .send({
        ...extractionBody,
        footprint: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] },
      })
      .expect(400);
  });

  it('rejects out-of-range coordinates', async () => {
    await request(buildApp())
      .post('/api/extractions')
      .send({ ...extractionBody, origin: { lon: 999, lat: 0, alt: 0 } })
      .expect(400);
  });

  it('rejects an absurd building height', async () => {
    await request(buildApp())
      .post('/api/extractions')
      .send({ ...extractionBody, heightMeters: 99999 })
      .expect(400);
  });

  it('404s an unknown extraction', async () => {
    await request(buildApp())
      .get('/api/extractions/6a5f4d3c-2b1a-4e5f-8c7d-9e0f1a2b3c4d')
      .expect(404);
  });
});

describe('models', () => {
  const editState = {
    transform: { scale: [1, 1, 1], quaternion: [0, 0, 0, 1] },
    operations: [{ type: 'cut', normal: [0, 1, 0], constant: -5 }],
  };
  const placement = {
    position: { lon: 2.2945, lat: 48.8584, alt: 0 },
    headingDeg: 45,
    clampToTerrain: true,
  };

  async function createModel(app: ReturnType<typeof buildApp>) {
    const extraction = await request(app).post('/api/extractions').send(extractionBody);
    return request(app)
      .post('/api/models')
      .send({ extractionId: extraction.body.id, name: 'Ferry Building', editState, placement });
  }

  it('creates a model against an existing extraction', async () => {
    const app = buildApp();
    const res = await createModel(app);

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Ferry Building');
    expect(res.body.editState.operations).toHaveLength(1);
    expect(res.body.placement.headingDeg).toBe(45);
  });

  it('refuses a model referencing an unknown extraction', async () => {
    await request(buildApp())
      .post('/api/models')
      .send({
        extractionId: '6a5f4d3c-2b1a-4e5f-8c7d-9e0f1a2b3c4d',
        name: 'orphan',
        editState,
        placement,
      })
      .expect(422);
  });

  it('rejects an operation list beyond the replay budget', async () => {
    const app = buildApp();
    const extraction = await request(app).post('/api/extractions').send(extractionBody);
    await request(app)
      .post('/api/models')
      .send({
        extractionId: extraction.body.id,
        name: 'too many cuts',
        editState: {
          transform: editState.transform,
          operations: Array.from({ length: 300 }, () => ({
            type: 'cut',
            normal: [0, 1, 0],
            constant: 0,
          })),
        },
        placement,
      })
      .expect(400);
  });

  it('lists and deletes models', async () => {
    const app = buildApp();
    const created = await createModel(app);

    await request(app).get('/api/models').expect(200).expect((r) => {
      expect(r.body).toHaveLength(1);
    });

    await request(app).delete(`/api/models/${created.body.id}`).expect(204);
    await request(app).get('/api/models').expect(200).expect((r) => {
      expect(r.body).toHaveLength(0);
    });
  });

  describe('mesh upload', () => {
    /** Minimal well-formed GLB header: magic, version, length. */
    function glbBytes(): Buffer {
      const buffer = Buffer.alloc(20);
      buffer.write('glTF', 0, 'ascii');
      buffer.writeUInt32LE(2, 4);
      buffer.writeUInt32LE(20, 8);
      return buffer;
    }

    it('stores a GLB and returns its URL', async () => {
      const app = buildApp();
      const created = await createModel(app);

      const res = await request(app)
        .put(`/api/models/${created.body.id}/mesh`)
        .set('content-type', 'model/gltf-binary')
        .send(glbBytes())
        .expect(200);

      expect(res.body.key).toMatch(/^models\//);
      expect(res.body.url).toContain('/assets/');
      expect(res.body.bytes).toBe(20);
      expect(res.body.attribution).toContain('OpenStreetMap');
    });

    it('rejects a body that is not a GLB', async () => {
      const app = buildApp();
      const created = await createModel(app);

      await request(app)
        .put(`/api/models/${created.body.id}/mesh`)
        .set('content-type', 'model/gltf-binary')
        .send(Buffer.from('this is not a glb'))
        .expect(400);
    });

    it('rejects an empty body', async () => {
      const app = buildApp();
      const created = await createModel(app);

      await request(app)
        .put(`/api/models/${created.body.id}/mesh`)
        .set('content-type', 'model/gltf-binary')
        .send(Buffer.alloc(0))
        .expect(400);
    });

    it('404s for an unknown model', async () => {
      await request(buildApp())
        .put('/api/models/6a5f4d3c-2b1a-4e5f-8c7d-9e0f1a2b3c4d/mesh')
        .set('content-type', 'model/gltf-binary')
        .send(glbBytes())
        .expect(404);
    });
  });
});

describe('unknown routes', () => {
  it('returns a JSON 404', async () => {
    const res = await request(buildApp()).get('/api/nope').expect(404);
    expect(res.body.error).toBe('Not found');
  });
});
