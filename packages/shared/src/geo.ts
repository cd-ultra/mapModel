/**
 * WGS84 geodetic <-> ECEF <-> local ENU conversions.
 *
 * The extraction pipeline needs to turn a lon/lat footprint into flat metres so
 * it can be triangulated and extruded, and the placement pipeline needs to undo
 * that. Both client and server use these functions so a footprint measured in
 * the browser matches one validated on the server to the millimetre.
 *
 * A naive `metresPerDegree` approximation is accurate enough at building scale,
 * but it accumulates error at high latitudes and gives no exact inverse, so we
 * do the real ellipsoidal transform instead — it is only a few more lines.
 */

import type { LonLat, LonLatAlt } from './types.js';

/** WGS84 semi-major axis, metres. */
export const WGS84_A = 6378137.0;
/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257223563;
/** First eccentricity squared. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function degToRad(d: number): number {
  return d * DEG;
}

export function radToDeg(r: number): number {
  return r * RAD;
}

/** Geodetic (degrees, metres) -> earth-centred earth-fixed metres. */
export function geodeticToEcef(pos: LonLatAlt): Vec3 {
  const lon = degToRad(pos.lon);
  const lat = degToRad(pos.lat);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  // Radius of curvature in the prime vertical.
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  return [
    (n + pos.alt) * cosLat * cosLon,
    (n + pos.alt) * cosLat * sinLon,
    (n * (1 - WGS84_E2) + pos.alt) * sinLat,
  ];
}

/**
 * ECEF -> geodetic using Bowring's closed-form method, which converges to
 * sub-millimetre accuracy in a single iteration for terrestrial altitudes.
 */
export function ecefToGeodetic(ecef: Vec3): LonLatAlt {
  const [x, y, z] = ecef;
  const b = WGS84_A * (1 - WGS84_F);
  const ep2 = (WGS84_A * WGS84_A - b * b) / (b * b);
  const p = Math.hypot(x, y);

  if (p < 1e-9) {
    // On the polar axis: longitude is undefined, pick 0.
    const sign = z >= 0 ? 1 : -1;
    return { lon: 0, lat: sign * 90, alt: Math.abs(z) - b };
  }

  const theta = Math.atan2(z * WGS84_A, p * b);
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);

  const lat = Math.atan2(
    z + ep2 * b * sinTheta * sinTheta * sinTheta,
    p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta,
  );
  const lon = Math.atan2(y, x);

  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const alt = p / Math.cos(lat) - n;

  return { lon: radToDeg(lon), lat: radToDeg(lat), alt };
}

/**
 * A local east-north-up tangent frame anchored at a geodetic origin.
 *
 * Caching the origin's trig terms matters: converting a footprint means running
 * the same transform over every vertex, and this is on the interactive path.
 */
export class EnuFrame {
  readonly origin: LonLatAlt;
  private readonly originEcef: Vec3;
  private readonly sinLon: number;
  private readonly cosLon: number;
  private readonly sinLat: number;
  private readonly cosLat: number;

  constructor(origin: LonLatAlt) {
    this.origin = origin;
    this.originEcef = geodeticToEcef(origin);
    const lon = degToRad(origin.lon);
    const lat = degToRad(origin.lat);
    this.sinLon = Math.sin(lon);
    this.cosLon = Math.cos(lon);
    this.sinLat = Math.sin(lat);
    this.cosLat = Math.cos(lat);
  }

  /** Geodetic -> local ENU metres. */
  toEnu(pos: LonLatAlt): Vec3 {
    const [x, y, z] = geodeticToEcef(pos);
    const dx = x - this.originEcef[0];
    const dy = y - this.originEcef[1];
    const dz = z - this.originEcef[2];
    return [
      -this.sinLon * dx + this.cosLon * dy,
      -this.sinLat * this.cosLon * dx - this.sinLat * this.sinLon * dy + this.cosLat * dz,
      this.cosLat * this.cosLon * dx + this.cosLat * this.sinLon * dy + this.sinLat * dz,
    ];
  }

  /** Local ENU metres -> geodetic. */
  toGeodetic(enu: Vec3): LonLatAlt {
    const [e, n, u] = enu;
    const dx =
      -this.sinLon * e - this.sinLat * this.cosLon * n + this.cosLat * this.cosLon * u;
    const dy =
      this.cosLon * e - this.sinLat * this.sinLon * n + this.cosLat * this.sinLon * u;
    const dz = this.cosLat * n + this.sinLat * u;
    return ecefToGeodetic([
      this.originEcef[0] + dx,
      this.originEcef[1] + dy,
      this.originEcef[2] + dz,
    ]);
  }

  /** Convenience for footprint rings, which carry no altitude of their own. */
  lonLatToEnu2d(coord: LonLat): [number, number] {
    const [e, n] = this.toEnu({ lon: coord[0], lat: coord[1], alt: this.origin.alt });
    return [e, n];
  }
}

/**
 * Signed area of a closed ring in a planar coordinate system (shoelace).
 * Positive means counter-clockwise. Used to normalise ring winding before
 * triangulation so roof normals always point up.
 *
 * Vertices are shifted to the first vertex before summing. Shoelace on raw
 * lon/lat otherwise multiplies ~1e2-magnitude coordinates by ~1e-4 differences
 * and loses most of its significant digits to cancellation.
 */
export function signedArea(ring: ReadonlyArray<readonly [number, number]>): number {
  if (ring.length < 3) return 0;
  const ox = ring[0]![0];
  const oy = ring[0]![1];

  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j]![0] - ox;
    const ay = ring[j]![1] - oy;
    const bx = ring[i]![0] - ox;
    const by = ring[i]![1] - oy;
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

/**
 * Area-weighted centroid of a closed planar ring, falling back to the vertex
 * mean for degenerate (zero-area) rings so we never emit NaN.
 *
 * Like `signedArea`, this accumulates in a frame local to the first vertex.
 * Doing it in absolute lon/lat degrees loses so much precision that the
 * returned centroid can land outside the ring entirely.
 */
export function ringCentroid(
  ring: ReadonlyArray<readonly [number, number]>,
): [number, number] {
  const count = ring.length;
  if (count === 0) return [0, 0];

  const ox = ring[0]![0];
  const oy = ring[0]![1];

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const ax = ring[j]![0] - ox;
    const ay = ring[j]![1] - oy;
    const bx = ring[i]![0] - ox;
    const by = ring[i]![1] - oy;
    const cross = ax * by - bx * ay;
    twiceArea += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }

  if (Math.abs(twiceArea) < 1e-20) {
    let sx = 0;
    let sy = 0;
    for (const p of ring) {
      sx += p[0] - ox;
      sy += p[1] - oy;
    }
    return [ox + sx / count, oy + sy / count];
  }

  const factor = 1 / (3 * twiceArea);
  return [ox + cx * factor, oy + cy * factor];
}

/** Drop a ring's duplicated closing vertex, if present. */
export function openRing<T extends readonly [number, number]>(ring: readonly T[]): T[] {
  if (ring.length < 2) return [...ring];
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  const closed =
    Math.abs(first[0] - last[0]) < 1e-12 && Math.abs(first[1] - last[1]) < 1e-12;
  return closed ? ring.slice(0, -1) : [...ring];
}
