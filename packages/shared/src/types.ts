/**
 * Shared DTOs exchanged between the web client and the API server.
 *
 * These types are the contract for the whole extract -> edit -> place pipeline,
 * so they are deliberately transport-only: plain JSON, no Three.js or Cesium
 * classes leak across the boundary.
 */

/** A single [longitude, latitude] pair in WGS84 degrees. */
export type LonLat = [number, number];

/** Geographic position with an ellipsoid height in metres. */
export interface LonLatAlt {
  lon: number;
  lat: number;
  alt: number;
}

/** The OSM element a building tile feature came from. */
export interface OsmRef {
  /** OSM element id, e.g. 24950831. */
  id: number;
  /** OSM element kind. Cesium OSM Buildings only ever emits ways and relations. */
  type: 'way' | 'relation';
}

/**
 * GeoJSON-shaped polygon ring set. First ring is the outer boundary, any
 * further rings are holes (courtyards). Rings are closed (first === last).
 */
export interface FootprintPolygon {
  type: 'Polygon';
  coordinates: LonLat[][];
}

/** Footprint plus the height data needed to extrude it. */
export interface BuildingFootprint {
  osm: OsmRef;
  polygon: FootprintPolygon;
  /**
   * Height in metres. Resolved from, in priority order: the tile feature's
   * `cesium#estimatedHeight`, OSM `height`, or `building:levels` * 3.
   */
  heightMeters: number;
  /** Height of the base above ground, from OSM `min_height`. Usually 0. */
  minHeightMeters: number;
  /** Raw OSM tags, kept for attribution and for the metadata panel. */
  tags: Record<string, string>;
  /** Where the footprint sits, used to centre the local ENU frame. */
  origin: LonLatAlt;
}

/** How the footprint's height was determined — surfaced in the UI. */
export type HeightSource =
  | 'tile-feature'
  | 'osm-height'
  | 'osm-building-levels'
  | 'default';

export interface FootprintResponse {
  footprint: BuildingFootprint;
  heightSource: HeightSource;
  /** ODbL attribution string that must be displayed alongside the data. */
  attribution: string;
}

// --- Edit operations -------------------------------------------------------

/**
 * A half-space cut, expressed in the mesh's *local* (untransformed) space so
 * that it replays identically no matter what scale/rotation is applied
 * afterwards. Geometry on the positive side of the plane is removed.
 */
export interface CutOperation {
  type: 'cut';
  /** Unit normal of the cutting plane, local space. */
  normal: [number, number, number];
  /** Plane constant: the plane is { p : dot(normal, p) + constant = 0 }. */
  constant: number;
}

export type EditOperation = CutOperation;

/** Rigid + scale transform applied to the edited mesh, local space. */
export interface MeshTransform {
  scale: [number, number, number];
  /** Rotation as a quaternion (x, y, z, w) to avoid gimbal-lock in storage. */
  quaternion: [number, number, number, number];
}

/** Full editable state of a model: replayable from the raw extraction. */
export interface EditState {
  transform: MeshTransform;
  operations: EditOperation[];
}

// --- Persistence DTOs ------------------------------------------------------

export interface Extraction {
  id: string;
  userId: string | null;
  osm: OsmRef;
  footprint: FootprintPolygon;
  heightMeters: number;
  minHeightMeters: number;
  origin: LonLatAlt;
  tags: Record<string, string>;
  rawMeshUrl: string | null;
  createdAt: string;
}

export interface Placement {
  position: LonLatAlt;
  /** Degrees clockwise from north, applied about the local up axis. */
  headingDeg: number;
  /** When true `position.alt` is relative to terrain rather than the ellipsoid. */
  clampToTerrain: boolean;
}

export interface EditedModel {
  id: string;
  extractionId: string;
  userId: string | null;
  editedMeshUrl: string | null;
  editState: EditState;
  placement: Placement;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExtractionRequest {
  osm: OsmRef;
  footprint: FootprintPolygon;
  heightMeters: number;
  minHeightMeters: number;
  origin: LonLatAlt;
  tags: Record<string, string>;
}

export interface CreateEditedModelRequest {
  extractionId: string;
  name: string;
  editState: EditState;
  placement: Placement;
}

export const DEFAULT_BUILDING_HEIGHT_M = 10;
export const DEFAULT_METERS_PER_LEVEL = 3;

export const OSM_ATTRIBUTION =
  '© OpenStreetMap contributors, ODbL. Building data via Cesium OSM Buildings.';
