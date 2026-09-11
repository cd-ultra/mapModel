/**
 * Side panels: extraction metadata, transform controls, slicing, placement.
 *
 * The panels are the numeric half of the editor — every gizmo interaction has a
 * typed equivalent here, because "scale this to exactly 1.5x" is a thing users
 * want and a drag handle cannot do.
 */

import { useMemo, useState } from 'react';
import { Euler, Quaternion } from 'three';
import type { Placement } from '@gme/shared';
import { useAppStore } from '../state/store.js';
import { buildExportScene, downloadGlb, exportGlb } from '../mesh/exportGlb.js';
import { buildBlockMesh } from '../mesh/buildBlockMesh.js';
import { downloadStl, exportStl } from '../mesh/exportStl.js';
import { BlockView } from '../editor/BlockView.js';
import type { GizmoMode } from '../editor/EditorView.js';
import { ApiClient } from '../api/client.js';
import { config } from '../config.js';

const api = new ApiClient(config.apiBaseUrl);

const HEIGHT_SOURCE_LABEL: Record<string, string> = {
  'tile-feature': 'Cesium tile height',
  'osm-height': 'OSM height tag',
  'osm-building-levels': 'derived from building:levels',
  default: 'default guess (untagged)',
};

export function ExtractionPanel() {
  const extraction = useAppStore((s) => s.extraction);
  const clearModel = useAppStore((s) => s.clearModel);
  const [showRaw, setShowRaw] = useState(false);

  if (!extraction) {
    return (
      <section className="panel">
        <h2>Source</h2>
        <p className="hint">
          Click a building on the globe to extract it. The footprint and height come
          from OpenStreetMap; the mesh is regenerated locally so it is fully editable.
        </p>
      </section>
    );
  }

  const { footprint } = extraction;
  const name = footprint.tags['name'] ?? `${footprint.osm.type} ${footprint.osm.id}`;

  return (
    <section className="panel">
      <h2>Source</h2>
      <dl className="facts">
        <dt>Building</dt>
        <dd>{name}</dd>
        <dt>OSM</dt>
        <dd>
          <a
            href={`https://www.openstreetmap.org/${footprint.osm.type}/${footprint.osm.id}`}
            target="_blank"
            rel="noreferrer"
          >
            {footprint.osm.type}/{footprint.osm.id}
          </a>
        </dd>
        <dt>Height</dt>
        <dd>
          {footprint.heightMeters.toFixed(1)} m{' '}
          <span className="muted">
            ({HEIGHT_SOURCE_LABEL[extraction.heightSource] ?? extraction.heightSource})
          </span>
        </dd>
        <dt>Footprint</dt>
        <dd>{Math.round(extraction.footprintAreaM2).toLocaleString()} m²</dd>
        <dt>Origin</dt>
        <dd>
          {footprint.origin.lat.toFixed(5)}, {footprint.origin.lon.toFixed(5)}
        </dd>
        <dt>Triangles</dt>
        <dd>{extraction.triangleCount.toLocaleString()}</dd>
      </dl>

      <button className="link" onClick={() => setShowRaw((v) => !v)}>
        {showRaw ? 'Hide' : 'Show'} raw tile properties
      </button>
      {showRaw ? (
        <pre className="raw">{JSON.stringify(extraction.tileProperties, null, 2)}</pre>
      ) : null}

      <button className="secondary" onClick={clearModel}>
        Discard and pick another
      </button>
    </section>
  );
}

