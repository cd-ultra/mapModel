import { describe, expect, it } from 'vitest';
import { parseOsmLength, resolveHeight, resolveRoof } from './height.js';

describe('parseOsmLength', () => {
  it('reads bare numbers as metres', () => {
    expect(parseOsmLength('25')).toBeCloseTo(25);
    expect(parseOsmLength(25)).toBeCloseTo(25);
    expect(parseOsmLength('25.5')).toBeCloseTo(25.5);
  });

  it('reads explicit metric units', () => {
    expect(parseOsmLength('25 m')).toBeCloseTo(25);
    expect(parseOsmLength('25m')).toBeCloseTo(25);
    expect(parseOsmLength('1 km')).toBeCloseTo(1000);
  });

  it('reads comma decimal separators', () => {
    expect(parseOsmLength('25,5')).toBeCloseTo(25.5);
  });

  it('converts imperial forms', () => {
    expect(parseOsmLength('40 ft')).toBeCloseTo(12.192, 3);
    expect(parseOsmLength("12'6\"")).toBeCloseTo(3.8100, 3);
    expect(parseOsmLength("12'")).toBeCloseTo(3.6576, 3);
  });

  it('rejects junk, empties, and non-positive values', () => {
    expect(parseOsmLength(undefined)).toBeNull();
    expect(parseOsmLength(null)).toBeNull();
    expect(parseOsmLength('')).toBeNull();
    expect(parseOsmLength('tall')).toBeNull();
    expect(parseOsmLength('0')).toBeNull();
    expect(parseOsmLength('-5')).toBeNull();
    expect(parseOsmLength('25 furlongs')).toBeNull();
  });
});

describe('resolveHeight', () => {
  it('prefers the tile feature height so the mesh matches what was clicked', () => {
    const r = resolveHeight({ height: '99' }, 42);
    expect(r.heightMeters).toBe(42);
    expect(r.source).toBe('tile-feature');
  });

  it('falls back to the OSM height tag', () => {
    const r = resolveHeight({ height: '31 m' }, null);
    expect(r.heightMeters).toBeCloseTo(31);
    expect(r.source).toBe('osm-height');
  });

  it('derives height from building levels', () => {
    const r = resolveHeight({ 'building:levels': '4' }, null);
    expect(r.heightMeters).toBeCloseTo(12);
    expect(r.source).toBe('osm-building-levels');
  });

  it('defaults when nothing is tagged', () => {
    const r = resolveHeight({}, null);
    expect(r.heightMeters).toBe(10);
    expect(r.source).toBe('default');
  });

  it('carries min_height through for buildings that float above ground', () => {
    const r = resolveHeight({ height: '30', min_height: '8' }, null);
    expect(r.minHeightMeters).toBeCloseTo(8);
  });

  it('ignores a zero or negative tile height', () => {
    expect(resolveHeight({ height: '20' }, 0).source).toBe('osm-height');
    expect(resolveHeight({ height: '20' }, -3).source).toBe('osm-height');
  });
});

describe('resolveRoof', () => {
  it('is flat for anything other than roof:shape=pyramidal', () => {
    expect(resolveRoof({}, 50, 0)).toEqual({ shape: null, roofHeightMeters: 0 });
    expect(resolveRoof({ 'roof:shape': 'dome' }, 50, 0)).toEqual({
      shape: null,
      roofHeightMeters: 0,
    });
  });

  it('is flat when pyramidal but roof:height is missing or unparsable', () => {
    expect(resolveRoof({ 'roof:shape': 'pyramidal' }, 50, 0)).toEqual({
      shape: null,
      roofHeightMeters: 0,
    });
    expect(
      resolveRoof({ 'roof:shape': 'pyramidal', 'roof:height': 'nonsense' }, 50, 0),
    ).toEqual({ shape: null, roofHeightMeters: 0 });
  });

  it('trusts an explicit roof:height that leaves a normal wall section', () => {
    const r = resolveRoof({ 'roof:shape': 'pyramidal', 'roof:height': '20 m' }, 50, 0);
    expect(r).toEqual({ shape: 'pyramidal', roofHeightMeters: 20 });
  });

  it('reserves a minimum wall section when roof:height would otherwise consume the whole building (Transamerica Pyramid: way 24222973)', () => {
    // height=260, roof:height=260 m taken literally would zero out the walls
    // entirely and extrude as a knife-edge cone touching the ground.
    const r = resolveRoof({ 'roof:shape': 'pyramidal', 'roof:height': '260 m' }, 260, 0);
    expect(r.shape).toBe('pyramidal');
    expect(r.roofHeightMeters).toBeCloseTo(234, 5); // 260 * (1 - 0.1)
    expect(r.roofHeightMeters).toBeLessThan(260);
  });

  it('reserves the minimum wall section relative to min_height, not the ground', () => {
    const r = resolveRoof({ 'roof:shape': 'pyramidal', 'roof:height': '100 m' }, 60, 10);
    // wallSpan = 50, so the roof can take at most 45 of it.
    expect(r.roofHeightMeters).toBeCloseTo(45, 5);
  });
});
