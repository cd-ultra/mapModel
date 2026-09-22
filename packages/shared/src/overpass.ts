/**
 * Overpass API query construction and response parsing.
 *
 * Cesium OSM Buildings tiles carry the OSM element id but not the footprint
 * geometry, so the footprint has to be fetched separately. This module is pure
 * so the same code path serves the browser's direct-to-Overpass mode and the
 * server's cached proxy, and so ring stitching can be tested without a network.
 */

import { EnuFrame, openRing, ringCentroid, signedArea } from './geo.js';
import { resolveHeight } from './height.js';
import type {
  BboxDegrees,
  BuildingFootprint,
  FootprintResponse,
  HeightSource,
  LonLat,
  OsmRef,
} from './types.js';
import { OSM_ATTRIBUTION } from './types.js';

export const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/**
 * Overpass answers overload with 429 and 502/503/504. All clear up on their
 * own — a complex building (a cathedral's multipolygon, a stepped tower's
 * many members) is more likely to graze the public instance's own processing
 * budget, not less likely to ever succeed — so callers on both ends (the
 * server's proxy, the browser's direct-to-Overpass fallback) retry these
 * rather than surfacing them at the first attempt.
 */
export function isRetryableOverpassStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * `out geom` returns full coordinates inline, which avoids a second round trip
 * to resolve node references — important because Overpass rate-limits by
 * request count as well as by CPU time.
 */
export function buildOverpassQuery(ref: OsmRef, timeoutSeconds = 25): string {
  if (!Number.isInteger(ref.id) || ref.id <= 0) {
    throw new Error(`Invalid OSM id: ${ref.id}`);
  }
  const selector = ref.type === 'relation' ? 'relation' : 'way';
  return `[out:json][timeout:${timeoutSeconds}];${selector}(${ref.id});out geom tags;`;
}

/**
 * Query every tagged building within a bounding box — the "block model" path,
 * which extracts a whole neighbourhood instead of one picked building. Scoped
 * to `building`/`building:part` so the result is not swamped by roads, trees,
 * and address nodes that also happen to fall inside the box.
 */
export function buildOverpassBboxQuery(bbox: BboxDegrees, timeoutSeconds = 60): string {
  if (bbox.south >= bbox.north || bbox.west >= bbox.east) {
    throw new Error(
      `Invalid bounding box: south/west must be less than north/east (got ${JSON.stringify(bbox)})`,
    );
  }
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return (
    `[out:json][timeout:${timeoutSeconds}];` +
    `(way["building"](${box});relation["building"](${box}););` +
    `out geom tags;`
  );
}

interface OverpassPoint {
  lat: number;
  lon: number;
}

interface OverpassMember {
  type?: string;
  ref?: number;
  role?: string;
  geometry?: OverpassPoint[];
}

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: OverpassPoint[];
  members?: OverpassMember[];
}

export interface OverpassResponse {
  elements?: OverpassElement[];
}

export class OverpassParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverpassParseError';
  }
}

const RING_EPSILON = 1e-9;

function samePoint(a: LonLat, b: LonLat): boolean {
  return Math.abs(a[0] - b[0]) < RING_EPSILON && Math.abs(a[1] - b[1]) < RING_EPSILON;
}

function toLonLat(points: OverpassPoint[]): LonLat[] {
  return points.map((p) => [p.lon, p.lat] as LonLat);
}

/**
 * Stitch open way segments into closed rings.
 *
 * OSM multipolygon relations routinely split one physical ring across several
 * ways, in arbitrary order and arbitrary direction, so segments must be walked
 * end-to-end and reversed as needed. Segments that never close are dropped
 * rather than throwing: a relation with one broken member should still yield a
 * usable footprint from its intact members.
 */
