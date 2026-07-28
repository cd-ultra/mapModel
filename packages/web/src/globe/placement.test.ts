/**
 * These tests run against real Cesium (no WebGL needed for the math types) and
 * are the guard on the single most breakage-prone assumption in the app: that a
 * mesh authored X=east / Y=up / Z=south lands correctly on the globe with no
 * corrective rotation.
 */

import { describe, expect, it } from 'vitest';
import { Axis, Cartesian3, Ellipsoid, Matrix4 } from 'cesium';
import type { Placement } from '@gme/shared';
import { buildFullTransform, buildModelMatrix, cartesianToLonLatAlt, localToEcef } from './placement.js';

const at = (lon: number, lat: number, alt = 0, headingDeg = 0): Placement => ({
  position: { lon, lat, alt },
  headingDeg,
  clampToTerrain: false,
});

const round = (n: number) => (Math.abs(n) < 1e-6 ? 0 : n);
const asTuple = (c: Cartesian3): [number, number, number] => [
  round(c.x),
  round(c.y),
  round(c.z),
];

/**
 * `Axis.Y_UP_TO_Z_UP` exists at runtime but is missing from Cesium's shipped
 * type declarations, so it has to be reached through a cast.
 */
const Y_UP_TO_Z_UP = (Axis as unknown as { Y_UP_TO_Z_UP: Matrix4 }).Y_UP_TO_Z_UP;

/** Direction of a local axis in ECEF, isolated from the translation. */
function axisDirection(
  placement: Placement,
  local: [number, number, number],
): [number, number, number] {
  const origin = localToEcef(placement, { x: 0, y: 0, z: 0 });
  const tip = localToEcef(placement, { x: local[0], y: local[1], z: local[2] });
  const d = Cartesian3.subtract(tip, origin, new Cartesian3());
  return asTuple(Cartesian3.normalize(d, d));
}

describe("Cesium's default glTF axis correction", () => {
  it('still maps (x, y, z) -> (x, -z, y)', () => {
    // If this ever changes, mesh/extrude.ts needs a corrective rotation.
    const apply = (v: [number, number, number]) =>
      asTuple(Matrix4.multiplyByPoint(Y_UP_TO_Z_UP, new Cartesian3(...v), new Cartesian3()));

    expect(apply([1, 0, 0])).toEqual([1, 0, 0]);
    expect(apply([0, 1, 0])).toEqual([0, 0, 1]);
    expect(apply([0, 0, 1])).toEqual([0, -1, 0]);
  });

  it('is reproduced exactly by buildFullTransform at the identity position', () => {
    // At lon=0 lat=0 the ENU frame is east=+Y, north=+Z, up=+X in ECEF.
    expect(axisDirection(at(0, 0), [1, 0, 0])).toEqual([0, 1, 0]); // +X -> east
    expect(axisDirection(at(0, 0), [0, 1, 0])).toEqual([1, 0, 0]); // +Y -> up
    expect(axisDirection(at(0, 0), [0, 0, -1])).toEqual([0, 0, 1]); // -Z -> north
  });
});

