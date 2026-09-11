/**
 * Footprints in an area -> a printable "block model": a base plate plus every
 * building extruded onto it, in the pastel-monochrome-with-one-accent style
 * (see lichtbild.com's laser-cut city blocks) that this feature is modelled
 * on — except here exactly one building is called out in a contrast colour
 * instead of the whole block reading as one undifferentiated mass.
 *
 * Every footprint is extruded into a single shared ENU frame centred on the
 * block (not each building's own centroid, which is what `buildExtrusion`
 * does by default) so buildings land at their correct positions relative to
 * each other and to the base plate.
 */

import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
} from 'three';
import { EnuFrame, openRing, type BuildingFootprint, type LonLatAlt, type OsmRef } from '@gme/shared';
import { buildExtrusion } from './extrude.js';

export interface BlockMeshOptions {
  /** Base plate thickness, in the same metres as the rest of the scene. */
  baseThicknessM?: number;
  /** Margin added around the buildings' extent when sizing the base plate. */
  marginM?: number;
}

const DEFAULT_OPTIONS: Required<BlockMeshOptions> = {
  baseThicknessM: 3,
  marginM: 5,
};

/** Pastel monochrome for every building not singled out, and for the plate. */
const BASE_COLOR = 0xf1ece1;
/** Contrast accent for the one building the user is calling out. */
const HIGHLIGHT_COLOR = 0xc1502e;

export interface BlockMeshResult {
  /** Everything together, coloured, for the on-screen preview. */
  preview: Object3D;
  /** The singled-out building alone — its own STL export, its own print colour. */
  highlighted: Object3D | null;
  /** The base plate plus every other building — the second STL export. */
  rest: Object3D;
  widthMeters: number;
  depthMeters: number;
  /** Footprints that failed to extrude (self-intersecting, degenerate, etc.). */
  skipped: BuildingFootprint[];
}

function sameRef(a: OsmRef, b: OsmRef): boolean {
  return a.type === b.type && a.id === b.id;
}

function baseMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: BASE_COLOR, roughness: 0.9, metalness: 0 });
}

function highlightMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: HIGHLIGHT_COLOR, roughness: 0.7, metalness: 0.05 });
}

/** Bounding extent, in the shared frame's XZ plane (Three's east/south axes), of a set of footprints. */
function extentOf(footprints: BuildingFootprint[], frame: EnuFrame) {
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;

  for (const footprint of footprints) {
    for (const ring of footprint.polygon.coordinates) {
      for (const coord of openRing(ring)) {
        const [e, n] = frame.lonLatToEnu2d(coord);
        if (e < minE) minE = e;
        if (e > maxE) maxE = e;
        if (n < minN) minN = n;
        if (n > maxN) maxN = n;
      }
    }
  }

  if (!Number.isFinite(minE)) return { width: 20, depth: 20 };
  return { width: maxE - minE, depth: maxN - minN };
}

export function buildBlockMesh(
  footprints: BuildingFootprint[],
  center: LonLatAlt,
  highlightRef: OsmRef | null,
  options: BlockMeshOptions = {},
): BlockMeshResult {
  const { baseThicknessM, marginM } = { ...DEFAULT_OPTIONS, ...options };
  const frame = new EnuFrame(center);

  const { width, depth } = extentOf(footprints, frame);
  const widthMeters = width + marginM * 2;
  const depthMeters = depth + marginM * 2;

  const baseMat = baseMaterial();
  const highlightMat = highlightMaterial();

  const baseGeometry = new BoxGeometry(widthMeters, baseThicknessM, depthMeters);
  const base = new Mesh(baseGeometry, baseMat);
  base.name = 'base-plate';
  base.position.set(0, -baseThicknessM / 2, 0);

  const rest = new Group();
  rest.name = 'block-rest';
  rest.add(base);

  let highlighted: Group | null = null;
  const skipped: BuildingFootprint[] = [];

  for (const footprint of footprints) {
    let geometry: BufferGeometry;
    try {
      geometry = buildExtrusion(footprint, frame).geometry;
    } catch {
      skipped.push(footprint);
      continue;
    }

    const isHighlighted = highlightRef !== null && sameRef(footprint.osm, highlightRef);
    const mesh = new Mesh(geometry, isHighlighted ? highlightMat : baseMat);
    mesh.name = `${footprint.osm.type}/${footprint.osm.id}`;

    if (isHighlighted) {
      highlighted ??= new Group();
      highlighted.name = 'block-highlight';
      highlighted.add(mesh);
    } else {
      rest.add(mesh);
    }
  }

  const preview = new Group();
  preview.name = 'block-preview';
  preview.add(rest.clone(true));
  if (highlighted) preview.add(highlighted.clone(true));

  return { preview, highlighted, rest, widthMeters, depthMeters, skipped };
}
