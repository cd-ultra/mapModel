import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';
import { buildCityweftBlockMesh } from './buildCityweftBlockMesh.js';
import { parseCityweftMesh } from '../osm/cityweftSource.js';
import type { CityweftBuilding } from '../osm/cityweftSource.js';

function building(id: string, x: number, z: number, size = 10): CityweftBuilding {
  const hw = size / 2;
  // A flat quad (two triangles) in the XZ plane, offset to (x, z).
  const vertices = [
    x - hw, 0, z - hw, x + hw, 0, z - hw, x + hw, 0, z + hw,
    x - hw, 0, z - hw, x + hw, 0, z + hw, x - hw, 0, z + hw,
  ];
  return { id, geometry: parseCityweftMesh({ vertices }, 0) };
}

function meshesOf(object: { children: unknown[] }): Mesh[] {
  return object.children.filter((c): c is Mesh => c instanceof Mesh);
}

describe('buildCityweftBlockMesh', () => {
  it('puts every building plus a base plate in one ungrouped group', () => {
    const result = buildCityweftBlockMesh([building('cityweft-0', -15, 0), building('cityweft-1', 15, 0)]);
    const meshes = meshesOf(result.group);
    expect(meshes).toHaveLength(3);
    expect(meshes.some((m) => m.name === 'base-plate')).toBe(true);
    expect(meshes.some((m) => m.name === 'cityweft-0')).toBe(true);
    expect(meshes.some((m) => m.name === 'cityweft-1')).toBe(true);
  });

  it('sizes the base plate to the buildings plus margin', () => {
    const result = buildCityweftBlockMesh(
      [building('cityweft-0', -50, 0), building('cityweft-1', 50, 0)],
      { marginM: 5 },
    );
    // Buildings span x in [-55, 55] (each 10 wide) -> 110m, plus 5m margin each side.
    expect(result.widthMeters).toBeCloseTo(120, 0);
  });

  it('falls back to a default footprint with no buildings', () => {
    const result = buildCityweftBlockMesh([]);
    expect(result.widthMeters).toBeGreaterThan(0);
    expect(meshesOf(result.group)).toHaveLength(1); // just the base plate
  });
});
