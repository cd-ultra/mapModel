/**
 * Georeferencing an edited mesh back onto the globe.
 *
 * ## Why there is no fix-up rotation here
 *
 * The extruded mesh is authored X=east, Y=up, Z=south (see `mesh/extrude.ts`).
 * Cesium loads glTF with `upAxis = Axis.Y` and `forwardAxis = Axis.X` by
 * default, which applies `Axis.Y_UP_TO_Z_UP` and nothing else. That matrix maps
 *
 *   (x, y, z) -> (x, -z, y)
 *
 * so our (east, up, south) becomes (east, north, up) — exactly the axes of
 * `Transforms.eastNorthUpToFixedFrame`. The model matrix is therefore just the
 * ENU frame times the heading spin, with no corrective rotation.
 *
 * `placement.test.ts` asserts this end to end against real Cesium, so if a
 * future Cesium release changes the default axes the test fails rather than the
 * buildings silently ending up on their sides.
 */

import {
  Cartesian3,
  Ellipsoid,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  Transforms,
  type Scene,
} from 'cesium';
import type { LonLatAlt, Placement } from '@gme/shared';

/**
 * ENU -> ECEF for a placement, including heading.
 *
 * Heading is degrees clockwise from north about the local up axis, matching
 * every compass the user has ever seen. A counter-clockwise rotation about +Z
 * (up) by `heading` turns north towards west, so the sign is negated.
 */
export function buildModelMatrix(placement: Placement, result = new Matrix4()): Matrix4 {
  const position = Cartesian3.fromDegrees(
    placement.position.lon,
    placement.position.lat,
    placement.position.alt,
  );

  const enu = Transforms.eastNorthUpToFixedFrame(position, Ellipsoid.WGS84, result);

  if (!placement.headingDeg) return enu;

  const spin = Matrix4.fromRotationTranslation(
    Matrix3.fromRotationZ(-CesiumMath.toRadians(placement.headingDeg), new Matrix3()),
    Cartesian3.ZERO,
    new Matrix4(),
  );
  return Matrix4.multiplyTransformation(enu, spin, result);
}

/**
 * The full local-glTF-space -> ECEF transform, i.e. what Cesium will actually
 * do to each vertex. Used by tests and by the placement preview readout; the
 * renderer composes these two itself at draw time.
 */
export function buildFullTransform(placement: Placement): Matrix4 {
  // Axis.Y_UP_TO_Z_UP, written out so the test does not simply restate the
  // constant it is meant to be checking.
  const yUpToZUp = Matrix4.fromRotationTranslation(
    new Matrix3(1, 0, 0, 0, 0, -1, 0, 1, 0),
    Cartesian3.ZERO,
    new Matrix4(),
  );
  return Matrix4.multiplyTransformation(
    buildModelMatrix(placement),
    yUpToZUp,
    new Matrix4(),
  );
}

/** Convert a point in the mesh's local Three.js space to ECEF for a placement. */
export function localToEcef(
  placement: Placement,
  local: { x: number; y: number; z: number },
): Cartesian3 {
  return Matrix4.multiplyByPoint(
    buildFullTransform(placement),
    new Cartesian3(local.x, local.y, local.z),
    new Cartesian3(),
  );
}

export function cartesianToLonLatAlt(position: Cartesian3): LonLatAlt {
  const carto = Ellipsoid.WGS84.cartesianToCartographic(position);
  return {
    lon: CesiumMath.toDegrees(carto.longitude),
    lat: CesiumMath.toDegrees(carto.latitude),
    alt: carto.height,
  };
}

/**
 * Turn a screen click into a ground position.
 *
 * `scene.pickPosition` is preferred because it respects whatever is actually
 * drawn — terrain, buildings, a previously placed model — but it needs a depth
 * buffer sample and returns undefined when the click misses geometry or when
 * depth picking is unsupported. `globe.pick` against the ray is the fallback,
 * and it is also what gives a sane answer when the user clicks open ocean.
 */
export function pickGroundPosition(
  scene: Scene,
  windowPosition: { x: number; y: number },
): LonLatAlt | null {
  if (scene.pickPositionSupported) {
    const picked = scene.pickPosition(windowPosition as never);
    if (picked && Number.isFinite(picked.x)) {
      return cartesianToLonLatAlt(picked);
    }
  }

  const ray = scene.camera.getPickRay(windowPosition as never);
  if (!ray) return null;

  const onGlobe = scene.globe.pick(ray, scene);
  return onGlobe ? cartesianToLonLatAlt(onGlobe) : null;
}

/**
 * Height of the terrain under a position, so a building can be dropped onto the
 * ground rather than floating at ellipsoid height. Returns the input altitude
 * unchanged when terrain is not yet loaded at that location.
 */
export function clampAltitudeToTerrain(scene: Scene, position: LonLatAlt): LonLatAlt {
  const carto = Ellipsoid.WGS84.cartesianToCartographic(
    Cartesian3.fromDegrees(position.lon, position.lat, 0),
  );
  const height = scene.globe.getHeight(carto);
  return typeof height === 'number' && Number.isFinite(height)
    ? { ...position, alt: height + position.alt }
    : position;
}
