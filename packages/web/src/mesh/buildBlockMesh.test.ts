import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial } from 'three';
import { EnuFrame, type BuildingFootprint, type LonLat } from '@gme/shared';
import { buildBlockMesh } from './buildBlockMesh.js';

const CENTER = { lon: -122.4193, lat: 37.775, alt: 0 };

/** A rectangular footprint offset `east`/`north` metres from CENTER. */
function rectFootprint(
  id: number,
  east: number,
  north: number,
  widthM: number,
  depthM: number,
  heightM = 10,
): BuildingFootprint {
  const frame = new EnuFrame(CENTER);
  const hw = widthM / 2;
  const hd = depthM / 2;
  const corners: Array<[number, number]> = [
    [east - hw, north - hd],
    [east + hw, north - hd],
    [east + hw, north + hd],
    [east - hw, north + hd],
  ];
  const ring: LonLat[] = corners.map(([e, n]) => {
    const g = frame.toGeodetic([e, n, 0]);
    return [g.lon, g.lat];
  });
  ring.push(ring[0]!);
  const originLonLat = frame.toGeodetic([east, north, 0]);

  return {
    osm: { id, type: 'way' },
    polygon: { type: 'Polygon', coordinates: [ring] },
    heightMeters: heightM,
    minHeightMeters: 0,
    tags: {},
    origin: { lon: originLonLat.lon, lat: originLonLat.lat, alt: 0 },
  };
}

function meshesOf(object: { children: unknown[] }): Mesh[] {
  return object.children.filter((c): c is Mesh => c instanceof Mesh);
}

describe('buildBlockMesh', () => {
  it('puts every building and a base plate in `rest` when nothing is highlighted', () => {
    const a = rectFootprint(1, -15, 0, 10, 10);
    const b = rectFootprint(2, 15, 0, 10, 10);

    const result = buildBlockMesh([a, b], CENTER, null);

    expect(result.highlighted).toBeNull();
    const restMeshes = meshesOf(result.rest);
    // Base plate + two buildings.
    expect(restMeshes).toHaveLength(3);
    expect(restMeshes.some((m) => m.name === 'base-plate')).toBe(true);
    expect(restMeshes.some((m) => m.name === 'way/1')).toBe(true);
    expect(restMeshes.some((m) => m.name === 'way/2')).toBe(true);
  });

  it('splits the highlighted building into its own group, out of `rest`', () => {
    const a = rectFootprint(1, -15, 0, 10, 10);
    const b = rectFootprint(2, 15, 0, 10, 10);

    const result = buildBlockMesh([a, b], CENTER, { id: 2, type: 'way' });

    expect(result.highlighted).not.toBeNull();
    const highlightMeshes = meshesOf(result.highlighted!);
    expect(highlightMeshes).toHaveLength(1);
    expect(highlightMeshes[0]!.name).toBe('way/2');

    const restMeshes = meshesOf(result.rest);
    // Base plate + the one non-highlighted building only.
    expect(restMeshes).toHaveLength(2);
    expect(restMeshes.some((m) => m.name === 'way/2')).toBe(false);
  });

  it('gives the highlighted building a different material colour than the rest', () => {
    const a = rectFootprint(1, 0, 0, 10, 10);
    const result = buildBlockMesh([a], CENTER, { id: 1, type: 'way' });

    const highlightMesh = meshesOf(result.highlighted!)[0]!;
    const baseMesh = meshesOf(result.rest).find((m) => m.name === 'base-plate')!;

    expect(highlightMesh.material).toBeInstanceOf(MeshStandardMaterial);
    expect(baseMesh.material).toBeInstanceOf(MeshStandardMaterial);
    const highlightColor = (highlightMesh.material as MeshStandardMaterial).color.getHex();
    const baseColor = (baseMesh.material as MeshStandardMaterial).color.getHex();
    expect(highlightColor).not.toBe(baseColor);
  });

  it('sizes the base plate to cover every building plus the margin', () => {
    const a = rectFootprint(1, -50, 0, 10, 10);
    const b = rectFootprint(2, 50, 0, 10, 10);

    const result = buildBlockMesh([a, b], CENTER, null, { marginM: 5 });

    // Footprints span x in [-55, 55] -> 110m, plus 5m margin each side.
    expect(result.widthMeters).toBeCloseTo(120, 0);
  });

  it('skips a footprint that fails to extrude instead of throwing', () => {
    const good = rectFootprint(1, 0, 0, 10, 10);
    const degenerate: BuildingFootprint = {
      osm: { id: 99, type: 'way' },
      polygon: { type: 'Polygon', coordinates: [[[0, 0]]] },
      heightMeters: 10,
      minHeightMeters: 0,
      tags: {},
      origin: CENTER,
    };

    const result = buildBlockMesh([good, degenerate], CENTER, null);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.osm.id).toBe(99);
  });

  it('falls back to a default footprint when there are no buildings', () => {
    const result = buildBlockMesh([], CENTER, null);
    expect(result.widthMeters).toBeGreaterThan(0);
    expect(meshesOf(result.rest)).toHaveLength(1); // just the base plate
  });
});

// Sanity check that BoxGeometry is what the base plate actually uses, so a
// refactor away from it does not silently change the exported shape.
describe('base plate geometry', () => {
  it('is a box', () => {
    const result = buildBlockMesh(
      [rectFootprint(1, 0, 0, 10, 10)],
      CENTER,
      null,
    );
    const base = meshesOf(result.rest).find((m) => m.name === 'base-plate')!;
    expect(base.geometry).toBeInstanceOf(BoxGeometry);
  });
});
