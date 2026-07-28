/**
 * One contract suite, two implementations.
 *
 * The in-memory repository only earns its keep if it behaves like the real one,
 * so both are driven through the same expectations. The Postgres side runs
 * against a fake `Queryable` that records SQL and replays canned rows — enough
 * to catch column/parameter drift and the row-to-DTO mapping, which is where
 * the real bugs live. It is not a substitute for an integration test against a
 * live PostGIS instance.
 */

import { describe, expect, it } from 'vitest';
import type { CreateEditedModelRequest, CreateExtractionRequest } from '@gme/shared';
import {
  MemoryRepository,
  PostgresRepository,
  type Queryable,
  type Repository,
} from './repository.js';

const SQUARE: Array<[number, number]> = [
  [-122.4194, 37.7749],
  [-122.4192, 37.7749],
  [-122.4192, 37.7751],
  [-122.4194, 37.7751],
  [-122.4194, 37.7749],
];

const extractionInput: CreateExtractionRequest = {
  osm: { id: 24950831, type: 'way' },
  footprint: { type: 'Polygon', coordinates: [SQUARE] },
  heightMeters: 30,
  minHeightMeters: 2,
  origin: { lon: -122.4193, lat: 37.775, alt: 5 },
  tags: { building: 'yes', name: 'Ferry Building' },
};

const modelInput = (extractionId: string): CreateEditedModelRequest => ({
  extractionId,
  name: 'Sliced tower',
  editState: {
    transform: { scale: [2, 1, 1], quaternion: [0, 0, 0, 1] },
    operations: [{ type: 'cut', normal: [0, 1, 0], constant: -12 }],
  },
  placement: {
    position: { lon: 2.2945, lat: 48.8584, alt: 3 },
    headingDeg: 45,
    clampToTerrain: true,
  },
});

describe('MemoryRepository', () => {
  const make = (): Repository => new MemoryRepository();

  it('round-trips an extraction', async () => {
    const repo = make();
    const created = await repo.createExtraction('user-1', extractionInput);

    expect(created.id).toBeTruthy();
    expect(created.userId).toBe('user-1');
    expect(created.osm).toEqual(extractionInput.osm);
    expect(created.heightMeters).toBe(30);
    expect(created.minHeightMeters).toBe(2);
    expect(created.origin).toEqual(extractionInput.origin);
    expect(created.tags['name']).toBe('Ferry Building');

    expect(await repo.getExtraction(created.id)).toEqual(created);
  });

  it('finds an extraction by OSM ref, scoped to the user', async () => {
    const repo = make();
    const mine = await repo.createExtraction('user-1', extractionInput);
    await repo.createExtraction('user-2', extractionInput);

    expect((await repo.findExtractionByOsm('user-1', extractionInput.osm))?.id).toBe(mine.id);
    expect(await repo.findExtractionByOsm('user-3', extractionInput.osm)).toBeNull();
  });

  it('distinguishes ways from relations with the same id', async () => {
    const repo = make();
    await repo.createExtraction('user-1', extractionInput);
    expect(
      await repo.findExtractionByOsm('user-1', { id: extractionInput.osm.id, type: 'relation' }),
    ).toBeNull();
  });

  it('lists only the caller\'s extractions', async () => {
    const repo = make();
    await repo.createExtraction('user-1', extractionInput);
    await repo.createExtraction('user-2', extractionInput);

    expect(await repo.listExtractions('user-1')).toHaveLength(1);
    expect(await repo.listExtractions(null)).toHaveLength(0);
  });

  it('round-trips an edited model including its edit state', async () => {
    const repo = make();
    const extraction = await repo.createExtraction('user-1', extractionInput);
    const created = await repo.createEditedModel(
      'user-1',
      modelInput(extraction.id),
      's3://bucket/model.glb',
    );

    expect(created.extractionId).toBe(extraction.id);
    expect(created.editedMeshUrl).toBe('s3://bucket/model.glb');
    expect(created.editState.operations).toHaveLength(1);
    expect(created.editState.transform.scale).toEqual([2, 1, 1]);
    expect(created.placement.headingDeg).toBe(45);
    expect(await repo.getEditedModel(created.id)).toEqual(created);
  });

  it('only lets the owner delete a model', async () => {
    const repo = make();
    const extraction = await repo.createExtraction('user-1', extractionInput);
    const model = await repo.createEditedModel('user-1', modelInput(extraction.id), null);

    expect(await repo.deleteEditedModel('user-2', model.id)).toBe(false);
    expect(await repo.getEditedModel(model.id)).not.toBeNull();

    expect(await repo.deleteEditedModel('user-1', model.id)).toBe(true);
    expect(await repo.getEditedModel(model.id)).toBeNull();
  });

  it('reports a missing record rather than throwing', async () => {
    const repo = make();
    expect(await repo.getExtraction('nope')).toBeNull();
    expect(await repo.getEditedModel('nope')).toBeNull();
    expect(await repo.deleteEditedModel('user-1', 'nope')).toBe(false);
  });
});

