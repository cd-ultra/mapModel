import { describe, expect, it } from 'vitest';
import {
  OverpassParseError,
  buildOverpassBboxQuery,
  buildOverpassQuery,
  parseOverpassAreaFootprints,
  parseOverpassFootprint,
  stitchRings,
} from './overpass.js';
import { openRing, signedArea, EnuFrame } from './geo.js';
import type { LonLat, OsmRef } from './types.js';

const WAY: OsmRef = { id: 24950831, type: 'way' };
const REL: OsmRef = { id: 555, type: 'relation' };

/** A 20m x 20m square near San Francisco, expressed in degrees. */
const SQUARE = [
  { lon: -122.4194, lat: 37.7749 },
  { lon: -122.4192, lat: 37.7749 },
  { lon: -122.4192, lat: 37.7751 },
  { lon: -122.4194, lat: 37.7751 },
  { lon: -122.4194, lat: 37.7749 },
];

describe('buildOverpassQuery', () => {
  it('builds a way query with inline geometry', () => {
    expect(buildOverpassQuery(WAY)).toBe(
      '[out:json][timeout:25];way(24950831);out geom tags;',
    );
  });

  it('builds a relation query that recurses down for member geometry', () => {
    // A bare `relation(id); out geom;` prints each member's type/ref/role but
    // not its coordinates — Overpass only fills in geometry for elements
    // already pulled into the query's working set. `(._;>;)` adds the
    // relation's members (and their nodes) to that set.
    expect(buildOverpassQuery(REL)).toBe(
      '[out:json][timeout:25];relation(555);(._;>;);out geom tags;',
    );
  });

  it('rejects ids that would produce a malformed query', () => {
    expect(() => buildOverpassQuery({ id: -1, type: 'way' })).toThrow();
    expect(() => buildOverpassQuery({ id: 1.5, type: 'way' })).toThrow();
  });
});

describe('stitchRings', () => {
  const a: LonLat[] = [
    [0, 0],
    [1, 0],
  ];
  const b: LonLat[] = [
    [1, 0],
    [1, 1],
  ];
  const c: LonLat[] = [
    [1, 1],
    [0, 1],
  ];
  const d: LonLat[] = [
    [0, 1],
    [0, 0],
  ];

  it('joins segments given in order', () => {
    const rings = stitchRings([a, b, c, d]);
    expect(rings).toHaveLength(1);
    expect(openRing(rings[0]!)).toHaveLength(4);
  });

  it('joins segments given out of order', () => {
    const rings = stitchRings([c, a, d, b]);
    expect(rings).toHaveLength(1);
    expect(openRing(rings[0]!)).toHaveLength(4);
  });

  it('reverses segments whose direction is flipped', () => {
    const flipped: LonLat[] = [...b].reverse() as LonLat[];
    const rings = stitchRings([a, flipped, c, d]);
    expect(rings).toHaveLength(1);
    expect(openRing(rings[0]!)).toHaveLength(4);
  });

  it('passes through already-closed ways untouched', () => {
    const closed: LonLat[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ];
    expect(stitchRings([closed])).toHaveLength(1);
  });

  it('separates two independent rings', () => {
    const far: LonLat[][] = [
      [
        [10, 10],
        [11, 10],
      ],
      [
        [11, 10],
        [10, 10],
      ],
    ];
    // Two segments forming a degenerate sliver plus the real square.
    const rings = stitchRings([a, b, c, d, ...far]);
    expect(rings.length).toBeGreaterThanOrEqual(1);
    expect(rings.some((r) => openRing(r).length === 4)).toBe(true);
  });

  it('drops segments that never close instead of throwing', () => {
    expect(stitchRings([a, b])).toHaveLength(0);
  });
});

