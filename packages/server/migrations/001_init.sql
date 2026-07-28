-- Geo Model Editor schema.
--
-- PostGIS is used for the geometry columns so footprints and placements can be
-- queried spatially (e.g. "what has been placed in this viewport") rather than
-- filtered in application code.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT UNIQUE NOT NULL,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS osm_extractions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  osm_element_id    BIGINT NOT NULL,
  osm_element_type  TEXT   NOT NULL CHECK (osm_element_type IN ('way', 'relation')),
  source_footprint  GEOMETRY(Polygon, 4326) NOT NULL,
  source_height_m   DOUBLE PRECISION NOT NULL,
  source_min_height_m DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Original placement, kept for provenance and ODbL attribution.
  source_origin     GEOMETRY(PointZ, 4326) NOT NULL,
  osm_tags          JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_mesh_url      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same building is extracted repeatedly; this makes the lookup cheap and
-- lets the API dedupe extractions per user.
CREATE INDEX IF NOT EXISTS osm_extractions_element_idx
  ON osm_extractions (osm_element_type, osm_element_id);
CREATE INDEX IF NOT EXISTS osm_extractions_user_idx
  ON osm_extractions (user_id);
CREATE INDEX IF NOT EXISTS osm_extractions_footprint_gix
  ON osm_extractions USING GIST (source_footprint);

CREATE TABLE IF NOT EXISTS edited_models (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id         UUID NOT NULL REFERENCES osm_extractions(id) ON DELETE CASCADE,
  user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  name                  TEXT NOT NULL DEFAULT 'Untitled',
  edited_mesh_url       TEXT,
  -- Scale, rotation quaternion, and the ordered list of cut operations. Stored
  -- rather than only the baked mesh so an edit can be replayed or revised.
  edit_state            JSONB NOT NULL,
  placement             GEOMETRY(PointZ, 4326) NOT NULL,
  placement_heading_deg DOUBLE PRECISION NOT NULL DEFAULT 0,
  clamp_to_terrain      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS edited_models_user_idx ON edited_models (user_id);
CREATE INDEX IF NOT EXISTS edited_models_extraction_idx ON edited_models (extraction_id);
CREATE INDEX IF NOT EXISTS edited_models_placement_gix
  ON edited_models USING GIST (placement);

-- Keep updated_at honest without relying on every caller to set it.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS edited_models_touch ON edited_models;
CREATE TRIGGER edited_models_touch
  BEFORE UPDATE ON edited_models
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
