/**
 * Runtime configuration, read once from Vite env vars.
 *
 * Everything here has a working default except the Cesium ion token: without
 * one, ion asset streaming (OSM Buildings, world terrain, Bing imagery) is
 * unavailable, so the app degrades to an offline ellipsoid rather than failing
 * to boot — a blank globe with an explanatory banner is far easier to diagnose
 * than a white screen.
 */

export interface AppConfig {
  /** Cesium ion access token. Empty string means "not configured". */
  ionToken: string;
  /** Cesium ion asset id for OSM Buildings. */
  osmBuildingsAssetId: number;
  /** Base URL of our API. Empty means "no backend, talk to Overpass directly". */
  apiBaseUrl: string;
  /** Whether ion-backed assets can be used at all. */
  ionEnabled: boolean;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config: AppConfig = {
  ionToken: import.meta.env.VITE_CESIUM_ION_TOKEN ?? '',
  // 96188 is Cesium ion's global OSM Buildings tileset.
  osmBuildingsAssetId: readNumber(import.meta.env.VITE_OSM_BUILDINGS_ASSET_ID, 96188),
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
  get ionEnabled() {
    return this.ionToken.length > 0;
  },
};