describe('parseOverpassFootprint', () => {
  it('parses a simple closed way', () => {
    const result = parseOverpassFootprint(
      {
        elements: [
          { type: 'way', id: WAY.id, tags: { building: 'yes', height: '30' }, geometry: SQUARE },
        ],
      },
      WAY,
    );

    expect(result.footprint.polygon.coordinates).toHaveLength(1);
    expect(result.footprint.heightMeters).toBeCloseTo(30);
    expect(result.heightSource).toBe('osm-height');
    expect(result.footprint.tags['building']).toBe('yes');
    expect(result.attribution).toContain('OpenStreetMap');
  });

  it('anchors the origin at the footprint centroid', () => {
    const result = parseOverpassFootprint(
      { elements: [{ type: 'way', id: WAY.id, geometry: SQUARE }] },
      WAY,
    );
    expect(result.footprint.origin.lon).toBeCloseTo(-122.4193, 5);
    expect(result.footprint.origin.lat).toBeCloseTo(37.775, 5);
  });

  it('winds the outer ring counter-clockwise regardless of OSM direction', () => {
    const clockwise = [...SQUARE].reverse();
    const result = parseOverpassFootprint(
      { elements: [{ type: 'way', id: WAY.id, geometry: clockwise }] },
      WAY,
    );
    const frame = new EnuFrame(result.footprint.origin);
    const projected = openRing(result.footprint.polygon.coordinates[0]!).map((c) =>
      frame.lonLatToEnu2d(c),
    );
    expect(signedArea(projected)).toBeGreaterThan(0);
  });

  it('prefers the tile height over the OSM tag', () => {
    const result = parseOverpassFootprint(
      { elements: [{ type: 'way', id: WAY.id, tags: { height: '30' }, geometry: SQUARE }] },
      WAY,
      { tileHeight: 47.5 },
    );
    expect(result.footprint.heightMeters).toBeCloseTo(47.5);
    expect(result.heightSource).toBe('tile-feature');
  });

  it('parses a multipolygon relation with a courtyard hole', () => {
    const hole = [
      { lon: -122.41935, lat: 37.77495 },
      { lon: -122.41925, lat: 37.77495 },
      { lon: -122.41925, lat: 37.77505 },
      { lon: -122.41935, lat: 37.77505 },
      { lon: -122.41935, lat: 37.77495 },
    ];
    const result = parseOverpassFootprint(
      {
        elements: [
          {
            type: 'relation',
            id: REL.id,
            tags: { building: 'yes', 'building:levels': '5' },
            members: [
              { type: 'way', role: 'outer', geometry: SQUARE },
              { type: 'way', role: 'inner', geometry: hole },
            ],
          },
        ],
      },
      REL,
    );

    expect(result.footprint.polygon.coordinates).toHaveLength(2);
    expect(result.footprint.heightMeters).toBeCloseTo(15);
    expect(result.heightSource).toBe('osm-building-levels');

    const frame = new EnuFrame(result.footprint.origin);
    const holeProjected = openRing(result.footprint.polygon.coordinates[1]!).map((c) =>
      frame.lonLatToEnu2d(c),
    );
    // Holes are wound clockwise.
    expect(signedArea(holeProjected)).toBeLessThan(0);
  });

  it('keeps the largest outer ring and reports the rest as dropped', () => {
    const small = [
      { lon: -122.5, lat: 37.9 },
      { lon: -122.49999, lat: 37.9 },
      { lon: -122.49999, lat: 37.90001 },
      { lon: -122.5, lat: 37.9 },
    ];
    const result = parseOverpassFootprint(
      {
        elements: [
          {
            type: 'relation',
            id: REL.id,
            members: [
              { type: 'way', role: 'outer', geometry: small },
              { type: 'way', role: 'outer', geometry: SQUARE },
            ],
          },
        ],
      },
      REL,
    );
    expect(result.droppedOuterRings).toBe(1);
    // The retained ring is the 20m square, not the 1m sliver.
    const frame = new EnuFrame(result.footprint.origin);
    const projected = openRing(result.footprint.polygon.coordinates[0]!).map((c) =>
      frame.lonLatToEnu2d(c),
    );
    expect(Math.abs(signedArea(projected))).toBeGreaterThan(100);
  });

  it('treats members with no role as outer', () => {
    const result = parseOverpassFootprint(
      {
        elements: [
          { type: 'relation', id: REL.id, members: [{ type: 'way', geometry: SQUARE }] },
        ],
      },
      REL,
    );
    expect(result.footprint.polygon.coordinates).toHaveLength(1);
  });

  it('explains a missing element rather than throwing a bare TypeError', () => {
    expect(() => parseOverpassFootprint({ elements: [] }, WAY)).toThrow(OverpassParseError);
    expect(() => parseOverpassFootprint({ elements: [] }, WAY)).toThrow(/deleted in OSM/);
  });

  it('rejects a way with too few points to form a polygon', () => {
    expect(() =>
      parseOverpassFootprint(
        { elements: [{ type: 'way', id: WAY.id, geometry: [{ lon: 0, lat: 0 }] }] },
        WAY,
      ),
    ).toThrow(OverpassParseError);
  });

  it('rejects a relation whose members never close', () => {
    expect(() =>
      parseOverpassFootprint(
        {
          elements: [
            {
              type: 'relation',
              id: REL.id,
              members: [
                {
                  type: 'way',
                  role: 'outer',
                  geometry: [
                    { lon: 0, lat: 0 },
                    { lon: 1, lat: 0 },
                  ],
                },
              ],
            },
          ],
        },
        REL,
      ),
    ).toThrow(/no closed outer ring/);
  });

  it('reads a Simple 3D Buildings relation from its "outline" member', () => {
    // type=building relations (common for churches and stepped towers, which
    // are usually decomposed into several building:part members) carry the
    // footprint on a member with role "outline", not "outer".
    const result = parseOverpassFootprint(
      {
        elements: [
          {
            type: 'relation',
            id: REL.id,
            tags: { building: 'church' },
            members: [{ type: 'way', role: 'outline', geometry: SQUARE }],
          },
        ],
      },
      REL,
    );
    expect(result.footprint.polygon.coordinates).toHaveLength(1);
  });

  it('does not let a "part"/"roof" member corrupt the outline ring', () => {
    // An unrelated part/roof segment that happens to touch the outline at one
    // point used to get woven into the boundary stitcher, preventing the
    // outline itself — already closed on its own — from ever being
    // recognised as a valid ring.
    const roofSliver = [
      SQUARE[0]!,
      { lon: -122.41, lat: 37.7 },
      { lon: -122.4, lat: 37.71 },
    ];
    const result = parseOverpassFootprint(
      {
        elements: [
          {
            type: 'relation',
            id: REL.id,
            tags: { building: 'yes' },
            members: [
              { type: 'way', role: 'outline', geometry: SQUARE },
              { type: 'way', role: 'part', geometry: roofSliver },
              { type: 'way', role: 'roof', geometry: roofSliver },
            ],
          },
        ],
      },
      REL,
    );
    expect(result.footprint.polygon.coordinates).toHaveLength(1);
    const frame = new EnuFrame(result.footprint.origin);
    const projected = openRing(result.footprint.polygon.coordinates[0]!).map((c) =>
      frame.lonLatToEnu2d(c),
    );
    // The retained ring is the real footprint, not something warped by the
    // roof sliver's geometry.
    expect(Math.abs(signedArea(projected))).toBeGreaterThan(100);
  });
});