export function TransformPanel({
  gizmo,
  onGizmoChange,
}: {
  gizmo: GizmoMode;
  onGizmoChange: (mode: GizmoMode) => void;
}) {
  const editState = useAppStore((s) => s.editHistory.present);
  const setScale = useAppStore((s) => s.setScale);
  const setQuaternion = useAppStore((s) => s.setQuaternion);
  const resetTransform = useAppStore((s) => s.resetTransform);
  const hasModel = useAppStore((s) => s.displayGeometry !== null);

  const [uniform, setUniform] = useState(true);

  // Euler angles are display-only; the quaternion in the store stays canonical
  // so repeated edits cannot accumulate gimbal-lock artefacts.
  const euler = useMemo(() => {
    const q = new Quaternion(...editState.transform.quaternion);
    const e = new Euler().setFromQuaternion(q, 'YXZ');
    return [e.x, e.y, e.z].map((r) => (r * 180) / Math.PI) as [number, number, number];
  }, [editState.transform.quaternion]);

  if (!hasModel) return null;

  const scale = editState.transform.scale;

  const applyScale = (axis: 0 | 1 | 2, value: number) => {
    if (!Number.isFinite(value) || value === 0) return;
    if (uniform) {
      setScale([value, value, value]);
      return;
    }
    const next: [number, number, number] = [...scale];
    next[axis] = value;
    setScale(next);
  };

  const applyEuler = (axis: 0 | 1 | 2, degrees: number) => {
    if (!Number.isFinite(degrees)) return;
    const next = [...euler] as [number, number, number];
    next[axis] = degrees;
    const q = new Quaternion().setFromEuler(
      new Euler(
        (next[0] * Math.PI) / 180,
        (next[1] * Math.PI) / 180,
        (next[2] * Math.PI) / 180,
        'YXZ',
      ),
    );
    setQuaternion([q.x, q.y, q.z, q.w]);
  };

  return (
    <section className="panel">
      <h2>Transform</h2>

      <div className="segmented">
        {(['none', 'scale', 'rotate'] as const).map((mode) => (
          <button
            key={mode}
            className={gizmo === mode ? 'active' : ''}
            onClick={() => onGizmoChange(mode)}
          >
            {mode === 'none' ? 'Off' : mode}
          </button>
        ))}
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={uniform}
          onChange={(e) => setUniform(e.target.checked)}
        />
        Uniform scale
      </label>

      <div className="axis-row">
        {(['X', 'Y', 'Z'] as const).map((label, index) => (
          <label key={label}>
            <span>{label}</span>
            <input
              type="number"
              step="0.05"
              min="0.01"
              value={Number(scale[index]!.toFixed(4))}
              disabled={uniform && index > 0}
              onChange={(e) => applyScale(index as 0 | 1 | 2, Number(e.target.value))}
            />
          </label>
        ))}
      </div>

      <h3>Rotation (degrees)</h3>
      <div className="axis-row">
        {(['X', 'Y', 'Z'] as const).map((label, index) => (
          <label key={label}>
            <span>{label}</span>
            <input
              type="number"
              step="5"
              value={Number(euler[index]!.toFixed(2))}
              onChange={(e) => applyEuler(index as 0 | 1 | 2, Number(e.target.value))}
            />
          </label>
        ))}
      </div>

      <button className="secondary" onClick={resetTransform}>
        Reset transform
      </button>
    </section>
  );
}

export function SlicePanel() {
  const clip = useAppStore((s) => s.clip);
  const setClip = useAppStore((s) => s.setClip);
  const commitCut = useAppStore((s) => s.commitCut);
  const operations = useAppStore((s) => s.editHistory.present.operations);
  const hasModel = useAppStore((s) => s.displayGeometry !== null);

  if (!hasModel) return null;

  return (
    <section className="panel">
      <h2>Slice</h2>
      <p className="hint">
        The preview is non-destructive — it only hides pixels. Committing runs a real
        boolean and caps the opening, which is what gets exported.
      </p>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={clip.enabled}
          onChange={(e) => setClip({ enabled: e.target.checked })}
        />
        Show cutting plane
      </label>

      {clip.enabled ? (
        <>
          <p className="hint">
            Drag the gizmo to position the plane. Press <kbd>R</kbd> to switch between
            moving and tilting it.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={clip.flipped}
              onChange={(e) => setClip({ flipped: e.target.checked })}
            />
            Keep the other side
          </label>
          <div className="button-row">
            <button onClick={commitCut}>Commit cut</button>
            <button
              className="secondary"
              onClick={() =>
                setClip({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], flipped: false })
              }
            >
              Reset plane
            </button>
          </div>
        </>
      ) : null}

      {operations.length > 0 ? (
        <p className="muted">
          {operations.length} cut{operations.length === 1 ? '' : 's'} applied. Undo replays
          from the original extraction.
        </p>
      ) : null}
    </section>
  );
}

