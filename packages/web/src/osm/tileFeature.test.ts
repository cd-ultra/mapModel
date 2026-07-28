import { describe, expect, it } from 'vitest';
import {
  osmTagsFromProperties,
  parseElementId,
  parseElementType,
  readTileFeature,
  type TileFeatureLike,
} from './tileFeature.js';

/** Stand-in for Cesium3DTileFeature, using the modern getPropertyIds API. */
function feature(props: Record<string, unknown>, legacy = false): TileFeatureLike {
  const names = Object.keys(props);
  const base = {
    getProperty: (name: string) => props[name],
  };
  return legacy
    ? { ...base, getPropertyNames: () => names }
    : { ...base, getPropertyIds: () => names };
}

describe('parseElementId', () => {
  it('accepts numbers and numeric strings', () => {
    expect(parseElementId(24950831)).toEqual({ id: 24950831 });
    expect(parseElementId('24950831')).toEqual({ id: 24950831 });
  });

  it('accepts prefixed forms and recovers the type from them', () => {
    expect(parseElementId('way/24950831')).toEqual({ id: 24950831, type: 'way' });
    expect(parseElementId('relation/555')).toEqual({ id: 555, type: 'relation' });
    expect(parseElementId('w24950831')).toEqual({ id: 24950831, type: 'way' });
    expect(parseElementId('r-555')).toEqual({ id: 555, type: 'relation' });
  });

  it('rejects unusable values', () => {
    expect(parseElementId(undefined)).toBeNull();
    expect(parseElementId('')).toBeNull();
    expect(parseElementId('abc')).toBeNull();
    expect(parseElementId(0)).toBeNull();
    expect(parseElementId(-5)).toBeNull();
    expect(parseElementId(1.5)).toBeNull();
    expect(parseElementId({})).toBeNull();
  });
});

describe('parseElementType', () => {
  it('reads string spellings', () => {
    expect(parseElementType('way')).toBe('way');
    expect(parseElementType('Way')).toBe('way');
    expect(parseElementType('w')).toBe('way');
    expect(parseElementType('relation')).toBe('relation');
    expect(parseElementType('rel')).toBe('relation');
    expect(parseElementType('r')).toBe('relation');
  });

  it('reads positional enum encodings', () => {
    expect(parseElementType(0)).toBe('way');
    expect(parseElementType(1)).toBe('relation');
    expect(parseElementType(7)).toBeNull();
  });

  it('rejects nonsense', () => {
    expect(parseElementType('node')).toBeNull();
    expect(parseElementType(undefined)).toBeNull();
  });
});

describe('readTileFeature', () => {
  it('reads the standard Cesium OSM Buildings shape', () => {
    const result = readTileFeature(
      feature({
        elementId: 24950831,
        elementType: 'way',
        'cesium#estimatedHeight': 32.5,
        building: 'yes',
        name: 'Ferry Building',
      }),
    );

    expect(result.ref).toEqual({ id: 24950831, type: 'way' });
    expect(result.tileHeight).toBeCloseTo(32.5);
    expect(result.problem).toBeNull();
    expect(result.matchedKeys).toEqual({
      id: 'elementId',
      type: 'elementType',
      height: 'cesium#estimatedHeight',
    });
  });

  it('supports the legacy getPropertyNames API', () => {
    const result = readTileFeature(feature({ elementId: 42, elementType: 'relation' }, true));
    expect(result.ref).toEqual({ id: 42, type: 'relation' });
  });

  it('falls back through alternative property spellings', () => {
    const result = readTileFeature(feature({ osm_id: '777', osm_type: 'relation' }));
    expect(result.ref).toEqual({ id: 777, type: 'relation' });
    expect(result.matchedKeys.id).toBe('osm_id');
  });

  it('recovers the type from a prefixed id when no type property exists', () => {
    const result = readTileFeature(feature({ elementId: 'relation/999' }));
    expect(result.ref).toEqual({ id: 999, type: 'relation' });
    expect(result.matchedKeys.type).toBe('elementId');
  });

  it('assumes way when the type is genuinely absent', () => {
    const result = readTileFeature(feature({ elementId: 123 }));
    expect(result.ref).toEqual({ id: 123, type: 'way' });
  });

  it('reports the available properties when no id can be found', () => {
    const result = readTileFeature(feature({ colour: 'red', levels: 4 }));
    expect(result.ref).toBeNull();
    expect(result.problem).toContain('colour');
    expect(result.problem).toContain('levels');
    expect(result.properties).toEqual({ colour: 'red', levels: 4 });
  });

  it('explains an entirely propertyless feature', () => {
    const result = readTileFeature({ getPropertyIds: () => [], getProperty: () => undefined });
    expect(result.ref).toBeNull();
    expect(result.problem).toContain('no properties at all');
  });

  it('explains an id property holding junk', () => {
    const result = readTileFeature(feature({ elementId: 'not-an-id' }));
    expect(result.ref).toBeNull();
    expect(result.problem).toContain('not a usable OSM id');
  });

  it('ignores a non-positive tile height rather than extruding to nothing', () => {
    const result = readTileFeature(feature({ elementId: 1, 'cesium#estimatedHeight': 0 }));
    expect(result.tileHeight).toBeNull();
    expect(result.ref).not.toBeNull();
  });

  it('never throws on a feature with no property enumeration at all', () => {
    const result = readTileFeature({ getProperty: () => undefined });
    expect(result.ref).toBeNull();
    expect(result.properties).toEqual({});
  });
});

describe('osmTagsFromProperties', () => {
  it('keeps OSM tags and drops Cesium internals', () => {
    const tags = osmTagsFromProperties({
      building: 'yes',
      'addr:city': 'San Francisco',
      'cesium#estimatedHeight': 32,
      'cesium#color': '#fff',
      levels: 4,
      nested: { a: 1 },
      missing: null,
    });

    expect(tags).toEqual({
      building: 'yes',
      'addr:city': 'San Francisco',
      levels: '4',
    });
  });
});
