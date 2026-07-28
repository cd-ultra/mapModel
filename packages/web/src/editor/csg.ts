/**
 * Destructive slicing via CSG.
 *
 * A clipping plane on the material gives a free live preview but changes only
 * the render; committing a cut has to change the geometry so the result exports
 * to glTF as a real solid with a capped face. That is what `three-bvh-csg` does
 * here: subtract a half-space box from the mesh.
 *
 * Cut planes are always expressed in the mesh's *local, untransformed* space.
 * That is what makes replay-based undo work — the operation list stays valid
 * however the user scales or rotates the model afterwards.
 */

import {
  Box3,
  BoxGeometry,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Plane,
  Quaternion,
  Sphere,
  Vector3,
} from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import type { CutOperation } from '@gme/shared';

export class CsgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsgError';
  }
}

/**
 * One evaluator is reused across cuts: it caches internal scratch buffers, and
 * building a fresh one per operation shows up as a visible hitch on commit.
 */
let sharedEvaluator: Evaluator | null = null;

function getEvaluator(): Evaluator {
  if (!sharedEvaluator) {
    const evaluator = new Evaluator();
    // Our extruded geometry carries position and normal only. Leaving the
    // default list (which includes uv) makes the evaluator read a missing
    // attribute and throw.
    evaluator.attributes = ['position', 'normal'];
    evaluator.useGroups = false;
    sharedEvaluator = evaluator;
  }
  return sharedEvaluator;
}

/** Material is irrelevant to the boolean result but Brush wants one. */
const brushMaterial = new MeshStandardMaterial();

function boundingSphereOf(geometry: BufferGeometry): Sphere {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const sphere: Sphere | null = geometry.boundingSphere;
  if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius <= 0) {
    throw new CsgError('Geometry has no finite bounding sphere; cannot size the cutting brush');
  }
  return sphere;
}

/**
 * Build the half-space brush for a plane.
 *
 * The brush must cover everything the plane is supposed to delete, and the
 * plane can sit arbitrarily far from the model — the user drags the widget
 * freely. Sizing the box from the model's radius alone is therefore not enough:
 * a distant plane yields a box that never reaches the model, and the cut
 * silently does nothing.
 *
 * So the box is built to span from the plane to past the far side of the model:
 * centred laterally on the model's bounding sphere (projected onto the plane)
 * and extended along +normal by however far the model reaches beyond it.
 */
function buildHalfSpaceBrush(plane: Plane, sphere: Sphere): Brush {
  const { radius } = sphere;
  // How far the model extends past the plane, along the removal direction.
  const signedDistance = plane.distanceToPoint(sphere.center);
  const reach = signedDistance + radius;

  const margin = Math.max(radius * 0.1, 1e-3);
  const alongNormal = reach + margin;
  const lateral = radius * 2 + margin * 2;

  const geometry = new BoxGeometry(lateral, alongNormal, lateral);
  const brush = new Brush(geometry, brushMaterial);

  // Project the sphere centre onto the plane, then step half the box length
  // along the normal so the box's near face lies exactly on the plane.
  const base = sphere.center.clone().addScaledVector(plane.normal, -signedDistance);
  brush.position.copy(base).addScaledVector(plane.normal, alongNormal / 2);
  brush.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), plane.normal);
  brush.updateMatrixWorld(true);
  return brush;
}

export function planeFromOperation(operation: CutOperation): Plane {
  const normal = new Vector3(...operation.normal);
  const length = normal.length();
  if (length < 1e-9) {
    throw new CsgError('Cut plane has a zero-length normal');
  }
  normal.divideScalar(length);
  // Normalising the normal rescales the constant with it.
  return new Plane(normal, operation.constant / length);
}

/**
 * Remove everything on the positive side of `plane` from `geometry`.
 *
 * Returns a new geometry; the input is left untouched so the caller's raw
 * extraction stays intact for replay.
 */
export function cutGeometry(geometry: BufferGeometry, plane: Plane): BufferGeometry {
  const sphere = boundingSphereOf(geometry);
  const signedDistance = plane.distanceToPoint(sphere.center);

  // Trivial rejection: the model lies wholly on the keep side. Running CSG here
  // would be a no-op at best and could introduce numerical noise into the mesh.
  if (signedDistance + sphere.radius <= 0) {
    return geometry.clone();
  }

  // Trivial acceptance: the model lies wholly on the remove side. Caught up
  // front because it is a user error worth naming, and because an empty CSG
  // result is harder to diagnose after the fact.
  if (signedDistance - sphere.radius >= 0) {
    throw new CsgError(
      'The cut removed the entire model. Flip the plane or move it back inside the building.',
    );
  }

  const target = new Brush(geometry, brushMaterial);
  target.updateMatrixWorld(true);
  const cutter = buildHalfSpaceBrush(plane, sphere);

  const result = getEvaluator().evaluate(target, cutter, SUBTRACTION);
  const output = result.geometry;

  const position = output.getAttribute('position');
  if (!position || position.count === 0) {
    throw new CsgError(
      'The cut removed the entire model. Flip the plane or move it back inside the building.',
    );
  }

  // The evaluator hands back geometry owned by its target brush; clone so the
  // next evaluation does not overwrite the geometry we just returned.
  const cloned = output.clone();
  cloned.computeBoundingBox();
  cloned.computeBoundingSphere();

  cutter.geometry.dispose();
  return cloned;
}

/**
 * Rebuild geometry from the raw extraction by replaying every cut in order.
 *
 * This is the whole undo story: state changes, geometry is regenerated. Cuts on
 * a single low-poly building are milliseconds each, so replaying a dozen of
 * them is cheaper and far more robust than trying to invert a boolean.
 */
export function replayOperations(
  raw: BufferGeometry,
  operations: readonly CutOperation[],
): BufferGeometry {
  if (operations.length === 0) return raw.clone();

  let current = raw;
  let owned = false;

  for (const operation of operations) {
    const next = cutGeometry(current, planeFromOperation(operation));
    if (owned) current.dispose();
    current = next;
    owned = true;
  }

  return current;
}

/**
 * Turn a plane widget's world transform into a storable operation.
 *
 * The widget lives in the same local space as the mesh, so its orientation and
 * position map straight onto a plane: the widget's local +Y is the normal, and
 * the constant follows from the point it sits at.
 */
export function operationFromWidget(
  position: Vector3,
  quaternion: Quaternion,
  flipped: boolean,
): CutOperation {
  const normal = new Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
  if (flipped) normal.negate();
  return {
    type: 'cut',
    normal: [normal.x, normal.y, normal.z],
    constant: -normal.dot(position),
  };
}

/**
 * Whether a plane actually intersects the geometry. Committing a cut that
 * misses entirely either does nothing or deletes everything, and both are
 * confusing — the UI disables the button instead.
 */
export function planeIntersectsGeometry(geometry: BufferGeometry, plane: Plane): boolean {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box: Box3 | null = geometry.boundingBox;
  return box ? plane.intersectsBox(box) : false;
}

/** Placeholder mesh factory used by the editor scene; keeps three imports local. */
export function createEditableMesh(geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
  return new Mesh(geometry, material);
}