export function PlacementPanel() {
  const placement = useAppStore((s) => s.placement);
  const setPlacement = useAppStore((s) => s.setPlacement);
  const setMode = useAppStore((s) => s.setMode);
  const mode = useAppStore((s) => s.mode);
  const geometry = useAppStore((s) => s.displayGeometry);
  const editState = useAppStore((s) => s.editHistory.present);
  const extraction = useAppStore((s) => s.extraction);
  const addPlacedModel = useAppStore((s) => s.addPlacedModel);
  const placedModels = useAppStore((s) => s.placedModels);
  const removePlacedModel = useAppStore((s) => s.removePlacedModel);
  const setStatus = useAppStore((s) => s.setStatus);

  const [busy, setBusy] = useState(false);

  if (!geometry || !extraction) return null;

  const updatePosition = (patch: Partial<Placement['position']>) =>
    setPlacement({ position: { ...placement.position, ...patch } });

  const place = async () => {
    setBusy(true);
    try {
      const scene = buildExportScene(geometry, editState.transform);
      const glb = await exportGlb(scene, { attribution: extraction.attribution });

      addPlacedModel({
        id: crypto.randomUUID(),
        name: extraction.footprint.tags['name'] ?? `${extraction.footprint.osm.type}/${extraction.footprint.osm.id}`,
        glb,
        placement: { ...placement },
        sourceOsm: extraction.footprint.osm,
      });
      setMode('place');
      setStatus({ kind: 'info', text: 'Model placed on the globe.' });
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Placement failed',
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Persist the extraction, the edit state, and the baked mesh.
   *
   * Ordered so the cheap metadata lands first: if the GLB upload fails the
   * model row still exists and the mesh can be regenerated by replaying the
   * saved operation list, so the user's work is not lost.
   */
  const save = async () => {
    setBusy(true);
    try {
      const stored = await api.createExtraction({
        osm: extraction.footprint.osm,
        footprint: extraction.footprint.polygon,
        heightMeters: extraction.footprint.heightMeters,
        minHeightMeters: extraction.footprint.minHeightMeters,
        origin: extraction.footprint.origin,
        tags: extraction.footprint.tags,
      });

      const model = await api.createModel({
        extractionId: stored.id,
        name:
          extraction.footprint.tags['name'] ??
          `${extraction.footprint.osm.type}/${extraction.footprint.osm.id}`,
        editState,
        placement,
      });

      const scene = buildExportScene(geometry, editState.transform);
      const glb = await exportGlb(scene, { attribution: extraction.attribution });
      await api.uploadMesh(model.id, glb);

      setStatus({ kind: 'info', text: `Saved "${model.name}" to your library.` });
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Save failed',
      });
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const scene = buildExportScene(geometry, editState.transform);
      const glb = await exportGlb(scene, { attribution: extraction.attribution });
      downloadGlb(glb, `${extraction.footprint.osm.type}-${extraction.footprint.osm.id}`);
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Export failed',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Placement</h2>

      <button
        className={mode === 'place' ? 'active' : ''}
        onClick={() => setMode(mode === 'place' ? 'select' : 'place')}
      >
        {mode === 'place' ? 'Picking destination — click the globe' : 'Pick destination on globe'}
      </button>

      <div className="axis-row">
        <label>
          <span>Lat</span>
          <input
            type="number"
            step="0.0001"
            value={Number(placement.position.lat.toFixed(6))}
            onChange={(e) => updatePosition({ lat: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>Lon</span>
          <input
            type="number"
            step="0.0001"
            value={Number(placement.position.lon.toFixed(6))}
            onChange={(e) => updatePosition({ lon: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="axis-row">
        <label>
          <span>Alt (m)</span>
          <input
            type="number"
            step="1"
            value={Number(placement.position.alt.toFixed(2))}
            onChange={(e) => updatePosition({ alt: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>Heading°</span>
          <input
            type="number"
            step="5"
            value={Number(placement.headingDeg.toFixed(1))}
            onChange={(e) => setPlacement({ headingDeg: Number(e.target.value) })}
          />
        </label>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={placement.clampToTerrain}
          onChange={(e) => setPlacement({ clampToTerrain: e.target.checked })}
        />
        Drop onto terrain height
      </label>

      <div className="button-row">
        <button onClick={place} disabled={busy}>
          {busy ? 'Working…' : 'Place on globe'}
        </button>
        <button className="secondary" onClick={download} disabled={busy}>
          Export GLB
        </button>
      </div>

      {/* Only offered when a backend is configured — otherwise the app is a
          perfectly usable single-session tool and a dead button is noise. */}
      {api.isEnabled ? (
        <button className="secondary" onClick={save} disabled={busy}>
          Save to my library
        </button>
      ) : null}

      {placedModels.length > 0 ? (
        <>
          <h3>Placed ({placedModels.length})</h3>
          <ul className="placed-list">
            {placedModels.map((model) => (
              <li key={model.id}>
                <span>
                  {model.name}
                  <span className="muted">
                    {' '}
                    {model.placement.position.lat.toFixed(4)},{' '}
                    {model.placement.position.lon.toFixed(4)}
                  </span>
                </span>
                <button className="link" onClick={() => removePlacedModel(model.id)}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/**
 * The block-model workflow: pick an area, single out one building in it, and
 * export a printable model — a base plate plus every building, the singled-
 * out one split into its own STL so it can be printed in a different colour
 * or material from the rest of the block.
 */
export function BlockPanel() {
  const block = useAppStore((s) => s.block);
  const setBlockRadius = useAppStore((s) => s.setBlockRadius);
  const setBlockCenter = useAppStore((s) => s.setBlockCenter);
  const setHighlightBuilding = useAppStore((s) => s.setHighlightBuilding);
  const clearBlock = useAppStore((s) => s.clearBlock);
  const setStatus = useAppStore((s) => s.setStatus);

  const [busy, setBusy] = useState(false);

  const highlighted = block.footprints.find(
    (f) =>
      block.highlightOsm &&
      f.osm.type === block.highlightOsm.type &&
      f.osm.id === block.highlightOsm.id,
  );

  const exportBlock = (kind: 'highlight-stl' | 'rest-stl' | 'glb') => {
    if (!block.center || block.footprints.length === 0) return;
    setBusy(true);
    try {
      const mesh = buildBlockMesh(block.footprints, block.center, block.highlightOsm);
      const base = `block-${block.center.lat.toFixed(4)}-${block.center.lon.toFixed(4)}`;

      if (kind === 'highlight-stl') {
        if (!mesh.highlighted) {
          setStatus({ kind: 'info', text: 'Click a building on the globe to single it out first.' });
          return;
        }
        downloadStl(exportStl(mesh.highlighted), `${base}-highlight`);
      } else if (kind === 'rest-stl') {
        downloadStl(exportStl(mesh.rest), `${base}-block`);
      } else {
        void exportGlb(mesh.preview).then((glb) => downloadGlb(glb, base));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Block model</h2>
      <p className="hint">
        Click the globe to centre a block, then click one building in it to single that
        building out. Export gives you two STL files — the highlighted building and the
        rest of the block — so a printer can run them in different colours.
      </p>

      <label className="axis-row">
        <span>Radius (m)</span>
        <input
          type="number"
          step="10"
          min="20"
          max="500"
          value={block.radiusM}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (!Number.isFinite(value) || value <= 0) return;
            setBlockRadius(value);
            if (block.center) void setBlockCenter(block.center);
          }}
        />
      </label>

      {block.center ? (
        <dl className="facts">
          <dt>Centre</dt>
          <dd>
            {block.center.lat.toFixed(5)}, {block.center.lon.toFixed(5)}
          </dd>
          <dt>Buildings</dt>
          <dd>{block.footprints.length}</dd>
          <dt>Singled out</dt>
          <dd>
            {highlighted
              ? highlighted.tags['name'] ?? `${highlighted.osm.type}/${highlighted.osm.id}`
              : 'none yet'}
          </dd>
        </dl>
      ) : (
        <p className="hint">No area picked yet.</p>
      )}

      {block.center && block.footprints.length > 0 ? (
        <div className="block-preview">
          <BlockView />
        </div>
      ) : null}

      {block.highlightOsm ? (
        <button className="link" onClick={() => setHighlightBuilding(null)}>
          Clear singled-out building
        </button>
      ) : null}

      <div className="button-row">
        <button
          onClick={() => exportBlock('highlight-stl')}
          disabled={busy || !block.highlightOsm}
        >
          Export highlighted (STL)
        </button>
        <button
          className="secondary"
          onClick={() => exportBlock('rest-stl')}
          disabled={busy || block.footprints.length === 0}
        >
          Export block (STL)
        </button>
      </div>
      <button
        className="secondary"
        onClick={() => exportBlock('glb')}
        disabled={busy || block.footprints.length === 0}
      >
        Export preview (GLB)
      </button>

      {block.center ? (
        <button className="secondary" onClick={clearBlock}>
          Clear block
        </button>
      ) : null}
    </section>
  );
}