export function stitchRings(segments: LonLat[][]): LonLat[][] {
  const pending = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const rings: LonLat[][] = [];

  while (pending.length > 0) {
    const current = pending.shift()!;

    // A member that is already a closed way needs no stitching.
    if (samePoint(current[0]!, current[current.length - 1]!)) {
      rings.push(current);
      continue;
    }

    let extended = true;
    while (extended) {
      extended = false;
      const tail = current[current.length - 1]!;

      for (let i = 0; i < pending.length; i += 1) {
        const candidate = pending[i]!;
        const head = candidate[0]!;
        const last = candidate[candidate.length - 1]!;

        if (samePoint(tail, head)) {
          current.push(...candidate.slice(1));
        } else if (samePoint(tail, last)) {
          current.push(...candidate.slice(0, -1).reverse());
        } else {
          continue;
        }

        pending.splice(i, 1);
        extended = true;
        break;
      }

      if (samePoint(current[0]!, current[current.length - 1]!)) break;
    }

    if (samePoint(current[0]!, current[current.length - 1]!) && current.length >= 4) {
      rings.push(current);
    }
  }

  return rings;
}

/** Close a ring by repeating its first vertex, as GeoJSON requires. */
function closeRing(ring: LonLat[]): LonLat[] {
  const open = openRing(ring);
  return open.length >= 3 ? [...open, open[0]!] : open;
}

/**
 * Planar area of a lon/lat ring in square metres, via a local tangent frame.
 * Used only to rank candidate outer rings, so the frame's own origin is
 * irrelevant as long as it is consistent.
 */
function ringAreaMeters(ring: LonLat[], frame: EnuFrame): number {
  const projected = openRing(ring).map((c) => frame.lonLatToEnu2d(c));
  return Math.abs(signedArea(projected));
}

function extractRings(element: OverpassElement): { outer: LonLat[][]; inner: LonLat[][] } {
  if (element.type === 'way') {
    if (!element.geometry || element.geometry.length < 3) {
      throw new OverpassParseError(
        `OSM way ${element.id} has no usable geometry — it may be a node-only or deleted element`,
      );
    }
    return { outer: [closeRing(toLonLat(element.geometry))], inner: [] };
  }

  if (element.type === 'relation') {
    const members = element.members ?? [];
    const outerSegments: LonLat[][] = [];
    const innerSegments: LonLat[][] = [];

    for (const member of members) {
      if (member.type !== 'way' || !member.geometry || member.geometry.length < 2) continue;

      // Two conventions carry a footprint boundary here: a plain multipolygon
      // relation (roles "outer"/"inner", or blank on some older data), and a
      // "Simple 3D Buildings" `type=building` relation (role "outline" for
      // the footprint). Complex buildings — a stepped tower, a cathedral —
      // are exactly the ones commonly split into multiple `building:part`/
      // `roof` members alongside the outline, and weaving those unrelated
      // segments into the boundary stitcher is what used to make ring
      // closure fail for them specifically: skip anything that is not one of
      // the boundary roles.
      if (member.role === 'inner') {
        innerSegments.push(toLonLat(member.geometry));
        continue;
      }
      if (!member.role || member.role === 'outer' || member.role === 'outline') {
        outerSegments.push(toLonLat(member.geometry));
      }
    }

    const outer = stitchRings(outerSegments).map(closeRing).filter((r) => r.length >= 4);
    const inner = stitchRings(innerSegments).map(closeRing).filter((r) => r.length >= 4);

    if (outer.length === 0) {
      throw new OverpassParseError(
        `OSM relation ${element.id} yielded no closed outer ring`,
      );
    }
    return { outer, inner };
  }

  throw new OverpassParseError(`Unsupported OSM element type "${element.type}"`);
}

/**
 * Normalise ring winding for triangulation: outer counter-clockwise, holes
 * clockwise. earcut infers holes from index ranges rather than winding, but
 * consistent winding keeps generated roof normals facing up.
 */
function orientRings(outer: LonLat[], holes: LonLat[][], frame: EnuFrame) {
  const orient = (ring: LonLat[], wantCcw: boolean): LonLat[] => {
    const projected = openRing(ring).map((c) => frame.lonLatToEnu2d(c));
    const isCcw = signedArea(projected) > 0;
    return isCcw === wantCcw ? ring : [...ring].reverse();
  };
  return {
    outer: orient(outer, true),
    holes: holes.map((h) => orient(h, false)),
  };
}

export interface ParseOptions {
  /**
   * Height Cesium used for this building on the globe. Preferred over OSM tags
   * so the extracted mesh matches what the user actually clicked.
   */
  tileHeight?: number | null;
}