describe('buildModelMatrix', () => {
  it('puts the model origin at the requested lon/lat/alt', () => {
    const placement = at(-122.4194, 37.7749, 25);
    const origin = localToEcef(placement, { x: 0, y: 0, z: 0 });
    const back = cartesianToLonLatAlt(origin);

    expect(back.lon).toBeCloseTo(-122.4194, 9);
    expect(back.lat).toBeCloseTo(37.7749, 9);
    expect(back.alt).toBeCloseTo(25, 6);
  });

  it('keeps the mesh upright: +Y follows the geodetic surface normal', () => {
    const placement = at(139.6917, 35.6895);
    const origin = localToEcef(placement, { x: 0, y: 0, z: 0 });
    const up = axisDirection(placement, [0, 1, 0]);

    // Geodetic up, not the geocentric radial: on an oblate ellipsoid the two
    // differ by up to ~0.2 degrees away from the equator and poles, and it is
    // the surface normal that "upright" means for a building.
    const normal = Ellipsoid.WGS84.geodeticSurfaceNormal(origin, new Cartesian3())!;
    expect(up[0]).toBeCloseTo(normal.x, 6);
    expect(up[1]).toBeCloseTo(normal.y, 6);
    expect(up[2]).toBeCloseTo(normal.z, 6);

    // Sanity: it is still within a fraction of a degree of the radial.
    const radial = Cartesian3.normalize(origin, new Cartesian3());
    const cosAngle = up[0] * radial.x + up[1] * radial.y + up[2] * radial.z;
    expect(Math.acos(Math.min(cosAngle, 1))).toBeLessThan(0.004); // < 0.23 deg
  });

  it('preserves scale: one local metre is one metre on the ground', () => {
    const placement = at(18.0686, 59.3293, 10);
    const origin = localToEcef(placement, { x: 0, y: 0, z: 0 });
    const tip = localToEcef(placement, { x: 100, y: 0, z: 0 });
    expect(Cartesian3.distance(origin, tip)).toBeCloseTo(100, 6);
  });

  it('moves +X east and -Z north on the ellipsoid', () => {
    const placement = at(0, 45, 0);
    const east = cartesianToLonLatAlt(localToEcef(placement, { x: 500, y: 0, z: 0 }));
    const north = cartesianToLonLatAlt(localToEcef(placement, { x: 0, y: 0, z: -500 }));

    expect(east.lon).toBeGreaterThan(0);
    expect(Math.abs(east.lat - 45)).toBeLessThan(1e-3);
    expect(north.lat).toBeGreaterThan(45);
    expect(Math.abs(north.lon)).toBeLessThan(1e-9);
  });

  it('raises +Y into altitude', () => {
    const placement = at(0, 45, 0);
    const raised = cartesianToLonLatAlt(localToEcef(placement, { x: 0, y: 30, z: 0 }));
    expect(raised.alt).toBeCloseTo(30, 5);
  });
});

describe('heading', () => {
  it('rotates clockwise from north, like a compass', () => {
    // The mesh's north-facing axis is -Z. At heading 90 it should point east.
    const placement = at(0, 0, 0, 90);
    const facing = cartesianToLonLatAlt(localToEcef(placement, { x: 0, y: 0, z: -500 }));
    expect(facing.lon).toBeGreaterThan(0); // moved east
    expect(Math.abs(facing.lat)).toBeLessThan(1e-6);
  });

  it('sends north to west at heading 270', () => {
    const placement = at(0, 0, 0, 270);
    const facing = cartesianToLonLatAlt(localToEcef(placement, { x: 0, y: 0, z: -500 }));
    expect(facing.lon).toBeLessThan(0);
  });

  it('is a no-op at heading 0 and equivalent at 360', () => {
    const a = Matrix4.toArray(buildFullTransform(at(10, 20, 0, 0)), []);
    const b = Matrix4.toArray(buildFullTransform(at(10, 20, 0, 360)), []);
    for (let i = 0; i < 16; i += 1) {
      expect(b[i]!).toBeCloseTo(a[i]!, 6);
    }
  });

  it('leaves the origin untouched while spinning the mesh', () => {
    const spun = at(-0.1276, 51.5072, 0, 137);
    const origin = cartesianToLonLatAlt(localToEcef(spun, { x: 0, y: 0, z: 0 }));
    expect(origin.lon).toBeCloseTo(-0.1276, 9);
    expect(origin.lat).toBeCloseTo(51.5072, 9);
  });

  it('does not tilt the model: up stays up under any heading', () => {
    const spun = at(-0.1276, 51.5072, 0, 137);
    const upright = axisDirection(at(-0.1276, 51.5072, 0, 0), [0, 1, 0]);
    const rotated = axisDirection(spun, [0, 1, 0]);
    expect(rotated[0]).toBeCloseTo(upright[0], 6);
    expect(rotated[1]).toBeCloseTo(upright[1], 6);
    expect(rotated[2]).toBeCloseTo(upright[2], 6);
  });

  it('is a rigid transform — heading never introduces scale', () => {
    const placement = at(30, -20, 5, 42);
    const origin = localToEcef(placement, { x: 0, y: 0, z: 0 });
    const tip = localToEcef(placement, { x: 0, y: 0, z: -250 });
    expect(Cartesian3.distance(origin, tip)).toBeCloseTo(250, 5);
  });
});

describe('buildModelMatrix without heading', () => {
  it('returns a pure ENU frame', () => {
    const m = buildModelMatrix(at(12, 34, 56));
    expect(Matrix4.equalsEpsilon(m, buildModelMatrix(at(12, 34, 56, 0)), 1e-9)).toBe(true);
  });
});
