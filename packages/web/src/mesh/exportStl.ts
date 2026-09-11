/**
 * Exporting a block-mesh group to binary STL — the file a print shop or
 * slicer actually wants. STL carries no material/colour information, which is
 * exactly why `buildBlockMesh` splits the highlighted building out into its
 * own group: printing it as a *separate* STL is how a two-colour or
 * two-material print is actually produced, rather than trying to bake colour
 * into a format that has no notion of it.
 */

import { Object3D } from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';

export function exportStl(source: Object3D): ArrayBuffer {
  const exporter = new STLExporter();
  const result = exporter.parse(source, { binary: true });
  // `binary: true` always returns a DataView; the string overload is only for
  // ASCII output, which we never request.
  return (result as DataView).buffer as ArrayBuffer;
}

export function downloadStl(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.stl') ? filename : `${filename}.stl`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
