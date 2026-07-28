import { describe, expect, it } from 'vitest';
import { parseOsmLength, resolveHeight } from './height.js';

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
