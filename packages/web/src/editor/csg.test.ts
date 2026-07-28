import { describe, expect, it } from 'vitest';
import { BoxGeometry, Plane, Quaternion, Vector3 } from 'three';
import { computeMeshVolume } from 'three-bvh-csg';
import type { CutOperation } from '@gme/shared';
import {
  CsgError,
  cutGeometry,
  operationFromWidget,
  planeFromOperation,
  planeIntersectsGeometry,
  replayOperations,
} from './csg.js';

/** A 20 x 10 x 20 box centred on the origin: volume 4000. */
function box() {
  const geometry = new BoxGeometry(20, 10, 20).toNonIndexed();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

const volumeOf = (g: Parameters<typeof computeMeshVolume>[0]) => computeMeshVolume(g);

describe('cutGeometry', () => {
  it('halves a box cut through its centre', () => {
    const geometry = box();
    expect(volumeOf(geometry)).toBeCloseTo(4000, 1);

    // Remove everything with y > 0.
    const cut = cutGeometry(geometry, new Plane(new Vector3(0, 1, 0), 0));
    expect(volumeOf(cut)).toBeCloseTo(2000, 0);
  });

  it('caps the cut face so the result is still a closed solid', () => {
    const cut = cutGeometry(box(), new Plane(new Vector3(0, 1, 0), 0));
    // An open shell would give a meaningless (typically near-zero or negative)
    // divergence volume; a clean positive half proves the cap exists.
    expect(volumeOf(cut)).toBeGreaterThan(1900);
    expect(cut.boundingBox!.max.y).toBeCloseTo(0, 3);
    expect(cut.boundingBox!.min.y).toBeCloseTo(-5, 3);
  });

  it('removes the side the normal points at, and flips with the normal', () => {
    const upper = cutGeometry(box(), new Plane(new Vector3(0, -1, 0), 0));
    expect(upper.boundingBox!.min.y).toBeCloseTo(0, 3);
    expect(upper.boundingBox!.max.y).toBeCloseTo(5, 3);
  });

  it('honours the plane constant as an offset', () => {
    // Keep y < 2.5: three quarters of the 10-tall box.
    const cut = cutGeometry(box(), new Plane(new Vector3(0, 1, 0), -2.5));
    expect(cut.boundingBox!.max.y).toBeCloseTo(2.5, 3);
    expect(volumeOf(cut)).toBeCloseTo(3000, 0);
  });

  it('cuts on an arbitrary diagonal', () => {
    const normal = new Vector3(1, 1, 0).normalize();
    const cut = cutGeometry(box(), new Plane(normal, 0));
    // A plane through the centroid splits a centrally symmetric solid in half.
    expect(volumeOf(cut)).toBeCloseTo(2000, 0);
  });

  it('leaves the input geometry untouched', () => {
    const geometry = box();
    const before = volumeOf(geometry);
    cutGeometry(geometry, new Plane(new Vector3(0, 1, 0), 0));
    expect(volumeOf(geometry)).toBeCloseTo(before, 3);
  });

  it('is stable across repeated evaluations (no shared-buffer clobbering)', () => {
    const geometry = box();
    const first = cutGeometry(geometry, new Plane(new Vector3(0, 1, 0), 0));
    const firstVolume = volumeOf(first);
    cutGeometry(geometry, new Plane(new Vector3(1, 0, 0), 0));
    // The second evaluation must not have overwritten the first result.
    expect(volumeOf(first)).toBeCloseTo(firstVolume, 3);
  });

  it('explains a cut that would delete the whole model', () => {
    expect(() => cutGeometry(box(), new Plane(new Vector3(0, 1, 0), 100))).toThrow(CsgError);
    expect(() => cutGeometry(box(), new Plane(new Vector3(0, 1, 0), 100))).toThrow(
      /removed the entire model/,
    );
  });

  it('leaves the model whole when the plane misses it entirely', () => {
    const cut = cutGeometry(box(), new Plane(new Vector3(0, 1, 0), -100));
    expect(volumeOf(cut)).toBeCloseTo(4000, 0);
  });

  // Regression: the cutting brush used to be a cube sized from the model's
  // radius but positioned at the plane's closest point to the world origin.
  // Both assumptions break once the model is not centred on the origin, and the
  // cut silently did nothing instead of removing material.
  it('cuts a model that sits far from the world origin', () => {
    const geometry = box().translate(500, 0, -300);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const cut = cutGeometry(geometry, new Plane(new Vector3(0, 1, 0), 0));
    expect(volumeOf(cut)).toBeCloseTo(2000, 0);
    expect(cut.boundingBox!.max.y).toBeCloseTo(0, 3);
  });

  it('removes only a thin slab for a plane near the model edge', () => {
    // Plane at y = -4 keeps the bottom 1m of a 10m-tall box.
    const cut = cutGeometry(box(), new Plane(new Vector3(0, 1, 0), 4));
    expect(volumeOf(cut)).toBeCloseTo(400, 0);
  });

  it('recognises a distant plane that engulfs the model', () => {
    // Plane at y = -40: the whole box is on the removal side.
    expect(() => cutGeometry(box(), new Plane(new Vector3(0, 1, 0), 40))).toThrow(
      /removed the entire model/,
    );
  });
});

describe('replayOperations', () => {
  it('returns a copy when there is nothing to replay', () => {
    const geometry = box();
    const replayed = replayOperations(geometry, []);
    expect(replayed).not.toBe(geometry);
    expect(volumeOf(replayed)).toBeCloseTo(4000, 1);
  });

  it('applies sequential cuts in order', () => {
    const replayed = replayOperations(box(), [
      { type: 'cut', normal: [0, 1, 0], constant: 0 }, // keep y < 0  -> 2000
      { type: 'cut', normal: [1, 0, 0], constant: 0 }, // keep x < 0  -> 1000
    ]);
    expect(volumeOf(replayed)).toBeCloseTo(1000, 0);
  });

  it('is deterministic: replaying the same list twice gives the same volume', () => {
    const ops: CutOperation[] = [
      { type: 'cut', normal: [0, 1, 0], constant: -1 },
      { type: 'cut', normal: [0.7071, 0, 0.7071], constant: -2 },
    ];
    const a = replayOperations(box(), ops);
    const b = replayOperations(box(), ops);
    expect(volumeOf(a)).toBeCloseTo(volumeOf(b), 4);
  });

  it('drives undo: dropping the last operation restores the earlier volume', () => {
    const ops = [
      { type: 'cut' as const, normal: [0, 1, 0] as [number, number, number], constant: 0 },
      { type: 'cut' as const, normal: [1, 0, 0] as [number, number, number], constant: 0 },
    ];
    const afterOne = replayOperations(box(), ops.slice(0, 1));
    const afterTwo = replayOperations(box(), ops);
    const undone = replayOperations(box(), ops.slice(0, 1));

    expect(volumeOf(afterTwo)).toBeLessThan(volumeOf(afterOne));
    expect(volumeOf(undone)).toBeCloseTo(volumeOf(afterOne), 4);
  });
});

describe('planeFromOperation', () => {
  it('normalises a non-unit normal and rescales the constant with it', () => {
    const plane = planeFromOperation({ type: 'cut', normal: [0, 2, 0], constant: -5 });
    expect(plane.normal.length()).toBeCloseTo(1, 9);
    expect(plane.constant).toBeCloseTo(-2.5, 9);
    // Same geometric plane: y = 2.5.
    expect(plane.distanceToPoint(new Vector3(0, 2.5, 0))).toBeCloseTo(0, 9);
  });

  it('rejects a degenerate normal instead of producing NaN geometry', () => {
    expect(() => planeFromOperation({ type: 'cut', normal: [0, 0, 0], constant: 0 })).toThrow(
      CsgError,
    );
  });
});

describe('operationFromWidget', () => {
  it('reads the widget local +Y as the cut normal', () => {
    const op = operationFromWidget(new Vector3(0, 3, 0), new Quaternion(), false);
    expect(op.normal[0]).toBeCloseTo(0, 9);
    expect(op.normal[1]).toBeCloseTo(1, 9);
    expect(op.constant).toBeCloseTo(-3, 9);
  });

  it('flips the normal and the constant together', () => {
    const op = operationFromWidget(new Vector3(0, 3, 0), new Quaternion(), true);
    expect(op.normal[1]).toBeCloseTo(-1, 9);
    expect(op.constant).toBeCloseTo(3, 9);
  });

  it('round-trips a rotated widget through to a plane containing its position', () => {
    const position = new Vector3(2, 4, -1);
    const quaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 3);
    const plane = planeFromOperation(operationFromWidget(position, quaternion, false));
    expect(plane.distanceToPoint(position)).toBeCloseTo(0, 9);
  });

  it('produces a cut that actually removes material for a rotated widget', () => {
    const op = operationFromWidget(
      new Vector3(0, 0, 0),
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2),
      false,
    );
    const cut = replayOperations(box(), [op]);
    expect(volumeOf(cut)).toBeCloseTo(2000, 0);
  });
});

describe('planeIntersectsGeometry', () => {
  it('detects a plane crossing the model', () => {
    expect(planeIntersectsGeometry(box(), new Plane(new Vector3(0, 1, 0), 0))).toBe(true);
  });

  it('detects a plane clear of the model', () => {
    expect(planeIntersectsGeometry(box(), new Plane(new Vector3(0, 1, 0), -100))).toBe(false);
  });
});
