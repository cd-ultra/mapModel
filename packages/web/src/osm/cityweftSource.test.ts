import { describe, expect, it } from 'vitest';
import {
  CityweftFetchError,
  cityweftToThree,
  parseCityweftMesh,
  reanchor,
  type CityweftBlock,
  type CityweftMesh,
} from './cityweftSource.js';

describe('cityweftToThree', () => {
  it('maps assumed Z-up (x, y, z) to this app\'s Y-up (east, up, south)', () => {
    expect(cityweftToThree(1, 2, 3)).toEqual([1, 3, -2]);
  });
});

describe('parseCityweftMesh', () => {
  it('parses a single triangle into a Three.js geometry', () => {
    const mesh: CityweftMesh = {
      vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0],
    };
    const geometry = parseCityweftMesh(mesh, 0);
    const position = geometry.getAttribute('position');
    expect(position.count).toBe(3);
    // First vertex at origin; second (10, 0, 0) in Cityweft space becomes
    // (10, 0, 0) in Three space under the assumed axis mapping.
    expect(position.getX(1)).toBeCloseTo(10);
    expect(position.getY(1)).toBeCloseTo(0);
    expect(position.getZ(1)).toBeCloseTo(0);
  });

  it('rejects a vertex count that is not a multiple of 9', () => {
    const mesh: CityweftMesh = { vertices: [0, 0, 0, 1, 1, 1] };
    expect(() => parseCityweftMesh(mesh, 2)).toThrow(CityweftFetchError);
    expect(() => parseCityweftMesh(mesh, 2)).toThrow(/mesh 2/i);
  });

  it('rejects an empty vertex list rather than producing a degenerate geometry', () => {
    const mesh: CityweftMesh = { vertices: [] };
    expect(() => parseCityweftMesh(mesh, 0)).toThrow(CityweftFetchError);
  });
});

describe('reanchor', () => {
  it('leaves geometry unchanged when the new centre is the same point', () => {
    const origin = { lon: -122.4194, lat: 37.7749, alt: 0 };
    const mesh: CityweftMesh = { vertices: [0, 0, 0, 5, 0, 0, 0, 5, 0] };
    const block: CityweftBlock = {
      origin,
      buildings: [{ id: 'cityweft-0', geometry: parseCityweftMesh(mesh, 0) }],
    };

    const result = reanchor(block, origin);
    const position = result.buildings[0]!.geometry.getAttribute('position');
    expect(position.getX(1)).toBeCloseTo(5);
    expect(position.getY(1)).toBeCloseTo(0);
    expect(position.getZ(1)).toBeCloseTo(0);
  });

  it('shifts every vertex by the offset to the new centre', () => {
    const origin = { lon: -122.4194, lat: 37.7749, alt: 0 };
    // ~0.0009 degrees east is roughly 80m at this latitude.
    const newCenter = { lon: -122.4194 + 0.0009, lat: 37.7749, alt: 0 };
    const mesh: CityweftMesh = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0] };
    const block: CityweftBlock = {
      origin,
      buildings: [{ id: 'cityweft-0', geometry: parseCityweftMesh(mesh, 0) }],
    };

    const result = reanchor(block, newCenter);
    expect(result.origin).toEqual(newCenter);
    const position = result.buildings[0]!.geometry.getAttribute('position');
    // The building is now west of the new centre, so its local x (east) is negative.
    expect(position.getX(0)).toBeLessThan(-70);
    expect(position.getX(0)).toBeGreaterThan(-90);
  });
});
