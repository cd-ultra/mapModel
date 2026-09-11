/**
 * Footprint + height -> extruded building mesh.
 *
 * Cesium OSM Buildings are themselves procedural extrusions of OSM footprints,
 * so regenerating the solid from footprint + height reproduces what the user
 * clicked while giving us clean, editable geometry instead of an opaque baked
 * tile.
 *
 * ## Coordinate convention
 *
 * Output is in Three.js's Y-up convention, anchored at the footprint centroid:
 *
 *   +X = east, +Y = up, +Z = south (i.e. -north)
 *
 * This is deliberate. glTF is Y-up, and Cesium's `Model` applies its default
 * Y-up -> Z-up correction (a +90 degree rotation about X) when loading glTF,
 * which maps (x, y, z) -> (x, -z, y) = (east, north, up). So a mesh authored in
 * this convention drops straight into an east-north-up frame on the globe with
 * no extra fix-up matrix. See `globe/placement.ts`.
 */

import earcut from 'earcut';
import { BufferAttribute, BufferGeometry } from 'three';
import { EnuFrame, openRing, signedArea, type BuildingFootprint } from '@gme/shared';

export interface ExtrusionResult {
  geometry: BufferGeometry;
  /** Local ENU frame the geometry is expressed in, needed to re-georeference. */
  frame: EnuFrame;
  /** Footprint area in square metres, for the info panel. */
  footprintAreaM2: number;
  /** Height actually extruded, after clamping. */
  heightMeters: number;
  triangleCount: number;
}

export class ExtrusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtrusionError';
  }
}

/** Minimum wall height; degenerate zero-height solids break CSG and shading. */
const MIN_EXTRUSION_M = 0.1;

interface Ring2D {
  /** Open ring (no duplicated closing vertex) in local ENU metres. */
  points: Array<[number, number]>;
}

function projectRings(footprint: BuildingFootprint, frame: EnuFrame): Ring2D[] {
  const rings = footprint.polygon.coordinates.map((ring) => ({
    points: openRing(ring).map((coord) => frame.lonLatToEnu2d(coord)),
  }));

  const outer = rings[0];
  if (!outer || outer.points.length < 3) {
    throw new ExtrusionError('Footprint outer ring has fewer than 3 distinct vertices');
  }

  // Drop degenerate holes rather than feeding earcut a ring it cannot resolve.
  return [outer, ...rings.slice(1).filter((r) => r.points.length >= 3)];
}

/**
 * Ensure the outer ring is counter-clockwise and holes clockwise in the ENU
 * plane. `parseOverpassFootprint` already does this, but extraction can also be
 * fed footprints from a self-hosted PostGIS mirror whose winding is not
 * guaranteed, and a flipped outer ring silently inverts every normal.
 */
function normaliseWinding(rings: Ring2D[]): Ring2D[] {
  return rings.map((ring, index) => {
    const wantCcw = index === 0;
    const isCcw = signedArea(ring.points) > 0;
    return isCcw === wantCcw ? ring : { points: [...ring.points].reverse() };
  });
}

/** Triangle soup accumulator: one unique vertex per corner, so normals stay flat. */
class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];

  get triangleCount(): number {
    return this.positions.length / 9;
  }

  addTriangle(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;

    const len = Math.hypot(nx, ny, nz);
    // Skip slivers: they contribute nothing visually and produce NaN normals
    // that poison downstream CSG.
    if (len < 1e-12) return;
    nx /= len;
    ny /= len;
    nz /= len;

    this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i += 1) this.normals.push(nx, ny, nz);
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    const positions = new Float32Array(this.positions);
    const normals = new Float32Array(this.normals);

    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));

    // three-bvh-csg and three-mesh-bvh both prefer indexed geometry. Every
    // corner is already unique, so a trivial 0..n-1 index keeps flat normals
    // while satisfying them.
    const count = positions.length / 3;
    const index =
      count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i += 1) index[i] = i;
    geometry.setIndex(new BufferAttribute(index, 1));

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** ENU metres -> Three.js local space (see the coordinate convention above). */
function toThree(east: number, north: number, up: number): [number, number, number] {
  return [east, up, -north];
}

/**
 * Build a watertight solid from a footprint: a triangulated floor and roof
 * joined by vertical walls around every ring.
 *
 * `frame` defaults to one centred on the footprint itself (the single-building
 * extract/edit/place path). The block-model path passes a frame shared across
 * every building in an area instead, so every extrusion lands in one
 * consistent local space rather than each being centred on its own centroid.
 */
export function buildExtrusion(
  footprint: BuildingFootprint,
  frame: EnuFrame = new EnuFrame(footprint.origin),
): ExtrusionResult {
  const rings = normaliseWinding(projectRings(footprint, frame));

  const base = footprint.minHeightMeters;
  const top = Math.max(footprint.heightMeters, base + MIN_EXTRUSION_M);

  // earcut wants one flat coordinate array with hole start indices.
  const flat: number[] = [];
  const holeIndices: number[] = [];
  rings.forEach((ring, index) => {
    if (index > 0) holeIndices.push(flat.length / 2);
    for (const [e, n] of ring.points) flat.push(e, n);
  });

  const triangles = earcut(flat, holeIndices, 2);
  if (triangles.length === 0) {
    throw new ExtrusionError(
      'Triangulation produced no faces — the footprint is likely self-intersecting or collapsed',
    );
  }

  const builder = new MeshBuilder();
  const vertex = (i: number): [number, number] => [flat[i * 2]!, flat[i * 2 + 1]!];

  // Roof and floor. earcut preserves the outer ring's counter-clockwise
  // winding, which maps to +Y normals under `toThree`; the floor is the same
  // triangles reversed.
  for (let i = 0; i < triangles.length; i += 3) {
    const [ax, an] = vertex(triangles[i]!);
    const [bx, bn] = vertex(triangles[i + 1]!);
    const [cx, cn] = vertex(triangles[i + 2]!);

    builder.addTriangle(toThree(ax, an, top), toThree(bx, bn, top), toThree(cx, cn, top));
    builder.addTriangle(toThree(cx, cn, base), toThree(bx, bn, base), toThree(ax, an, base));
  }

  // Walls. Winding is right-of-travel for both the CCW outer ring and the CW
  // hole rings, so the same quad ordering yields outward-facing normals in
  // both cases.
  for (const ring of rings) {
    const pts = ring.points;
    for (let i = 0; i < pts.length; i += 1) {
      const [e0, n0] = pts[i]!;
      const [e1, n1] = pts[(i + 1) % pts.length]!;

      const b0 = toThree(e0, n0, base);
      const b1 = toThree(e1, n1, base);
      const t1 = toThree(e1, n1, top);
      const t0 = toThree(e0, n0, top);

      builder.addTriangle(b0, b1, t1);
      builder.addTriangle(b0, t1, t0);
    }
  }

  const outerRing = rings[0]!;
  let area = Math.abs(signedArea(outerRing.points));
  for (const hole of rings.slice(1)) area -= Math.abs(signedArea(hole.points));

  return {
    geometry: builder.build(),
    frame,
    footprintAreaM2: Math.max(area, 0),
    heightMeters: top - base,
    triangleCount: builder.triangleCount,
  };
}