/**
 * Footprint extraction shared by the single-building and area queries:
 * pick the largest outer ring, centre a frame on it, orient rings, resolve
 * height. Kept element-scoped (no response-wide lookup) so it serves both a
 * single matched element and a bulk area scan.
 */
function footprintFromElement(
  element: OverpassElement,
  ref: OsmRef,
  options: ParseOptions,
): FootprintResponse & { droppedOuterRings: number } {
  const { outer, inner } = extractRings(element);

  // Provisional frame anchored on the first ring, used only for area ranking
  // and winding checks before the real centroid is known.
  const seed = outer[0]!;
  const seedCentroid = ringCentroid(openRing(seed));
  const seedFrame = new EnuFrame({ lon: seedCentroid[0], lat: seedCentroid[1], alt: 0 });

  let bestOuter = outer[0]!;
  let bestArea = ringAreaMeters(bestOuter, seedFrame);
  for (const ring of outer.slice(1)) {
    const area = ringAreaMeters(ring, seedFrame);
    if (area > bestArea) {
      bestOuter = ring;
      bestArea = area;
    }
  }

  const centroidLonLat = ringCentroid(openRing(bestOuter));
  const frame = new EnuFrame({ lon: centroidLonLat[0], lat: centroidLonLat[1], alt: 0 });
  const oriented = orientRings(bestOuter, inner, frame);

  const tags = element.tags ?? {};
  const height = resolveHeight(tags, options.tileHeight);

  const footprint: BuildingFootprint = {
    osm: ref,
    polygon: {
      type: 'Polygon',
      coordinates: [oriented.outer, ...oriented.holes],
    },
    heightMeters: height.heightMeters,
    minHeightMeters: height.minHeightMeters,
    tags,
    origin: { lon: centroidLonLat[0], lat: centroidLonLat[1], alt: 0 },
  };

  return {
    footprint,
    heightSource: height.source,
    attribution: OSM_ATTRIBUTION,
    droppedOuterRings: outer.length - 1,
  };
}

/**
 * Turn a raw Overpass JSON response into a footprint ready for extrusion.
 *
 * Multipolygon relations may legitimately contain several disjoint outer rings
 * (a building split by a courtyard passage, say). The editor works on one mesh
 * at a time, so the largest outer ring wins and its holes come along; the rest
 * are reported in `droppedOuterRings` rather than silently discarded.
 */
export function parseOverpassFootprint(
  response: OverpassResponse,
  ref: OsmRef,
  options: ParseOptions = {},
): FootprintResponse & { droppedOuterRings: number } {
  const elements = response.elements ?? [];
  const element = elements.find((e) => e.id === ref.id && e.type === ref.type);

  if (!element) {
    throw new OverpassParseError(
      `Overpass returned no ${ref.type} with id ${ref.id}. The building may have been edited or deleted in OSM since the Cesium tileset was built.`,
    );
  }

  return footprintFromElement(element, ref, options);
}

export interface AreaFootprint {
  footprint: BuildingFootprint;
  heightSource: HeightSource;
}

/**
 * Turn a bbox Overpass response into every footprint that parsed cleanly.
 *
 * Unlike `parseOverpassFootprint`, a bad element here (a relation with no
 * closed outer ring, a way OSM has since deleted) should not sink the whole
 * area — it is one building out of a block, so it is skipped rather than
 * thrown. Each footprint keeps its own centroid-anchored `origin`, exactly
 * like a single-building extraction, so `buildExtrusion` works unchanged;
 * callers that need every building in one shared frame (the block model)
 * reproject at mesh-build time.
 */
export function parseOverpassAreaFootprints(
  response: OverpassResponse,
  options: ParseOptions = {},
): AreaFootprint[] {
  const elements = response.elements ?? [];
  const results: AreaFootprint[] = [];

  for (const element of elements) {
    if (element.type !== 'way' && element.type !== 'relation') continue;
    const ref: OsmRef = { id: element.id, type: element.type };

    try {
      const { footprint, heightSource } = footprintFromElement(element, ref, options);
      results.push({ footprint, heightSource });
    } catch {
      // One malformed element should not sink the rest of the block.
      continue;
    }
  }

  return results;
}
