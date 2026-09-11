/**
 * Preview of the block model: base plate + every building in the area, with
 * the singled-out building in its accent colour. A separate Three.js scene
 * for the same reason `EditorView` is — a clean local origin at a scale where
 * OrbitControls behaves, rather than reusing Cesium's globe-scale renderer.
 *
 * Unlike `EditorView` there is nothing to drag here: the model is built
 * straight from `buildBlockMesh` and only ever looked at.
 */

import { Suspense, useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import { Mesh } from 'three';
import { buildBlockMesh } from '../mesh/buildBlockMesh.js';
import { useAppStore } from '../state/store.js';

export function BlockView() {
  const block = useAppStore((s) => s.block);

  const mesh = useMemo(() => {
    if (!block.center || block.footprints.length === 0) return null;
    return buildBlockMesh(block.footprints, block.center, block.highlightOsm);
  }, [block.center, block.footprints, block.highlightOsm]);

  // `mesh.rest`/`mesh.highlighted` own the only non-cloned references to each
  // geometry and material; disposing via them each time the block is rebuilt
  // keeps switching radius or highlight from leaking GPU buffers.
  useEffect(() => {
    if (!mesh) return;
    return () => {
      for (const group of [mesh.rest, mesh.highlighted]) {
        group?.traverse((object) => {
          if (object instanceof Mesh) {
            object.geometry.dispose();
            if (!Array.isArray(object.material)) object.material.dispose();
          }
        });
      }
    };
  }, [mesh]);

  return (
    <Canvas
      className="editor-canvas"
      camera={{ position: [70, 60, 70], near: 0.1, far: 5000, fov: 45 }}
      shadows={false}
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

      <Suspense fallback={null}>
        {mesh ? <primitive object={mesh.preview} /> : null}
      </Suspense>

      <OrbitControls makeDefault enableDamping dampingFactor={0.1} maxDistance={2000} />
    </Canvas>
  );
}