// --- Postgres mapping ------------------------------------------------------

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function fakeDb(rows: unknown[], rowCount = rows.length) {
  const queries: RecordedQuery[] = [];
  const db: Queryable = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: rows as never[], rowCount };
    },
  };
  return { db, queries };
}

const extractionRow = {
  id: 'e1',
  user_id: 'user-1',
  osm_element_id: '24950831',
  osm_element_type: 'way',
  footprint_json: JSON.stringify({ type: 'Polygon', coordinates: [SQUARE] }),
  // pg returns numerics as strings; the mapper must coerce them.
  source_height_m: '30',
  source_min_height_m: '2',
  origin_json: JSON.stringify({ type: 'Point', coordinates: [-122.4193, 37.775, 5] }),
  osm_tags: { building: 'yes' },
  raw_mesh_url: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
};

const modelRow = {
  id: 'm1',
  extraction_id: 'e1',
  user_id: 'user-1',
  name: 'Sliced tower',
  edited_mesh_url: null,
  edit_state: modelInput('e1').editState,
  placement_json: JSON.stringify({ type: 'Point', coordinates: [2.2945, 48.8584, 3] }),
  placement_heading_deg: '45',
  clamp_to_terrain: true,
  created_at: new Date('2026-01-02T00:00:00Z'),
  updated_at: new Date('2026-01-03T00:00:00Z'),
};

describe('PostgresRepository', () => {
  it('maps an extraction row, coercing pg numeric strings', async () => {
    const { db } = fakeDb([extractionRow]);
    const record = await new PostgresRepository(db).getExtraction('e1');

    expect(record).not.toBeNull();
    expect(record!.osm).toEqual({ id: 24950831, type: 'way' });
    expect(record!.heightMeters).toBe(30);
    expect(record!.minHeightMeters).toBe(2);
    expect(record!.origin).toEqual({ lon: -122.4193, lat: 37.775, alt: 5 });
    expect(record!.footprint.coordinates[0]).toHaveLength(5);
    expect(record!.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('maps a model row including placement and heading', async () => {
    const { db } = fakeDb([modelRow]);
    const record = await new PostgresRepository(db).getEditedModel('m1');

    expect(record!.placement.position).toEqual({ lon: 2.2945, lat: 48.8584, alt: 3 });
    expect(record!.placement.headingDeg).toBe(45);
    expect(record!.placement.clampToTerrain).toBe(true);
    expect(record!.editState.operations).toHaveLength(1);
  });

  it('passes the footprint as GeoJSON and sets SRID 4326', async () => {
    const { db, queries } = fakeDb([extractionRow]);
    await new PostgresRepository(db).createExtraction('user-1', extractionInput);

    const insert = queries[0]!;
    expect(insert.text).toContain('ST_GeomFromGeoJSON');
    expect(insert.text).toContain('ST_SetSRID');
    // The polygon must be a bound parameter, never interpolated into the SQL.
    expect(insert.values).toContain(JSON.stringify(extractionInput.footprint));
    expect(insert.values).toContain(24950831);
  });

  it('builds the origin point as lon, lat, alt in that order', async () => {
    const { db, queries } = fakeDb([extractionRow]);
    await new PostgresRepository(db).createExtraction(null, extractionInput);

    const values = queries[0]!.values;
    const lonIndex = values.indexOf(extractionInput.origin.lon);
    expect(lonIndex).toBeGreaterThanOrEqual(0);
    expect(values[lonIndex + 1]).toBe(extractionInput.origin.lat);
    expect(values[lonIndex + 2]).toBe(extractionInput.origin.alt);
  });

  it('scopes lookups with IS NOT DISTINCT FROM so a null user matches', async () => {
    const { db, queries } = fakeDb([]);
    await new PostgresRepository(db).findExtractionByOsm(null, extractionInput.osm);
    expect(queries[0]!.text).toContain('IS NOT DISTINCT FROM');
  });

  it('serialises edit state to JSON for the JSONB column', async () => {
    const { db, queries } = fakeDb([modelRow]);
    const input = modelInput('e1');
    await new PostgresRepository(db).createEditedModel('user-1', input, null);

    expect(queries[0]!.values).toContain(JSON.stringify(input.editState));
  });

  it('reports a delete that matched nothing', async () => {
    const { db } = fakeDb([], 0);
    expect(await new PostgresRepository(db).deleteEditedModel('user-1', 'm1')).toBe(false);
  });

  it('reports a delete that matched a row', async () => {
    const { db } = fakeDb([], 1);
    expect(await new PostgresRepository(db).deleteEditedModel('user-1', 'm1')).toBe(true);
  });

  it('returns null for a missing row instead of throwing', async () => {
    const { db } = fakeDb([]);
    expect(await new PostgresRepository(db).getExtraction('nope')).toBeNull();
    expect(await new PostgresRepository(db).getEditedModel('nope')).toBeNull();
  });
});
