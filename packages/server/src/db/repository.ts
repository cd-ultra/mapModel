/**
 * Persistence for extractions and edited models.
 *
 * The interface has two implementations: PostGIS for real deployments, and an
 * in-memory one so the API runs (and its tests run) with no database. Both are
 * exercised by the same test suite in `repository.test.ts`, which is the only
 * way an in-memory stand-in stays honest.
 */

import { randomUUID } from 'node:crypto';
import type {
  CreateEditedModelRequest,
  CreateExtractionRequest,
  EditedModel,
  Extraction,
  OsmRef,
} from '@gme/shared';

export interface Repository {
  createExtraction(
    userId: string | null,
    input: CreateExtractionRequest,
    rawMeshUrl?: string | null,
  ): Promise<Extraction>;
  getExtraction(id: string): Promise<Extraction | null>;
  findExtractionByOsm(userId: string | null, ref: OsmRef): Promise<Extraction | null>;
  listExtractions(userId: string | null, limit?: number): Promise<Extraction[]>;

  createEditedModel(
    userId: string | null,
    input: CreateEditedModelRequest,
    editedMeshUrl: string | null,
  ): Promise<EditedModel>;
  getEditedModel(id: string): Promise<EditedModel | null>;
  listEditedModels(userId: string | null, limit?: number): Promise<EditedModel[]>;
  deleteEditedModel(userId: string | null, id: string): Promise<boolean>;
}

// --- In-memory ------------------------------------------------------------

export class MemoryRepository implements Repository {
  private readonly extractions = new Map<string, Extraction>();
  private readonly models = new Map<string, EditedModel>();

  async createExtraction(
    userId: string | null,
    input: CreateExtractionRequest,
    rawMeshUrl: string | null = null,
  ): Promise<Extraction> {
    const record: Extraction = {
      id: randomUUID(),
      userId,
      osm: input.osm,
      footprint: input.footprint,
      heightMeters: input.heightMeters,
      minHeightMeters: input.minHeightMeters,
      origin: input.origin,
      tags: input.tags,
      rawMeshUrl,
      createdAt: new Date().toISOString(),
    };
    this.extractions.set(record.id, record);
    return record;
  }

  async getExtraction(id: string): Promise<Extraction | null> {
    return this.extractions.get(id) ?? null;
  }

  async findExtractionByOsm(userId: string | null, ref: OsmRef): Promise<Extraction | null> {
    for (const record of this.extractions.values()) {
      if (record.osm.id === ref.id && record.osm.type === ref.type && record.userId === userId) {
        return record;
      }
    }
    return null;
  }

