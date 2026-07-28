/**
 * Resolving a building height from OSM tags.
 *
 * OSM height tagging is inconsistent: `height` may carry units ("25 m",
 * "82'6\""), `building:levels` may be fractional ("3.5"), and plenty of
 * buildings have neither. Cesium's own extrusion falls back to a fixed guess,
 * and so do we — but we report *which* rule fired so the UI can tell the user
 * their 10 m building is a default rather than surveyed data.
 */

import {
  DEFAULT_BUILDING_HEIGHT_M,
  DEFAULT_METERS_PER_LEVEL,
  type HeightSource,
} from './types.js';

const FEET_PER_METER = 3.280839895;

/**
 * Parse an OSM length tag to metres. Handles bare numbers (metres by
 * convention), explicit "m"/"metre" suffixes, and imperial feet/inches
 * (`12'6"`, `40 ft`). Returns null when nothing sensible can be read.
 */
export function parseOsmLength(raw: string | number | undefined | null): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;

  const value = raw.trim().toLowerCase();
  if (value === '') return null;

  // Feet-and-inches form: 12'6" or 12'
  const ftIn = /^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/.exec(value);
  if (ftIn) {
    const feet = Number(ftIn[1]);
    const inches = ftIn[2] === undefined ? 0 : Number(ftIn[2]);
    const meters = (feet + inches / 12) / FEET_PER_METER;
    return meters > 0 ? meters : null;
  }

  const numeric = /^(-?\d+(?:[.,]\d+)?)\s*([a-z']*)$/.exec(value);
  if (!numeric) return null;

  const magnitude = Number(numeric[1]!.replace(',', '.'));
  if (!Number.isFinite(magnitude) || magnitude <= 0) return null;

  switch (numeric[2]) {
    case '':
    case 'm':
    case 'metre':
    case 'metres':
    case 'meter':
    case 'meters':
      return magnitude;
    case 'ft':
    case 'feet':
    case 'foot':
      return magnitude / FEET_PER_METER;
    case 'km':
      return magnitude * 1000;
    default:
      return null;
  }
}

export interface ResolvedHeight {
  heightMeters: number;
  minHeightMeters: number;
  source: HeightSource;
}

/**
 * Work out how tall to extrude a footprint.
 *
 * `tileHeight` is the height Cesium already used to draw the building on the
 * globe. Preferring it keeps the extracted mesh visually identical to what the
 * user clicked, which matters more than picking the "most correct" tag.
 */
export function resolveHeight(
  tags: Record<string, string>,
  tileHeight?: number | null,
): ResolvedHeight {
  const minHeight = parseOsmLength(tags['min_height']) ?? 0;

  if (typeof tileHeight === 'number' && Number.isFinite(tileHeight) && tileHeight > 0) {
    return { heightMeters: tileHeight, minHeightMeters: minHeight, source: 'tile-feature' };
  }

  const tagged = parseOsmLength(tags['height']) ?? parseOsmLength(tags['building:height']);
  if (tagged !== null) {
    return { heightMeters: tagged, minHeightMeters: minHeight, source: 'osm-height' };
  }

  const levels =
    parseOsmLength(tags['building:levels']) ?? parseOsmLength(tags['building:levels:aboveground']);
  if (levels !== null) {
    return {
      heightMeters: levels * DEFAULT_METERS_PER_LEVEL,
      minHeightMeters: minHeight,
      source: 'osm-building-levels',
    };
  }

  return {
    heightMeters: DEFAULT_BUILDING_HEIGHT_M,
    minHeightMeters: minHeight,
    source: 'default',
  };
}
