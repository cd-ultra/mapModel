/**
 * Request validation.
 *
 * Everything crossing the API boundary is parsed rather than trusted — the
 * geometry in particular, because a malformed ring reaches PostGIS as a
 * `ST_GeomFromGeoJSON` argument and an unbounded tag map reaches a JSONB
 * column.
 */

import { z } from 'zod';

export const osmRefSchema = z.object({
  id: z.number().int().positive(),
  type: z.enum(['way', 'relation']),
});

const lonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

/** A closed linear ring: at least 3 distinct points plus the repeated first. */
const linearRing = z.array(lonLat).min(4).max(10_000);

export const footprintSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(linearRing).min(1).max(64),
});

export const lonLatAltSchema = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  // Below the Dead Sea and above the Karman line are both nonsense here.
  alt: z.number().min(-500).max(100_000),
});

export const tagsSchema = z.record(z.string().max(255), z.string().max(2048)).default({});

export const createExtractionSchema = z.object({
  osm: osmRefSchema,
  footprint: footprintSchema,
  heightMeters: z.number().positive().max(2000),
  minHeightMeters: z.number().min(0).max(2000).default(0),
  origin: lonLatAltSchema,
  tags: tagsSchema,
});

export const cutOperationSchema = z.object({
  type: z.literal('cut'),
  normal: z.tuple([z.number(), z.number(), z.number()]),
  constant: z.number(),
});

export const editStateSchema = z.object({
  transform: z.object({
    scale: z.tuple([z.number(), z.number(), z.number()]),
    quaternion: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  }),
  // A bound on operations keeps replay time bounded for whoever loads it next.
  operations: z.array(cutOperationSchema).max(256).default([]),
});

export const placementSchema = z.object({
  position: lonLatAltSchema,
  headingDeg: z.number().min(-360).max(360).default(0),
  clampToTerrain: z.boolean().default(true),
});

export const createEditedModelSchema = z.object({
  extractionId: z.string().uuid(),
  name: z.string().min(1).max(200).default('Untitled'),
  editState: editStateSchema,
  placement: placementSchema,
});

export const footprintQuerySchema = z.object({
  id: z.coerce.number().int().positive(),
  type: z.enum(['way', 'relation']).default('way'),
  tileHeight: z.coerce.number().positive().max(2000).optional(),
});
