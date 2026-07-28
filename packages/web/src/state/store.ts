/**
 * Application state.
 *
 * The pipeline the store encodes is: pick a building on the globe -> fetch its
 * footprint -> extrude a raw mesh -> edit it -> place it back on the globe.
 *
 * The one invariant worth stating up front: `rawGeometry` is never modified.
 * Every edit is recorded in `editHistory` as a transform plus an ordered list of
 * cuts, and `displayGeometry` is regenerated from the raw mesh by replaying that
 * list. Undo is therefore just "step the history back and replay", with no
 * inverse-CSG anywhere.
 */

import { BufferGeometry, Quaternion, Vector3 } from 'three';
import { create } from 'zustand';
import type {
  BuildingFootprint,
  EditState,
  HeightSource,
  OsmRef,
  Placement,
} from '@gme/shared';
import { OSM_ATTRIBUTION } from '@gme/shared';
import { config } from '../config.js';
import { createFootprintSource, type FootprintSource } from '../osm/footprintSource.js';
import { buildExtrusion } from '../mesh/extrude.js';
import { operationFromWidget, replayOperations } from '../editor/csg.js';
import {
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  commit,
  createHistory,
  redo as historyRedo,
  resetHistory,
  undo as historyUndo,
  type HistoryState,
} from '../editor/history.js';

export type Mode = 'select' | 'edit' | 'place';

export interface StatusMessage {
  kind: 'idle' | 'busy' | 'error' | 'info';
  text: string;
}

export interface ExtractionInfo {
  footprint: BuildingFootprint;
  heightSource: HeightSource;
  attribution: string;
  /** Raw tile-feature properties, shown in the metadata panel. */
  tileProperties: Record<string, unknown>;
  footprintAreaM2: number;
  triangleCount: number;
}

/** Live, non-destructive clipping-plane preview state. */
export interface ClipPreview {
  enabled: boolean;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  /** Which side of the plane is discarded. */
  flipped: boolean;
}

export interface PlacedModel {
  id: string;
  name: string;
  glb: ArrayBuffer;
  placement: Placement;
  sourceOsm: OsmRef;
}

const IDENTITY_EDIT: EditState = {
  transform: { scale: [1, 1, 1], quaternion: [0, 0, 0, 1] },
  operations: [],
};

const DEFAULT_CLIP: ClipPreview = {
  enabled: false,
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  flipped: false,
};

interface AppState {
  mode: Mode;
  status: StatusMessage;

  extraction: ExtractionInfo | null;
  /** Pristine extruded mesh. Treated as immutable. */
  rawGeometry: BufferGeometry | null;
  /** Geometry after replaying the current operation list. What gets rendered. */
  displayGeometry: BufferGeometry | null;

  editHistory: HistoryState<EditState>;
  clip: ClipPreview;

  placement: Placement;
  placedModels: PlacedModel[];

  // Derived helpers, kept as plain functions for component convenience.
  canUndo: () => boolean;
  canRedo: () => boolean;
  editState: () => EditState;

  setMode: (mode: Mode) => void;
  setStatus: (status: StatusMessage) => void;

  selectBuilding: (ref: OsmRef, tileHeight: number | null, tileProperties: Record<string, unknown>) => Promise<void>;

  setScale: (scale: [number, number, number], gestureId?: string) => void;
  setQuaternion: (q: [number, number, number, number], gestureId?: string) => void;
  resetTransform: () => void;

  setClip: (patch: Partial<ClipPreview>) => void;
  commitCut: () => void;

  undo: () => void;
  redo: () => void;
  clearModel: () => void;

  setPlacement: (patch: Partial<Placement>) => void;
  addPlacedModel: (model: PlacedModel) => void;
  removePlacedModel: (id: string) => void;
}

let footprintSource: FootprintSource | null = null;
function getFootprintSource(): FootprintSource {
  if (!footprintSource) footprintSource = createFootprintSource(config.apiBaseUrl);
  return footprintSource;
}

/** Test seam: lets the store be driven without touching the network. */
export function __setFootprintSource(source: FootprintSource | null): void {
  footprintSource = source;
}

