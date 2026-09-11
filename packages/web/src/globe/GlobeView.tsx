/**
 * The Cesium globe: source picking, destination picking, and rendering placed
 * models.
 *
 * One `Viewer` instance serves both ends of the workflow, switched by `mode`.
 * Two viewers would double the ion streaming cost and the GPU memory for no
 * real gain, and the plan calls for exactly this trade.
 */

import { useEffect, useRef } from 'react';
import {
  Cartesian3,
  Cesium3DTileFeature,
  Cesium3DTileStyle,
  Cesium3DTileset,
  Color,
  Ion,
  Math as CesiumMath,
  Model,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Terrain,
  Viewer,
  type Scene,
} from 'cesium';
// Cesium's widget stylesheet is injected by vite-plugin-cesium, which links it
// from the copied Build output — importing it here too would ship it twice.
import { config } from '../config.js';
import { readTileFeature } from '../osm/tileFeature.js';
import { buildModelMatrix, clampAltitudeToTerrain, pickGroundPosition } from './placement.js';
import { useAppStore, type PlacedModel } from '../state/store.js';

/** Highlight applied to the building under the cursor in select mode. */
const HOVER_COLOR = Color.CYAN.withAlpha(0.6);

export function GlobeView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const hoveredRef = useRef<Cesium3DTileFeature | null>(null);
  const placedRef = useRef(new Map<string, Model>());

  // `mode` is read through a ref inside the Cesium event handler so that
  // switching modes does not require tearing down and rebuilding the viewer.
  const mode = useAppStore((s) => s.mode);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const placedModels = useAppStore((s) => s.placedModels);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (config.ionToken) {
      Ion.defaultAccessToken = config.ionToken;
    }

    const viewer = new Viewer(container, {
      // World terrain needs ion; without a token fall back to a smooth
      // ellipsoid so the app still runs and says why.
      terrain: config.ionEnabled ? Terrain.fromWorldTerrain() : undefined,
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      baseLayerPicker: config.ionEnabled,
      // Needed for scene.pickPosition, which is how destination clicks resolve
      // against terrain and buildings rather than the bare ellipsoid.
      requestRenderMode: false,
    });
    viewerRef.current = viewer;

    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(-122.4194, 37.7649, 2500),
      orientation: { heading: 0, pitch: CesiumMath.toRadians(-35), roll: 0 },
      duration: 0,
    });

    let tileset: Cesium3DTileset | null = null;
    let disposed = false;

    if (config.ionEnabled) {
      Cesium3DTileset.fromIonAssetId(config.osmBuildingsAssetId)
        .then((loaded) => {
          if (disposed) {
            loaded.destroy();
            return;
          }
          tileset = loaded;
          viewer.scene.primitives.add(loaded);
          // A flat, unlit style keeps picked-feature highlighting legible.
          loaded.style = new Cesium3DTileStyle({
            color: "color('#d8dde6')",
          });
        })
        .catch((error: unknown) => {
          useAppStore.getState().setStatus({
            kind: 'error',
            text: `Could not load OSM Buildings (ion asset ${config.osmBuildingsAssetId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        });
    } else {
      useAppStore.getState().setStatus({
        kind: 'error',
        text: 'No Cesium ion token configured. Set VITE_CESIUM_ION_TOKEN in packages/web/.env to load OSM Buildings and terrain.',
      });
    }

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((movement: { endPosition: { x: number; y: number } }) => {
      if (modeRef.current !== 'select' && modeRef.current !== 'block') return;

      // Restore the previously hovered building before highlighting a new one.
      if (hoveredRef.current) {
        hoveredRef.current.color = Color.WHITE;
        hoveredRef.current = null;
      }

      const picked: unknown = viewer.scene.pick(movement.endPosition as never);
      if (picked instanceof Cesium3DTileFeature) {
        picked.color = HOVER_COLOR;
        hoveredRef.current = picked;
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((click: { position: { x: number; y: number } }) => {
      const currentMode = modeRef.current;

      if (currentMode === 'place') {
        handleDestinationClick(viewer.scene, click.position);
        return;
      }
      if (currentMode === 'block') {
        handleBlockClick(viewer.scene, click.position);
        return;
      }
      if (currentMode !== 'select') return;

      const picked: unknown = viewer.scene.pick(click.position as never);
      if (!(picked instanceof Cesium3DTileFeature)) {
        useAppStore.getState().setStatus({
          kind: 'info',
          text: 'That is not a building. Click a building in the OSM Buildings layer.',
        });
        return;
      }

      const reading = readTileFeature(picked);
      if (!reading.ref) {
        useAppStore.getState().setStatus({
          kind: 'error',
          text: reading.problem ?? 'This building carries no OSM id.',
        });
        return;
      }

      void useAppStore
        .getState()
        .selectBuilding(reading.ref, reading.tileHeight, reading.properties);
    }, ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      disposed = true;
      handler.destroy();
      for (const model of placedRef.current.values()) {
        if (!model.isDestroyed()) viewer.scene.primitives.remove(model);
      }
      placedRef.current.clear();
      if (tileset && !tileset.isDestroyed()) {
        viewer.scene.primitives.remove(tileset);
      }
      if (!viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // Sync placed models into the scene as they are added and removed.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    const live = placedRef.current;
    const wanted = new Set(placedModels.map((m) => m.id));

    for (const [id, model] of live) {
      if (!wanted.has(id)) {
        if (!model.isDestroyed()) viewer.scene.primitives.remove(model);
        live.delete(id);
      }
    }

    for (const placed of placedModels) {
      if (live.has(placed.id)) {
        // Existing model: just refresh its transform so slider edits are live.
        const model = live.get(placed.id)!;
        if (!model.isDestroyed()) {
          model.modelMatrix = buildModelMatrix(placed.placement);
        }
        continue;
      }
      void addPlacedModel(viewer, placed, live);
    }
  }, [placedModels]);

  return <div className="globe" ref={containerRef} data-mode={mode} />;
}

/**
 * Load a placed model's GLB into the scene.
 *
 * The GLB lives in memory as an ArrayBuffer, so it is handed to Cesium through
 * a blob URL. The URL is revoked as soon as the model has finished loading —
 * Cesium has copied the data into GPU buffers by then.
 */
async function addPlacedModel(
  viewer: Viewer,
  placed: PlacedModel,
  live: Map<string, Model>,
): Promise<void> {
  const url = URL.createObjectURL(new Blob([placed.glb], { type: 'model/gltf-binary' }));
  try {
    const model = await Model.fromGltfAsync({
      url,
      modelMatrix: buildModelMatrix(placed.placement),
      // The mesh is authored in metres and georeferenced by the model matrix,
      // so no scaling and no automatic terrain clamping.
      scale: 1,
      id: placed.id,
    });

    if (viewer.isDestroyed()) return;
    viewer.scene.primitives.add(model);
    live.set(placed.id, model);
  } catch (error) {
    useAppStore.getState().setStatus({
      kind: 'error',
      text: `Failed to place the model on the globe: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A click in block mode does one of two things, disambiguated by what got
 * picked: hitting a building tile singles that building out (reusing the same
 * `readTileFeature` path as `select` mode), hitting bare terrain re-centres
 * the block area there. This mirrors `select`/`place` mode's own click
 * handling rather than introducing a second, separate interaction to draw a
 * rectangle.
 */
function handleBlockClick(scene: Scene, position: { x: number; y: number }): void {
  const store = useAppStore.getState();
  const picked: unknown = scene.pick(position as never);

  if (picked instanceof Cesium3DTileFeature) {
    const reading = readTileFeature(picked);
    if (!reading.ref) {
      store.setStatus({
        kind: 'error',
        text: reading.problem ?? 'This building carries no OSM id.',
      });
      return;
    }
    store.setHighlightBuilding(reading.ref);
    store.setStatus({
      kind: 'info',
      text: `Singled out ${reading.ref.type} ${reading.ref.id}.`,
    });
    return;
  }

  const ground = pickGroundPosition(scene, position);
  if (!ground) {
    store.setStatus({
      kind: 'info',
      text: 'Could not resolve that click to a point on the globe. Try clicking on terrain.',
    });
    return;
  }

  void store.setBlockCenter(ground);
}

/** Resolve a destination click to a georeferenced placement. */
function handleDestinationClick(scene: Scene, position: { x: number; y: number }): void {
  const store = useAppStore.getState();
  const ground = pickGroundPosition(scene, position);

  if (!ground) {
    store.setStatus({
      kind: 'info',
      text: 'Could not resolve that click to a point on the globe. Try clicking on terrain.',
    });
    return;
  }

  const target = store.placement.clampToTerrain
    ? clampAltitudeToTerrain(scene, { ...ground, alt: 0 })
    : ground;

  store.setPlacement({ position: target });
  store.setStatus({
    kind: 'info',
    text: `Destination set to ${target.lat.toFixed(5)}, ${target.lon.toFixed(5)} at ${target.alt.toFixed(1)} m`,
  });
}