describe('buildOverpassBboxQuery', () => {
  it('builds a query scoped to tagged buildings within the box', () => {
    const query = buildOverpassBboxQuery({ west: -1, south: -2, east: 3, north: 4 });
    expect(query).toContain('way["building"](-2,-1,4,3)');
    expect(query).toContain('relation["building"](-2,-1,4,3)');
    expect(query).toContain('out geom tags;');
  });

  it('recurses down so a relation-type building in the box gets member geometry', () => {
    const query = buildOverpassBboxQuery({ west: -1, south: -2, east: 3, north: 4 });
    expect(query).toContain('(._;>;);out geom tags;');
  });

  it('rejects an inverted box', () => {
    expect(() =>
      buildOverpassBboxQuery({ west: 3, south: -2, east: -1, north: 4 }),
    ).toThrow(/Invalid bounding box/);
  });
});

describe('parseOverpassAreaFootprints', () => {
  const SECOND_WAY: OsmRef = { id: 24950832, type: 'way' };

  it('parses every element in the response', () => {
    const results = parseOverpassAreaFootprints({
      elements: [
        { type: 'way', id: WAY.id, tags: { building: 'yes', height: '30' }, geometry: SQUARE },
        { type: 'way', id: SECOND_WAY.id, tags: { building: 'yes', height: '12' }, geometry: SQUARE },
      ],
    });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.footprint.osm.id)).toEqual([WAY.id, SECOND_WAY.id]);
    expect(results[1]!.footprint.heightMeters).toBeCloseTo(12);
  });

  it('skips a malformed element instead of throwing', () => {
    const results = parseOverpassAreaFootprints({
      elements: [
        // Degenerate way: fewer than 3 points, cannot form a ring.
        { type: 'way', id: WAY.id, geometry: [{ lon: 0, lat: 0 }] },
        { type: 'way', id: SECOND_WAY.id, tags: { building: 'yes' }, geometry: SQUARE },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.footprint.osm.id).toBe(SECOND_WAY.id);
  });

  it('ignores non-building elements Overpass might still echo back', () => {
    const results = parseOverpassAreaFootprints({
      elements: [{ type: 'node', id: 1 } as never],
    });
    expect(results).toHaveLength(0);
  });
});
