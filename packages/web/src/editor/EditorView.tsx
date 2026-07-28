/**
 * The MeshLab-style edit workspace.
 *
 * Deliberately a separate Three.js scene rather than something embedded in the
 * Cesium globe: Cesium's renderer has no gizmo/among-vertex editing story, and
 * working at globe scale means the mesh sits millions of metres from the origin
 * where float precision for interactive dragging is poor. Here the building is
 * a few tens of metres across, centred on the origin.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, OrbitControls, TransformControls } from '@react-three/drei';
import {
  BackSide,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Plane,
  Quaternion,
  Vector3,
} from 'three';
import { useAppStore } from '../state/store.js';

export type GizmoMode = 'none' | 'scale' | 'rotate';

interface EditorViewProps {
  gizmo: GizmoMode;
}

export function EditorView({ gizmo }: EditorViewProps) {
  const geometry = useAppStore((s) => s.displayGeometry);

  return (
    <Canvas
      className="editor-canvas"
      // Buildings are tens of metres; a tight near plane keeps depth precision
      // usable when the camera dollies in close.
      camera={{ position: [45, 35, 45], near: 0.1, far: 5000, fov: 45 }}
      shadows={false}
      // Clipping planes are how the live slice preview works; without this the
      // material's clippingPlanes are ignored.
      gl={{ localClippingEnabled: true, antialias: true }}
    >
      <color attach="background" args={['#12151c']} />
      <hemisphereLight intensity={0.7} groundColor="#20242e" />
      <directionalLight position={[60, 90, 40]} intensity={1.6} />
      <directionalLight position={[-50, 40, -30]} intensity={0.5} />

      <Grid
        args={[400, 400]}
        cellSize={5}
        cellColor="#2b3242"
        sectionSize={25}
        sectionColor="#3c465e"
        fadeDistance={400}
        infiniteGrid
        position={[0, 0, 0]}
      />

      <Suspense fallback={null}>{geometry ? <EditableModel geometry={geometry} gizmo={gizmo} /> : null}</Suspense>

      <OrbitControls makeDefault enableDamping dampingFactor={0.1} maxDistance={2000} />
    </Canvas>
  );
}

/**
 * The building mesh plus its gizmos.
 *
 * Scale and rotation live on this node's transform and are pushed into the
 * store; the vertex data underneath is only ever changed by committing a cut.
 */
function EditableModel({ geometry, gizmo }: { geometry: BufferGeometry; gizmo: GizmoMode }) {
  // State rather than a ref: TransformControls needs the mesh as a prop, and a
  // ref assignment would not re-render to hand it over.
  const [meshNode, setMeshNode] = useState<Mesh | null>(null);
  const editState = useAppStore((s) => s.editHistory.present);
  const setScale = useAppStore((s) => s.setScale);
  const setQuaternion = useAppStore((s) => s.setQuaternion);
  const clip = useAppStore((s) => s.clip);

  // A gesture id lets the history collapse a whole drag into one undo step.
  const gestureRef = useRef<string | null>(null);

  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#cfd4dc',
        roughness: 0.85,
        metalness: 0.0,
        // Cut previews expose interior faces; without this the building looks
        // hollow and inside-out while the plane is being positioned.
        side: DoubleSide,
      }),
    [],
  );

  // Backface shell that fills in the "open" look of a clipped solid, so the
  // live preview reads as a solid cut rather than an empty shell.
  const capMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: '#8b93a5',
        roughness: 0.9,
        side: BackSide,
      }),
    [],
  );

  const previewPlane = useMemo(() => new Plane(), []);

  useEffect(() => {
    if (!clip.enabled) {
      material.clippingPlanes = null;
      capMaterial.clippingPlanes = null;
      material.needsUpdate = true;
      return;
    }

    const normal = new Vector3(0, 1, 0)
      .applyQuaternion(new Quaternion(...clip.quaternion))
      .normalize();
    if (clip.flipped) normal.negate();

    const position = new Vector3(...clip.position);
    // Three's clipping keeps the NEGATIVE side of the plane, which matches the
    // CSG convention here (the +normal half-space is what gets removed).
    previewPlane.setFromNormalAndCoplanarPoint(normal, position);

    material.clippingPlanes = [previewPlane];
    capMaterial.clippingPlanes = [previewPlane];
    material.needsUpdate = true;
    capMaterial.needsUpdate = true;
  }, [clip, material, capMaterial, previewPlane]);

  useEffect(() => () => {
    material.dispose();
    capMaterial.dispose();
  }, [material, capMaterial]);

  // Push store state onto the object when it changes from outside (undo/redo,
  // numeric inputs), without fighting an in-progress drag.
  useEffect(() => {
    if (!meshNode || gestureRef.current) return;
    meshNode.scale.set(...editState.transform.scale);
    meshNode.quaternion.set(...editState.transform.quaternion);
  }, [editState, meshNode]);

  const handleChange = () => {
    if (!meshNode) return;
    if (!gestureRef.current) gestureRef.current = `${gizmo}:${Date.now()}`;

    if (gizmo === 'scale') {
      setScale([meshNode.scale.x, meshNode.scale.y, meshNode.scale.z], gestureRef.current);
    } else if (gizmo === 'rotate') {
      const q = meshNode.quaternion;
      setQuaternion([q.x, q.y, q.z, q.w], gestureRef.current);
    }
  };

  return (
    <>
      <mesh ref={setMeshNode} geometry={geometry} material={material} />
      {/* Second pass with BackSide fills the cut opening during preview. */}
      {clip.enabled ? <mesh geometry={geometry} material={capMaterial} /> : null}

      {gizmo !== 'none' && meshNode ? (
        <TransformControls
          object={meshNode}
          mode={gizmo}
          onObjectChange={handleChange}
          onMouseUp={() => {
            gestureRef.current = null;
          }}
        />
      ) : null}

      {clip.enabled ? <ClipPlaneWidget /> : null}
    </>
  );
}

