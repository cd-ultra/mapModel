/**
 * Reading OSM identity off a Cesium 3D Tiles building feature.
 *
 * The plan calls this the riskiest unknown in the project, and it is: the
 * property names on Cesium OSM Buildings are a product of how ion built the
 * tileset, they have changed across tileset generations, and they vary by
 * region. So rather than hard-coding one name, this module:
 *
 *   1. tries every spelling we have seen in the wild, in preference order;
 *   2. reports which one matched;
 *   3. on failure, hands back the full property list so the UI can show the
 *      user exactly what the tileset does expose.
 *
 * It takes a minimal structural interface rather than `Cesium3DTileFeature` so
 * it can be unit-tested with no Cesium, no WebGL, and no network.
 */

import type { OsmRef } from '@gme/shared';

/** The slice of `Cesium3DTileFeature` we depend on. */
export interface TileFeatureLike {
  /** Cesium >= 1.98. */
  getPropertyIds?: () => string[];
  /** Older Cesium builds; kept because ion tilesets outlive viewer upgrades. */
  getPropertyNames?: () => string[];
  getProperty: (name: string) => unknown;
}

/** Property names that have carried the OSM element id, best first. */
const ID_KEYS = ['elementId', 'element_id', 'osm_id', 'osmId', 'id', 'OSM_ID'];

/** Property names that have carried the element kind. */
const TYPE_KEYS = ['elementType', 'element_type', 'osm_type', 'osmType', 'type'];

/** Property names that have carried the extrusion height Cesium rendered. */
const HEIGHT_KEYS = [
  'cesium#estimatedHeight',
  'estimatedHeight',
  'height',
  'building:height',
];

export function listPropertyNames(feature: TileFeatureLike): string[] {
  if (typeof feature.getPropertyIds === 'function') return feature.getPropertyIds();
  if (typeof feature.getPropertyNames === 'function') return feature.getPropertyNames();
  return [];
}

function firstDefined(
  feature: TileFeatureLike,
  keys: readonly string[],
): { key: string; value: unknown } | null {
  for (const key of keys) {
    const value = feature.getProperty(key);
    if (value !== undefined && value !== null && value !== '') return { key, value };
  }
  return null;
}

/**
 * Coerce an id that may arrive as a number, a numeric string, or a prefixed
 * string like "way/24950831" — all forms seen on ion tilesets.
 */
export function parseElementId(raw: unknown): { id: number; type?: OsmRef['type'] } | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? { id: raw } : null;
  }
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  const prefixed = /^(way|relation|node|w|r|n)[/:_-]?(\d+)$/i.exec(trimmed);
  if (prefixed) {
    const id = Number(prefixed[2]);
    const letter = prefixed[1]!.toLowerCase();
    const type = letter.startsWith('r') ? 'relation' : letter.startsWith('w') ? 'way' : undefined;
    return Number.isInteger(id) && id > 0 ? (type ? { id, type } : { id }) : null;
  }

  const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  return Number.isInteger(numeric) && numeric > 0 ? { id: numeric } : null;
}

export function parseElementType(raw: unknown): OsmRef['type'] | null {
  if (typeof raw === 'number') {
    // Some builds encode the enum positionally: 0 = way, 1 = relation.
    if (raw === 0) return 'way';
    if (raw === 1) return 'relation';
    return null;
  }
  if (typeof raw !== 'string') return null;

  const value = raw.trim().toLowerCase();
  if (value === 'way' || value === 'w') return 'way';
  if (value === 'relation' || value === 'rel' || value === 'r') return 'relation';
  return null;
}

export interface TileFeatureReading {
  /** Null when the tileset does not expose a usable OSM id. */
  ref: OsmRef | null;
  /** Height Cesium extruded this building to, if exposed. */
  tileHeight: number | null;
  /** Every property on the feature, for the metadata panel and diagnostics. */
  properties: Record<string, unknown>;
  /** Which property names actually supplied the values, for diagnostics. */
  matchedKeys: { id?: string; type?: string; height?: string };
  /** Human-readable explanation when `ref` is null. */
  problem: string | null;
}

/**
 * Extract everything useful from a picked building feature.
 *
 * Never throws: a tileset we cannot read is a UI message, not a crash, and the
 * returned `properties` is what makes that message actionable.
 */
export function readTileFeature(feature: TileFeatureLike): TileFeatureReading {
  const names = listPropertyNames(feature);
  const properties: Record<string, unknown> = {};
  for (const name of names) {
    properties[name] = feature.getProperty(name);
  }

  const matchedKeys: TileFeatureReading['matchedKeys'] = {};

  const heightHit = firstDefined(feature, HEIGHT_KEYS);
  let tileHeight: number | null = null;
  if (heightHit) {
    const numeric = Number(heightHit.value);
    if (Number.isFinite(numeric) && numeric > 0) {
      tileHeight = numeric;
      matchedKeys.height = heightHit.key;
    }
  }

  const idHit = firstDefined(feature, ID_KEYS);
  if (!idHit) {
    return {
      ref: null,
      tileHeight,
      properties,
      matchedKeys,
      problem:
        names.length === 0
          ? 'This tile feature exposes no properties at all, so it carries no OSM id. It is probably not an OSM Buildings tileset.'
          : `No OSM element id found. The tileset exposes: ${names.join(', ')}.`,
    };
  }
  matchedKeys.id = idHit.key;

  const parsedId = parseElementId(idHit.value);
  if (!parsedId) {
    return {
      ref: null,
      tileHeight,
      properties,
      matchedKeys,
      problem: `Property "${idHit.key}" held ${JSON.stringify(idHit.value)}, which is not a usable OSM id.`,
    };
  }

  const typeHit = firstDefined(feature, TYPE_KEYS);
  let type = typeHit ? parseElementType(typeHit.value) : null;
  if (type) {
    matchedKeys.type = typeHit!.key;
  } else if (parsedId.type) {
    // The id itself was prefixed, e.g. "way/24950831".
    type = parsedId.type;
    matchedKeys.type = idHit.key;
  }

  if (!type) {
    // Overwhelmingly the common case: OSM buildings are closed ways, and
    // multipolygon relations are the minority. Guessing "way" and letting the
    // Overpass lookup fail loudly beats refusing to try.
    type = 'way';
  }

  return {
    ref: { id: parsedId.id, type },
    tileHeight,
    properties,
    matchedKeys,
    problem: null,
  };
}

/** Tags worth showing in the metadata panel, filtered from tileset internals. */
export function osmTagsFromProperties(
  properties: Record<string, unknown>,
): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    // Cesium's own bookkeeping is namespaced with "cesium#".
    if (key.startsWith('cesium#')) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    tags[key] = String(value);
  }
  return tags;
}
