import { describe, expect, it } from 'vitest';
import {
  EnuFrame,
  WGS84_A,
  bboxAroundPoint,
  ecefToGeodetic,
  geodeticToEcef,
  openRing,
  ringCentroid,
  signedArea,
} from './geo.js';

describe('geodeticToEcef', () => {
  it('places 0,0 on the +X axis at the equatorial radius', () => {
    const [x, y, z] = geodeticToEcef({ lon: 0, lat: 0, alt: 0 });
    expect(x).toBeCloseTo(WGS84_A, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('places the north pole on the +Z axis at the polar radius', () => {
    const [x, y, z] = geodeticToEcef({ lon: 0, lat: 90, alt: 0 });
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(6356752.314245, 5);
  });
});

describe('ecefToGeodetic', () => {
  const samples = [
    { lon: 0, lat: 0, alt: 0 },
    { lon: -122.4194, lat: 37.7749, alt: 12.5 },
    { lon: 139.6917, lat: 35.6895, alt: 0 },
    { lon: 18.0686, lat: 59.3293, alt: 300 },
    { lon: -68.13, lat: -78.5, alt: 2500 },
    { lon: 179.9, lat: 71.2, alt: -30 },
  ];

  it('round-trips through ECEF to sub-millimetre precision', () => {
    for (const sample of samples) {
      const back = ecefToGeodetic(geodeticToEcef(sample));
      expect(back.lon).toBeCloseTo(sample.lon, 9);
      expect(back.lat).toBeCloseTo(sample.lat, 9);
      expect(back.alt).toBeCloseTo(sample.alt, 6);
    }
  });
});

describe('EnuFrame', () => {
  const origin = { lon: -122.4194, lat: 37.7749, alt: 0 };

  it('maps the origin to (0,0,0)', () => {
    const frame = new EnuFrame(origin);
    const [e, n, u] = frame.toEnu(origin);
    expect(e).toBeCloseTo(0, 9);
    expect(n).toBeCloseTo(0, 9);
    expect(u).toBeCloseTo(0, 9);
  });

  it('puts increasing longitude east and increasing latitude north', () => {
    const frame = new EnuFrame(origin);
    const east = frame.toEnu({ ...origin, lon: origin.lon + 0.001 });
    const north = frame.toEnu({ ...origin, lat: origin.lat + 0.001 });

    expect(east[0]).toBeGreaterThan(0);
    expect(Math.abs(east[1])).toBeLessThan(1e-3);
    expect(north[1]).toBeGreaterThan(0);
    expect(Math.abs(north[0])).toBeLessThan(1e-9);
  });

  it('measures a 0.001 degree latitude step as ~111 metres', () => {
    const frame = new EnuFrame(origin);
    const north = frame.toEnu({ ...origin, lat: origin.lat + 0.001 });
    expect(north[1]).toBeGreaterThan(110);
    expect(north[1]).toBeLessThan(112);
  });

  it('maps altitude straight to up', () => {
    const frame = new EnuFrame(origin);
    const up = frame.toEnu({ ...origin, alt: 50 });
    expect(up[2]).toBeCloseTo(50, 6);
  });

  it('round-trips ENU back to geodetic', () => {
    const frame = new EnuFrame(origin);
    const target = { lon: -122.4181, lat: 37.7761, alt: 42 };
    const back = frame.toGeodetic(frame.toEnu(target));
    expect(back.lon).toBeCloseTo(target.lon, 9);
    expect(back.lat).toBeCloseTo(target.lat, 9);
    expect(back.alt).toBeCloseTo(target.alt, 6);
  });

  it('stays accurate at high latitude where flat approximations drift', () => {
    const arctic = new EnuFrame({ lon: 15.6, lat: 78.22, alt: 0 });
    const target = { lon: 15.61, lat: 78.221, alt: 0 };
    const back = arctic.toGeodetic(arctic.toEnu(target));
    expect(back.lon).toBeCloseTo(target.lon, 9);
    expect(back.lat).toBeCloseTo(target.lat, 9);
  });
});

describe('ring helpers', () => {
  const ccw: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it('reports positive signed area for counter-clockwise rings', () => {
    expect(signedArea(ccw)).toBeCloseTo(100, 9);
    expect(signedArea([...ccw].reverse())).toBeCloseTo(-100, 9);
  });

  it('finds the centroid of a square', () => {
    const [cx, cy] = ringCentroid(ccw);
    expect(cx).toBeCloseTo(5, 9);
    expect(cy).toBeCloseTo(5, 9);
  });

  it('falls back to the vertex mean for degenerate rings', () => {
    const [cx, cy] = ringCentroid([
      [0, 0],
      [4, 0],
      [8, 0],
    ]);
    expect(cx).toBeCloseTo(4, 9);
    expect(cy).toBeCloseTo(0, 9);
  });

  it('stays precise on raw lon/lat, where coordinates dwarf the ring size', () => {
    // A ~20m building footprint in degrees: differences are ~1e-4 against
    // ~1e2-magnitude coordinates, which destroys a naive shoelace sum.
    const footprint: Array<[number, number]> = [
      [-122.4194, 37.7749],
      [-122.4192, 37.7749],
      [-122.4192, 37.7751],
      [-122.4194, 37.7751],
    ];
    const [cx, cy] = ringCentroid(footprint);
    expect(cx).toBeCloseTo(-122.4193, 9);
    expect(cy).toBeCloseTo(37.775, 9);

    // And the centroid must actually lie inside the ring's bounding box.
    expect(cx).toBeGreaterThan(-122.4194);
    expect(cx).toBeLessThan(-122.4192);
    expect(signedArea(footprint)).toBeGreaterThan(0);
  });

  it('drops a duplicated closing vertex', () => {
    expect(openRing([[0, 0] as const, [1, 0] as const, [0, 0] as const])).toHaveLength(2);
    expect(openRing([[0, 0] as const, [1, 0] as const])).toHaveLength(2);
  });
});

describe('bboxAroundPoint', () => {
  it('produces a box whose corners are the requested distance from the centre', () => {
    const center = { lon: -122.4194, lat: 37.7749, alt: 0 };
    const bbox = bboxAroundPoint(center, 100);
    const frame = new EnuFrame(center);

    const sw = frame.toEnu({ lon: bbox.west, lat: bbox.south, alt: 0 });
    const ne = frame.toEnu({ lon: bbox.east, lat: bbox.north, alt: 0 });

    expect(sw[0]).toBeCloseTo(-100, 3);
    expect(sw[1]).toBeCloseTo(-100, 3);
    expect(ne[0]).toBeCloseTo(100, 3);
    expect(ne[1]).toBeCloseTo(100, 3);
  });

  it('stays centred on the point even at high latitude', () => {
    const center = { lon: 18.0686, lat: 59.3293, alt: 0 };
    const bbox = bboxAroundPoint(center, 250);
    expect(bbox.west).toBeLessThan(center.lon);
    expect(bbox.east).toBeGreaterThan(center.lon);
    expect(bbox.south).toBeLessThan(center.lat);
    expect(bbox.north).toBeGreaterThan(center.lat);
  });
});
