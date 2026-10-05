/**
 * Cityweft as a second data source for the block model, alongside Overpass.
 *
 * Status: EXPERIMENTAL / UNVERIFIED. There is no official public API
 * reference reachable from this environment (cityweft.com and its GitBook
 * docs are both unreachable here), and we have no API key to test against.
 * Everything below is reverse-engineered from a third-party open-source
 * client, github.com/seghier/cityweftapp (`services/api.ts`, `types.ts`),
 * which does make real, working requests against `api.cityweft.com`. That
 * makes the *request* shape trustworthy — it is live, shipped client code —
 * but several things about the *response* could not be confirmed and are
 * called out below. Get a real API key and hit `fetchCityweftBlock` with
 * `{ geometry: ['buildings'] }` over a small, known area before trusting
 * this for anything: compare `buildings.length` against the area's actual
 * building count, and eyeball one building's geometry against its footprint.
 *
 * Known-unverified assumptions, in descending order of how badly a wrong
 * guess would break things:
 *
 * 1. Per-building separation. The response is documented (via the
 *    third-party client's types) as one `geometry` entry per requested
 *    `GeometryType` (e.g. one entry for `'buildings'`), each carrying a
 *    `meshes` array. This code assumes one `meshes[]` entry = one building,
 *    which is the only way a per-building highlight is possible — but it
 *    could just as easily be one fewer mesh than that (the whole area's
 *    buildings merged into a single mesh) or more (a building split by
 *    material/LOD). If it is not 1:1, callers will see `buildings.length`
 *    land at 1 or some other obviously-wrong number.
 * 2. Units and up-axis. Assumed metres, Z-up (the AEC/CAD norm Cityweft's
 *    own export formats — SKP, 3DM, DXF — all use), converted here to this
 *    app's Y-up convention. If this is wrong, geometry will still parse
 *    without error but render sideways or at the wrong scale.
 * 3. Vertex layout. `vertices: number[]` is assumed to be a flat,
 *    non-indexed triangle soup of (x, y, z) triples — the simplest and most
 *    common convention for a field with that name, and this code validates
 *    the length is a multiple of 9 and throws rather than silently
 *    misinterpreting a different layout (e.g. indexed, or (x,y,z,nx,ny,nz)).
 * 4. Polygon coordinate order. Cityweft's own marketing copy says "latitude
 *    and longitude", so this sends `[lat, lon]` pairs — the opposite of the
 *    `[lon, lat]` this app and GeoJSON otherwise use everywhere. Get this
 *    backwards and every building lands at the mirrored point on the globe,
 *    which should be obvious immediately in testing.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Vector3,
} from 'three';
import { EnuFrame, type LonLat, type LonLatAlt } from '@gme/shared';

const API_BASE_URL = 'https://api.cityweft.com/v1';

export class CityweftFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CityweftFetchError';
  }
}

/** Exported for the unit test; not part of the module's public workflow. */
export interface CityweftMesh {
  vertices: number[];
  descriptor?: Record<string, unknown>;
}

interface CityweftGeometryEntry {
  type: string;
  geometryType: string;
  meshes?: CityweftMesh[];
}

interface CityweftContextResponse {
  origin: [number, number];
  geometry: CityweftGeometryEntry[];
}

export interface CityweftBuilding {
  /**
   * Synthetic, not an OSM id — Cityweft's response carries no stable
   * building identifier in what we could confirm (see assumption 1 above).
   * Stable only within one response, by `meshes[]` array position.
   */
  id: string;
  geometry: BufferGeometry;
}

export interface CityweftBlock {
  origin: LonLatAlt;
  buildings: CityweftBuilding[];
}

/**
 * See assumption 2: swap to whatever the real API turns out to use. Exported
 * for the unit test, which can at least pin down today's conversion even
 * though it cannot confirm it is the right one.
 */
export function cityweftToThree(x: number, y: number, z: number): [number, number, number] {
  // Z-up (x, y, z) -> this app's Y-up (east, up, south): (x, z, -y).
  return [x, z, -y];
}

/** Exported for the unit test; not part of the module's public workflow. */
export function parseCityweftMesh(mesh: CityweftMesh, index: number): BufferGeometry {
  const flat = mesh.vertices;
  if (!Array.isArray(flat) || flat.length === 0 || flat.length % 9 !== 0) {
    throw new CityweftFetchError(
      `Mesh ${index} has ${flat?.length ?? 0} vertex numbers, which is not a ` +
        `non-zero multiple of 9 (3 per vertex, 3 vertices per triangle). ` +
        `The assumed flat-triangle-soup layout (see cityweftSource.ts) does ` +
        `not match this response — check Cityweft's actual schema.`,
    );
  }

  const positions = new Float32Array(flat.length);
  for (let i = 0; i < flat.length; i += 3) {
    const [x, y, z] = cityweftToThree(flat[i]!, flat[i + 1]!, flat[i + 2]!);
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export interface CityweftBlockRequest {
  /** Closed or open polygon; sent as-is. See assumption 4 on coordinate order. */
  polygon: LonLat[];
  apiKey: string;
  signal?: AbortSignal;
}

export async function fetchCityweftBlock(request: CityweftBlockRequest): Promise<CityweftBlock> {
  const response = await fetch(`${API_BASE_URL}/context`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    // [lat, lon] per assumption 4 — the inverse of this app's usual [lon, lat].
    body: JSON.stringify({
      polygon: request.polygon.map(([lon, lat]) => [lat, lon]),
      settings: {
        geometry: ['buildings'],
        crs: 'local',
        cropScene: true,
      },
    }),
    signal: request.signal ?? null,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new CityweftFetchError(
      `Cityweft returned ${response.status}${
        detail && typeof detail === 'object' && 'error' in detail ? `: ${String(detail.error)}` : ''
      }`,
    );
  }

  const data = (await response.json()) as CityweftContextResponse;
  const buildingsEntry = data.geometry?.find((entry) => entry.type === 'buildings');
  const meshes = buildingsEntry?.meshes ?? [];

  return {
    // data.origin is documented as [lat, lon] by the same convention as the request.
    origin: { lat: data.origin[0], lon: data.origin[1], alt: 0 },
    buildings: meshes.map((mesh, index) => ({
      id: `cityweft-${index}`,
      geometry: parseCityweftMesh(mesh, index),
    })),
  };
}

/**
 * Re-anchor a Cityweft response onto this app's chosen block centre.
 *
 * Cityweft returns geometry local to its own `origin`, which is the polygon
 * passed in, not necessarily the point the user clicked as the block centre.
 * This shifts every vertex by the flat ENU offset between the two origins —
 * the same flat-tangent-plane approximation `buildBlockMesh` already relies
 * on at block scale, not a full re-projection per vertex. Unused until a
 * real key confirms the assumptions above; kept here so wiring it in later
 * is a one-line change rather than new geometry math.
 */
export function reanchor(block: CityweftBlock, newCenter: LonLatAlt): CityweftBlock {
  const to = new EnuFrame(newCenter);
  const [east, north, up] = to.toEnu(block.origin);
  // Match extrude.ts's `toThree`: (east, north, up) -> (east, up, -north).
  const offset = new Vector3(east, up, -north);

  for (const building of block.buildings) {
    building.geometry.translate(offset.x, offset.y, offset.z);
  }

  return { ...block, origin: newCenter };
}
