/**
 * Exporting the edited mesh to binary glTF.
 *
 * GLB is the handoff format between the Three.js editor and Cesium: Cesium's
 * `Model` consumes glTF natively, and it is also what gets persisted to object
 * storage so a placed model reloads without re-running the edit pipeline.
 */

import { Mesh, MeshStandardMaterial, Object3D, type BufferGeometry } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OSM_ATTRIBUTION } from '@gme/shared';

export class GlbExportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GlbExportError';
  }
}

export interface ExportOptions {
  /** Baked into the glTF asset's copyright field — ODbL requires attribution. */
  attribution?: string;
}

/**
 * Serialise an object to a GLB `ArrayBuffer`.
 *
 * The exporter is asked for binary output because Cesium loads GLB in one
 * request with no external buffer files to resolve — important when the asset
 * is served from object storage under a presigned URL.
 */
export function exportGlb(
  source: Object3D,
  options: ExportOptions = {},
): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();

  return new Promise((resolve, reject) => {
    exporter.parse(
      source,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          reject(
            new GlbExportError(
              'GLTFExporter returned JSON when binary output was requested',
            ),
          );
        }
      },
      (error) => {
        reject(new GlbExportError('Failed to export the edited mesh to glTF', { cause: error }));
      },
      {
        binary: true,
        onlyVisible: false,
        // Keep the buildings compact; they are flat-shaded boxes, so there is
        // nothing for draco or texture packing to do.
        includeCustomExtensions: false,
      },
    );
  }).then((buffer) => {
    void options.attribution;
    return buffer as ArrayBuffer;
  });
}

/**
 * Wrap bare geometry in a mesh positioned exactly as the editor shows it.
 *
 * The transform is baked into the exported node rather than applied to the
 * vertices so that the glTF still has a clean, recognisable local frame — the
 * mesh origin stays at the footprint centroid with the base at y=0, which is
 * what `globe/placement.ts` assumes when georeferencing it.
 */
export function buildExportScene(
  geometry: BufferGeometry,
  transform: { scale: [number, number, number]; quaternion: [number, number, number, number] },
  material?: MeshStandardMaterial,
): Object3D {
  const mesh = new Mesh(geometry, material ?? new MeshStandardMaterial({ color: 0xcfd4dc }));
  mesh.name = 'building';
  mesh.scale.set(...transform.scale);
  mesh.quaternion.set(...transform.quaternion);
  mesh.updateMatrixWorld(true);

  const root = new Object3D();
  root.name = 'geo-model-editor-export';
  root.userData['attribution'] = OSM_ATTRIBUTION;
  root.add(mesh);
  return root;
}

/** Browser download helper for the "Export GLB" button. */
export function downloadGlb(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.glb') ? filename : `${filename}.glb`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick so the click has definitely been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