  async listExtractions(userId: string | null, limit = 50): Promise<Extraction[]> {
    return [...this.extractions.values()]
      .filter((e) => e.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async createEditedModel(
    userId: string | null,
    input: CreateEditedModelRequest,
    editedMeshUrl: string | null,
  ): Promise<EditedModel> {
    const now = new Date().toISOString();
    const record: EditedModel = {
      id: randomUUID(),
      extractionId: input.extractionId,
      userId,
      editedMeshUrl,
      editState: input.editState,
      placement: input.placement,
      name: input.name,
      createdAt: now,
      updatedAt: now,
    };
    this.models.set(record.id, record);
    return record;
  }

  async getEditedModel(id: string): Promise<EditedModel | null> {
    return this.models.get(id) ?? null;
  }

  async listEditedModels(userId: string | null, limit = 50): Promise<EditedModel[]> {
    return [...this.models.values()]
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async deleteEditedModel(userId: string | null, id: string): Promise<boolean> {
    const record = this.models.get(id);
    if (!record || record.userId !== userId) return false;
    return this.models.delete(id);
  }
}

// --- PostGIS --------------------------------------------------------------

/**
 * The subset of `pg.Pool` used here, so tests can supply a fake.
 *
 * The row constraint is `object` rather than `Record<string, unknown>` because
 * pg's own `QueryResultRow` is indexed with `any`, and named row interfaces
 * (which have no index signature) must satisfy it.
 */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

interface ExtractionRow {
  id: string;
  user_id: string | null;
  osm_element_id: string;
  osm_element_type: 'way' | 'relation';
  footprint_json: string;
  source_height_m: string | number;
  source_min_height_m: string | number;
  origin_json: string;
  osm_tags: Record<string, string>;
  raw_mesh_url: string | null;
  created_at: Date;
}

interface ModelRow {
  id: string;
  extraction_id: string;
  user_id: string | null;
  name: string;
  edited_mesh_url: string | null;
  edit_state: EditedModel['editState'];
  placement_json: string;
  placement_heading_deg: string | number;
  clamp_to_terrain: boolean;
  created_at: Date;
  updated_at: Date;
}

const num = (value: string | number): number =>
  typeof value === 'number' ? value : Number(value);

/**
 * Geometry is read back as GeoJSON rather than WKB so the row maps to the DTO
 * without a parsing dependency, and written with ST_GeomFromGeoJSON so the
 * client's polygon is validated by PostGIS instead of string-concatenated.
 */
const EXTRACTION_COLUMNS = `
  id,
  user_id,
  osm_element_id,
  osm_element_type,
  ST_AsGeoJSON(source_footprint) AS footprint_json,
  source_height_m,
  source_min_height_m,
  ST_AsGeoJSON(source_origin) AS origin_json,
  osm_tags,
  raw_mesh_url,
  created_at
`;

const MODEL_COLUMNS = `
  id,
  extraction_id,
  user_id,
  name,
  edited_mesh_url,
  edit_state,
  ST_AsGeoJSON(placement) AS placement_json,
  placement_heading_deg,
  clamp_to_terrain,
  created_at,
  updated_at
`;

export class PostgresRepository implements Repository {
  constructor(private readonly db: Queryable) {}

  private static toExtraction(row: ExtractionRow): Extraction {
    const origin = JSON.parse(row.origin_json) as { coordinates: [number, number, number] };
    return {
      id: row.id,
      userId: row.user_id,
      osm: { id: Number(row.osm_element_id), type: row.osm_element_type },
      footprint: JSON.parse(row.footprint_json) as Extraction['footprint'],
      heightMeters: num(row.source_height_m),
      minHeightMeters: num(row.source_min_height_m),
      origin: {
        lon: origin.coordinates[0],
        lat: origin.coordinates[1],
        alt: origin.coordinates[2] ?? 0,
      },
      tags: row.osm_tags ?? {},
      rawMeshUrl: row.raw_mesh_url,
      createdAt: row.created_at.toISOString(),
    };
  }

  private static toModel(row: ModelRow): EditedModel {
    const point = JSON.parse(row.placement_json) as { coordinates: [number, number, number] };
    return {
      id: row.id,
      extractionId: row.extraction_id,
      userId: row.user_id,
      editedMeshUrl: row.edited_mesh_url,
      editState: row.edit_state,
      placement: {
        position: {
          lon: point.coordinates[0],
          lat: point.coordinates[1],
          alt: point.coordinates[2] ?? 0,
        },
        headingDeg: num(row.placement_heading_deg),
        clampToTerrain: row.clamp_to_terrain,
      },
      name: row.name,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async createExtraction(
    userId: string | null,
    input: CreateExtractionRequest,
    rawMeshUrl: string | null = null,
  ): Promise<Extraction> {
    const { rows } = await this.db.query<ExtractionRow>(
      `INSERT INTO osm_extractions (
         user_id, osm_element_id, osm_element_type, source_footprint,
         source_height_m, source_min_height_m, source_origin, osm_tags, raw_mesh_url
       ) VALUES (
         $1, $2, $3,
         ST_SetSRID(ST_GeomFromGeoJSON($4), 4326),
         $5, $6,
         ST_SetSRID(ST_MakePoint($7, $8, $9), 4326),
         $10, $11
       )
       RETURNING ${EXTRACTION_COLUMNS}`,
      [
        userId,
        input.osm.id,
        input.osm.type,
        JSON.stringify(input.footprint),
        input.heightMeters,
        input.minHeightMeters,
        input.origin.lon,
        input.origin.lat,
        input.origin.alt,
        JSON.stringify(input.tags),
        rawMeshUrl,
      ],
    );
    return PostgresRepository.toExtraction(rows[0]!);
  }

  async getExtraction(id: string): Promise<Extraction | null> {
    const { rows } = await this.db.query<ExtractionRow>(
      `SELECT ${EXTRACTION_COLUMNS} FROM osm_extractions WHERE id = $1`,
      [id],
    );
    return rows[0] ? PostgresRepository.toExtraction(rows[0]) : null;
  }

  async findExtractionByOsm(userId: string | null, ref: OsmRef): Promise<Extraction | null> {
    const { rows } = await this.db.query<ExtractionRow>(
      `SELECT ${EXTRACTION_COLUMNS} FROM osm_extractions
       WHERE osm_element_id = $1 AND osm_element_type = $2
         AND user_id IS NOT DISTINCT FROM $3
       ORDER BY created_at DESC LIMIT 1`,
      [ref.id, ref.type, userId],
    );
    return rows[0] ? PostgresRepository.toExtraction(rows[0]) : null;
  }

  async listExtractions(userId: string | null, limit = 50): Promise<Extraction[]> {
    const { rows } = await this.db.query<ExtractionRow>(
      `SELECT ${EXTRACTION_COLUMNS} FROM osm_extractions
       WHERE user_id IS NOT DISTINCT FROM $1
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(PostgresRepository.toExtraction);
  }

  async createEditedModel(
    userId: string | null,
    input: CreateEditedModelRequest,
    editedMeshUrl: string | null,
  ): Promise<EditedModel> {
    const { rows } = await this.db.query<ModelRow>(
      `INSERT INTO edited_models (
         extraction_id, user_id, name, edited_mesh_url, edit_state,
         placement, placement_heading_deg, clamp_to_terrain
       ) VALUES (
         $1, $2, $3, $4, $5,
         ST_SetSRID(ST_MakePoint($6, $7, $8), 4326),
         $9, $10
       )
       RETURNING ${MODEL_COLUMNS}`,
      [
        input.extractionId,
        userId,
        input.name,
        editedMeshUrl,
        JSON.stringify(input.editState),
        input.placement.position.lon,
        input.placement.position.lat,
        input.placement.position.alt,
        input.placement.headingDeg,
        input.placement.clampToTerrain,
      ],
    );
    return PostgresRepository.toModel(rows[0]!);
  }

  async getEditedModel(id: string): Promise<EditedModel | null> {
    const { rows } = await this.db.query<ModelRow>(
      `SELECT ${MODEL_COLUMNS} FROM edited_models WHERE id = $1`,
      [id],
    );
    return rows[0] ? PostgresRepository.toModel(rows[0]) : null;
  }

  async listEditedModels(userId: string | null, limit = 50): Promise<EditedModel[]> {
    const { rows } = await this.db.query<ModelRow>(
      `SELECT ${MODEL_COLUMNS} FROM edited_models
       WHERE user_id IS NOT DISTINCT FROM $1
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(PostgresRepository.toModel);
  }

  async deleteEditedModel(userId: string | null, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM edited_models
       WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2`,
      [id, userId],
    );
    return (rowCount ?? 0) > 0;
  }
}