export const useAppStore = create<AppState>((set, get) => {
  /**
   * Regenerate the rendered geometry for an edit state, disposing whatever it
   * replaces. Replay is only needed when the *operation list* changes — scale
   * and rotation are node transforms and never touch the vertex data.
   */
  const applyEdit = (
    next: EditState,
    options: { gestureId?: string; replayGeometry: boolean },
  ) => {
    const state = get();
    const history = commit(state.editHistory, next, {
      coalesceKey: options.gestureId,
    });

    if (!options.replayGeometry || !state.rawGeometry) {
      set({ editHistory: history });
      return;
    }

    try {
      const geometry = replayOperations(state.rawGeometry, next.operations);
      state.displayGeometry?.dispose();
      set({
        editHistory: history,
        displayGeometry: geometry,
        status: { kind: 'idle', text: '' },
      });
    } catch (error) {
      set({
        status: {
          kind: 'error',
          text: error instanceof Error ? error.message : 'Failed to apply the cut',
        },
      });
    }
  };

  return {
    mode: 'select',
    status: { kind: 'idle', text: '' },

    extraction: null,
    rawGeometry: null,
    displayGeometry: null,

    editHistory: createHistory(IDENTITY_EDIT),
    clip: DEFAULT_CLIP,

    placement: {
      position: { lon: 0, lat: 0, alt: 0 },
      headingDeg: 0,
      clampToTerrain: true,
    },
    placedModels: [],

    canUndo: () => historyCanUndo(get().editHistory),
    canRedo: () => historyCanRedo(get().editHistory),
    editState: () => get().editHistory.present,

    setMode: (mode) => set({ mode }),
    setStatus: (status) => set({ status }),

    selectBuilding: async (ref, tileHeight, tileProperties) => {
      set({
        status: {
          kind: 'busy',
          text: `Fetching footprint for ${ref.type} ${ref.id}…`,
        },
      });

      try {
        const response = await getFootprintSource().fetchFootprint({ ref, tileHeight });
        const extrusion = buildExtrusion(response.footprint);

        // Replace any previous model wholesale — the editor works on one
        // building at a time.
        const previous = get();
        previous.rawGeometry?.dispose();
        previous.displayGeometry?.dispose();

        set({
          extraction: {
            footprint: response.footprint,
            heightSource: response.heightSource,
            attribution: response.attribution || OSM_ATTRIBUTION,
            tileProperties,
            footprintAreaM2: extrusion.footprintAreaM2,
            triangleCount: extrusion.triangleCount,
          },
          rawGeometry: extrusion.geometry,
          displayGeometry: extrusion.geometry.clone(),
          editHistory: resetHistory(createHistory(IDENTITY_EDIT), IDENTITY_EDIT),
          clip: DEFAULT_CLIP,
          mode: 'edit',
          status: {
            kind: 'info',
            text: `Extracted ${ref.type} ${ref.id} — ${Math.round(extrusion.footprintAreaM2)} m² footprint, ${extrusion.heightMeters.toFixed(1)} m tall`,
          },
        });
      } catch (error) {
        set({
          status: {
            kind: 'error',
            text: error instanceof Error ? error.message : 'Footprint lookup failed',
          },
        });
      }
    },

    setScale: (scale, gestureId) => {
      const current = get().editHistory.present;
      applyEdit(
        { ...current, transform: { ...current.transform, scale } },
        { gestureId, replayGeometry: false },
      );
    },

    setQuaternion: (quaternion, gestureId) => {
      const current = get().editHistory.present;
      applyEdit(
        { ...current, transform: { ...current.transform, quaternion } },
        { gestureId, replayGeometry: false },
      );
    },

    resetTransform: () => {
      const current = get().editHistory.present;
      applyEdit(
        { ...current, transform: IDENTITY_EDIT.transform },
        { replayGeometry: false },
      );
    },

    setClip: (patch) => set({ clip: { ...get().clip, ...patch } }),

    /**
     * Turn the live clipping-plane preview into permanent geometry.
     *
     * The widget's transform is captured as a plane in the mesh's local space
     * and appended to the operation list; the geometry is then regenerated by
     * replaying the whole list. The preview is switched off afterwards, because
     * leaving it on would clip the newly capped face it just created.
     */
    commitCut: () => {
      const state = get();
      if (!state.rawGeometry || !state.clip.enabled) return;

      const operation = operationFromWidget(
        new Vector3(...state.clip.position),
        new Quaternion(...state.clip.quaternion),
        state.clip.flipped,
      );

      const current = state.editHistory.present;
      applyEdit(
        { ...current, operations: [...current.operations, operation] },
        { replayGeometry: true },
      );

      if (get().status.kind !== 'error') {
        set({ clip: { ...DEFAULT_CLIP } });
      }
    },

    undo: () => {
      const state = get();
      const history = historyUndo(state.editHistory);
      if (history === state.editHistory) return;

      if (state.rawGeometry) {
        try {
          const geometry = replayOperations(state.rawGeometry, history.present.operations);
          state.displayGeometry?.dispose();
          set({ editHistory: history, displayGeometry: geometry });
          return;
        } catch {
          // Replay of a previously valid state should not fail; fall through
          // and at least restore the transform.
        }
      }
      set({ editHistory: history });
    },

    redo: () => {
      const state = get();
      const history = historyRedo(state.editHistory);
      if (history === state.editHistory) return;

      if (state.rawGeometry) {
        try {
          const geometry = replayOperations(state.rawGeometry, history.present.operations);
          state.displayGeometry?.dispose();
          set({ editHistory: history, displayGeometry: geometry });
          return;
        } catch {
          /* fall through */
        }
      }
      set({ editHistory: history });
    },

    clearModel: () => {
      const state = get();
      state.rawGeometry?.dispose();
      state.displayGeometry?.dispose();
      set({
        extraction: null,
        rawGeometry: null,
        displayGeometry: null,
        editHistory: createHistory(IDENTITY_EDIT),
        clip: DEFAULT_CLIP,
        mode: 'select',
        status: { kind: 'idle', text: '' },
      });
    },

    setPlacement: (patch) => set({ placement: { ...get().placement, ...patch } }),

    addPlacedModel: (model) =>
      set({ placedModels: [...get().placedModels, model] }),

    removePlacedModel: (id) =>
      set({ placedModels: get().placedModels.filter((m) => m.id !== id) }),
  };
});