/**
 * A draggable proxy object whose transform defines the cutting plane.
 *
 * Reusing `TransformControls` on a proxy is much less code than a bespoke plane
 * manipulator and gives the user translate and rotate handles they already know
 * from the scale/rotate modes.
 */
function ClipPlaneWidget() {
  const clip = useAppStore((s) => s.clip);
  const setClip = useAppStore((s) => s.setClip);
  const geometry = useAppStore((s) => s.displayGeometry);
  const [proxy] = useState(() => new Object3D());
  const [widgetMode, setWidgetMode] = useState<'translate' | 'rotate'>('translate');
  const { scene } = useThree();

  // Size the visual plane to the model so it reads as a slicing tool.
  const planeSize = useMemo(() => {
    if (!geometry) return 40;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    return Math.max((geometry.boundingSphere?.radius ?? 20) * 2.2, 10);
  }, [geometry]);

  // Attach the proxy to the scene exactly once. Re-adding it whenever the clip
  // transform changes would detach TransformControls mid-drag.
  useEffect(() => {
    scene.add(proxy);
    return () => {
      scene.remove(proxy);
    };
  }, [proxy, scene]);

  // Mirror store -> proxy for changes that did not come from dragging the
  // proxy itself (the "reset plane" button, loading a different model).
  useEffect(() => {
    const [px, py, pz] = clip.position;
    const [qx, qy, qz, qw] = clip.quaternion;
    if (proxy.position.x !== px || proxy.position.y !== py || proxy.position.z !== pz) {
      proxy.position.set(px, py, pz);
    }
    if (
      proxy.quaternion.x !== qx ||
      proxy.quaternion.y !== qy ||
      proxy.quaternion.z !== qz ||
      proxy.quaternion.w !== qw
    ) {
      proxy.quaternion.set(qx, qy, qz, qw);
    }
  }, [proxy, clip.position, clip.quaternion]);

  // "R" toggles between sliding the plane along its normal and tilting it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key.toLowerCase() === 'r') {
        setWidgetMode((m) => (m === 'translate' ? 'rotate' : 'translate'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {/* Group carries the plane's transform; the quad inside is rotated so
          its own +Z normal lines up with the group's +Y, which is the
          convention `operationFromWidget` reads. */}
      <group position={clip.position} quaternion={clip.quaternion}>
        <mesh rotation-x={-Math.PI / 2}>
          <planeGeometry args={[planeSize, planeSize]} />
          <meshBasicMaterial
            color="#38bdf8"
            transparent
            opacity={0.18}
            side={DoubleSide}
            depthWrite={false}
          />
        </mesh>
      </group>

      <TransformControls
        object={proxy}
        mode={widgetMode}
        onObjectChange={() => {
          setClip({
            position: [proxy.position.x, proxy.position.y, proxy.position.z],
            quaternion: [
              proxy.quaternion.x,
              proxy.quaternion.y,
              proxy.quaternion.z,
              proxy.quaternion.w,
            ],
          });
        }}
      />
    </>
  );
}
