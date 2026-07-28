import { useEffect, useState } from 'react';
import { OSM_ATTRIBUTION } from '@gme/shared';
import { GlobeView } from './globe/GlobeView.js';
import { EditorView, type GizmoMode } from './editor/EditorView.js';
import {
  ExtractionPanel,
  PlacementPanel,
  SlicePanel,
  TransformPanel,
} from './ui/Panels.jsx';
import { useAppStore } from './state/store.js';
import { config } from './config.js';

export default function App() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const status = useAppStore((s) => s.status);
  const hasModel = useAppStore((s) => s.displayGeometry !== null);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const canUndo = useAppStore((s) => s.editHistory.past.length > 0);
  const canRedo = useAppStore((s) => s.editHistory.future.length > 0);

  const [gizmo, setGizmo] = useState<GizmoMode>('scale');

  // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z, skipped while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;

      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Geo Model Editor</h1>

        <nav className="segmented">
          <button
            className={mode === 'select' ? 'active' : ''}
            onClick={() => setMode('select')}
          >
            1 · Select
          </button>
          <button
            className={mode === 'edit' ? 'active' : ''}
            onClick={() => setMode('edit')}
            disabled={!hasModel}
          >
            2 · Edit
          </button>
          <button
            className={mode === 'place' ? 'active' : ''}
            onClick={() => setMode('place')}
            disabled={!hasModel}
          >
            3 · Place
          </button>
        </nav>

        <div className="topbar-actions">
          <button className="secondary" onClick={undo} disabled={!canUndo}>
            Undo
          </button>
          <button className="secondary" onClick={redo} disabled={!canRedo}>
            Redo
          </button>
        </div>
      </header>

      <main className="workspace">
        {/* Both views stay mounted: rebuilding the Cesium viewer or the WebGL
            editor context on every mode switch is slow and loses camera state. */}
        <div className="stage" data-active={mode === 'edit' ? 'editor' : 'globe'}>
          <div className="layer" data-visible={mode !== 'edit'}>
            <GlobeView />
          </div>
          <div className="layer" data-visible={mode === 'edit'}>
            {hasModel ? (
              <EditorView gizmo={gizmo} />
            ) : (
              <div className="empty">Extract a building first.</div>
            )}
          </div>
        </div>

        <aside className="sidebar">
          <ExtractionPanel />
          <TransformPanel gizmo={gizmo} onGizmoChange={setGizmo} />
          <SlicePanel />
          <PlacementPanel />
        </aside>
      </main>

      <footer className="statusbar">
        <span className={`status status-${status.kind}`}>
          {status.kind === 'busy' ? '⋯ ' : ''}
          {status.text || readyMessage(mode)}
        </span>
        {/* ODbL requires attribution wherever the data is shown. */}
        <span className="attribution">{OSM_ATTRIBUTION}</span>
      </footer>
    </div>
  );
}

function readyMessage(mode: string): string {
  if (!config.ionEnabled) {
    return 'Set VITE_CESIUM_ION_TOKEN to load the globe.';
  }
  switch (mode) {
    case 'select':
      return 'Click a building on the globe to extract it.';
    case 'edit':
      return 'Scale, rotate, and slice the extracted mesh.';
    case 'place':
      return 'Click the globe to choose where the model goes.';
    default:
      return '';
  }
}
