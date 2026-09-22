import { describe, expect, it } from 'vitest';
import { EnuFrame, type BuildingFootprint, type LonLat } from '@gme/shared';
import { ExtrusionError, buildExtrusion } from './extrude.js';

const ORIGIN = { lon: -122.4193, lat: 37.775, alt: 0 };

/**
 * Build a rectangular footprint of the given size in metres, centred on ORIGIN.
 * Going through EnuFrame rather than hand-writing degrees keeps the test's
 * expected areas exact.
 */
function rectFootprint(
  widthM: number,
  depthM: number,
  heightM: number,
  extra: Partial<BuildingFootprint> = {},
): BuildingFootprint {
  const frame = new EnuFrame(ORIGIN);
  const hw = widthM / 2;
  const hd = depthM / 2;
  const corners: Array<[number, number]> = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  const ring: LonLat[] = corners.map(([e, n]) => {
    const g = frame.toGeodetic([e, n, 0]);
    return [g.lon, g.lat];
  });
  ring.push(ring[0]!);

  return {
    osm: { id: 1, type: 'way' },
    polygon: { type: 'Polygon', coordinates: [ring] },
    heightMeters: heightM,
    minHeightMeters: 0,
    roofShape: null,
    roofHeightMeters: 0,
    tags: {},
    origin: ORIGIN,
    ...extra,
  };
}

function positionsOf(geometry: ReturnType<typeof buildExtrusion>['geometry']): Float32Array {
  return geometry.getAttribute('position').array as Float32Array;
}

/**
 * Signed volume of a triangle soup via the divergence theorem. For a closed,
 * consistently outward-wound mesh this equals the enclosed volume; a leaking
 * or inside-out mesh gives the wrong magnitude or a negative sign. One number
 * that checks watertightness and orientation at once.
 */
function signedVolume(positions: Float32Array): number {
  let total = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i]!;
    const ay = positions[i + 1]!;
    const az = positions[i + 2]!;
    const bx = positions[i + 3]!;
    const by = positions[i + 4]!;
    const bz = positions[i + 5]!;
    const cx = positions[i + 6]!;
    const cy = positions[i + 7]!;
    const cz = positions[i + 8]!;
    total +=
      ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return total / 6;
}

/** Sum of triangle areas weighted by normal direction, to spot flipped faces. */
function normalsPointOutward(
  positions: Float32Array,
  normals: Float32Array,
): boolean {
  for (let i = 0; i < positions.length; i += 9) {
    // Face centroid relative to the solid's centre, dotted with its normal.
    const cx = (positions[i]! + positions[i + 3]! + positions[i + 6]!) / 3;
    const cy = (positions[i + 1]! + positions[i + 4]! + positions[i + 7]!) / 3;
    const cz = (positions[i + 2]! + positions[i + 5]! + positions[i + 8]!) / 3;
    const nx = normals[i]!;
    const ny = normals[i + 1]!;
    const nz = normals[i + 2]!;
    // Compare against the box centre at y = height/2, x = z = 0.
    if (cx * nx + cz * nz + (cy - 5) * ny < -1e-6) return false;
  }
  return true;
}

