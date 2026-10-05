/**
 * Cityweft buildings -> a printable block, the same base-plate-plus-buildings
 * shape as `buildBlockMesh`, but without a highlight split: Cityweft's
 * response (see `osm/cityweftSource.ts`) carries no confirmed per-building id
 * to single one out by, so every building here renders and exports as one
 * ungrouped mass in the block's pastel colour.
 */

import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import type { CityweftBuilding } from '../osm/cityweftSource.js';

const BASE_COLOR = 0xf1ece1;

export interface CityweftBlockMeshOptions {
  baseThicknessM?: number;
  marginM?: number;
}

export interface CityweftBlockMeshResult {
  group: Object3D;
  widthMeters: number;
  depthMeters: number;
}

export function buildCityweftBlockMesh(
  buildings: CityweftBuilding[],
  options: CityweftBlockMeshOptions = {},
): CityweftBlockMeshResult {
  const baseThicknessM = options.baseThicknessM ?? 3;
  const marginM = options.marginM ?? 5;
  const material = new MeshStandardMaterial({ color: BASE_COLOR, roughness: 0.9, metalness: 0 });

  const group = new Group();
  group.name = 'cityweft-block';

  const extent = new Box3();
  for (const building of buildings) {
    const mesh = new Mesh(building.geometry, material);
    mesh.name = building.id;
    group.add(mesh);
    if (!building.geometry.boundingBox) building.geometry.computeBoundingBox();
    extent.union(building.geometry.boundingBox!);
  }

  const size = extent.isEmpty() ? new Vector3(20, 0, 20) : extent.getSize(new Vector3());
  const widthMeters = size.x + marginM * 2;
  const depthMeters = size.z + marginM * 2;

  const base = new Mesh(new BoxGeometry(widthMeters, baseThicknessM, depthMeters), material);
  base.name = 'base-plate';
  base.position.set(0, -baseThicknessM / 2, 0);
  group.add(base);

  return { group, widthMeters, depthMeters };
}