describe('buildExtrusion', () => {
  it('produces a closed solid whose volume matches area x height', () => {
    const result = buildExtrusion(rectFootprint(20, 30, 10));
    expect(result.footprintAreaM2).toBeCloseTo(600, 3);
    expect(signedVolume(positionsOf(result.geometry))).toBeCloseTo(6000, 1);
  });

  it('orients every face outward', () => {
    const result = buildExtrusion(rectFootprint(20, 20, 10));
    const geometry = result.geometry;
    expect(
      normalsPointOutward(
        positionsOf(geometry),
        geometry.getAttribute('normal').array as Float32Array,
      ),
    ).toBe(true);
  });

  it('survives a footprint wound the wrong way round', () => {
    const footprint = rectFootprint(20, 30, 10);
    footprint.polygon.coordinates[0] = [...footprint.polygon.coordinates[0]!].reverse();
    const result = buildExtrusion(footprint);
    // Still positive: winding was normalised rather than inverting the solid.
    expect(signedVolume(positionsOf(result.geometry))).toBeCloseTo(6000, 1);
  });

  it('places the base at y=0 and the roof at the building height', () => {
    const result = buildExtrusion(rectFootprint(20, 20, 42));
    const box = result.geometry.boundingBox!;
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(box.max.y).toBeCloseTo(42, 4);
  });

  it('centres the footprint on the local origin', () => {
    const result = buildExtrusion(rectFootprint(20, 30, 10));
    const box = result.geometry.boundingBox!;
    expect(box.min.x).toBeCloseTo(-10, 2);
    expect(box.max.x).toBeCloseTo(10, 2);
    expect(box.min.z).toBeCloseTo(-15, 2);
    expect(box.max.z).toBeCloseTo(15, 2);
  });

  it('maps +X to east and +Z to south', () => {
    const frame = new EnuFrame(ORIGIN);
    const footprint = rectFootprint(20, 20, 10);
    // Push the east edge out to 30m and confirm it lands at +X.
    const g = frame.toGeodetic([30, -10, 0]);
    footprint.polygon.coordinates[0]![1] = [g.lon, g.lat];
    footprint.polygon.coordinates[0]![2] = [
      g.lon,
      frame.toGeodetic([30, 10, 0]).lat,
    ];
    const box = buildExtrusion(footprint).geometry.boundingBox!;
    expect(box.max.x).toBeCloseTo(30, 1);

    // North is -Z: the ring's northern edge (+10 north) sits at z = -10.
    expect(box.min.z).toBeCloseTo(-10, 1);
  });

  it('honours min_height by lifting the base', () => {
    const result = buildExtrusion(rectFootprint(20, 20, 30, { minHeightMeters: 10 }));
    const box = result.geometry.boundingBox!;
    expect(box.min.y).toBeCloseTo(10, 4);
    expect(box.max.y).toBeCloseTo(30, 4);
    expect(result.heightMeters).toBeCloseTo(20, 4);
    expect(signedVolume(positionsOf(result.geometry))).toBeCloseTo(400 * 20, 0);
  });

  it('subtracts courtyard holes from both the volume and the reported area', () => {
    const solid = rectFootprint(40, 40, 10);
    const frame = new EnuFrame(ORIGIN);
    // A 10x10 courtyard, wound clockwise as GeoJSON holes should be.
    const hole: Array<[number, number]> = [
      [-5, -5],
      [-5, 5],
      [5, 5],
      [5, -5],
    ];
    const holeRing: LonLat[] = hole.map(([e, n]) => {
      const g = frame.toGeodetic([e, n, 0]);
      return [g.lon, g.lat];
    });
    holeRing.push(holeRing[0]!);
    solid.polygon.coordinates.push(holeRing);

    const result = buildExtrusion(solid);
    expect(result.footprintAreaM2).toBeCloseTo(1600 - 100, 2);
    expect(signedVolume(positionsOf(result.geometry))).toBeCloseTo(15000, 0);
  });

  it('emits indexed geometry so CSG and BVH construction accept it', () => {
    const result = buildExtrusion(rectFootprint(20, 20, 10));
    expect(result.geometry.getIndex()).not.toBeNull();
    expect(result.geometry.getIndex()!.count).toBe(result.triangleCount * 3);
  });

  it('clamps a zero-height building to a usable minimum', () => {
    const result = buildExtrusion(rectFootprint(20, 20, 0));
    expect(result.heightMeters).toBeGreaterThan(0);
    expect(result.geometry.boundingBox!.max.y).toBeGreaterThan(0);
  });

  it('rejects a footprint that cannot form a polygon', () => {
    const bad = rectFootprint(20, 20, 10);
    bad.polygon.coordinates[0] = [
      [-122.4193, 37.775],
      [-122.4193, 37.775],
    ];
    expect(() => buildExtrusion(bad)).toThrow(ExtrusionError);
  });

  it('handles a non-convex L-shaped footprint', () => {
    const frame = new EnuFrame(ORIGIN);
    const lShape: Array<[number, number]> = [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10, 20],
      [0, 20],
    ];
    const ring: LonLat[] = lShape.map(([e, n]) => {
      const g = frame.toGeodetic([e, n, 0]);
      return [g.lon, g.lat];
    });
    ring.push(ring[0]!);

    const result = buildExtrusion({
      osm: { id: 2, type: 'way' },
      polygon: { type: 'Polygon', coordinates: [ring] },
      heightMeters: 10,
      minHeightMeters: 0,
      roofShape: null,
      roofHeightMeters: 0,
      tags: {},
      origin: ORIGIN,
    });

    // L-shape area = 20*20 - 10*10 = 300.
    expect(result.footprintAreaM2).toBeCloseTo(300, 2);
    expect(signedVolume(positionsOf(result.geometry))).toBeCloseTo(3000, 1);
  });

  it('tapers walls to a single apex for a pyramidal roof', () => {
    const footprint = rectFootprint(20, 20, 50, {
      roofShape: 'pyramidal',
      roofHeightMeters: 20,
    });
    const result = buildExtrusion(footprint);
    const box = result.geometry.boundingBox!;

    // Walls stop at 30m (50 - 20) and the apex reaches the full 50m height.
    expect(box.max.y).toBeCloseTo(50, 4);
    // A square pyramid of base 400 and height 20 sits atop a 20x20x30 prism.
    const prismVolume = 400 * 30;
    const pyramidVolume = (400 * 20) / 3;
    expect(signedVolume(positionsOf(result.geometry))).toBeCloseTo(
      prismVolume + pyramidVolume,
      0,
    );
  });

  it('falls back to a flat roof when roof:shape is pyramidal but no height is known', () => {
    const footprint = rectFootprint(20, 20, 50, {
      roofShape: 'pyramidal',
      roofHeightMeters: 0,
    });
    const result = buildExtrusion(footprint);
    expect(signedVolume(positionsOf(result.geometry))).toBeCloseTo(400 * 50, 0);
  });
});
