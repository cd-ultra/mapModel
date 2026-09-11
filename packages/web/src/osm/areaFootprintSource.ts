/**
 * Fetching every building footprint inside a bounding box — the block-model
 * path, as opposed to `footprintSource.ts`'s single picked building.
 *
 * There is deliberately no server-proxied variant yet: an area query can
 * return hundreds of elements, and caching that sensibly (by tile, not by id)
 * is a bigger piece of work than this feature needs to ship. This talks
 * straight to the public Overpass endpoint, same as `OverpassFootprintSource`
 * does with no backend configured, and carries the same "not for production
 * traffic" caveat.
 */

import {
  DEFAULT_OVERPASS_ENDPOINT,
  buildOverpassBboxQuery,
  parseOverpassAreaFootprints,
  type AreaFootprint,
  type BboxDegrees,
  type OverpassResponse,
} from '@gme/shared';
import { FootprintFetchError } from './footprintSource.js';

export interface AreaFootprintRequest {
  bbox: BboxDegrees;
  signal?: AbortSignal;
}

/** Overpass caps element counts per query; a block this size is already a lot to print. */
const MAX_BUILDINGS = 500;

export async function fetchAreaFootprints(
  request: AreaFootprintRequest,
  endpoint: string = DEFAULT_OVERPASS_ENDPOINT,
): Promise<AreaFootprint[]> {
  const query = buildOverpassBboxQuery(request.bbox);

  const response = await fetch(endpoint, {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
    signal: request.signal ?? null,
  });

  if (!response.ok) {
    throw new FootprintFetchError(
      `Overpass returned ${response.status} for the area query. Try a smaller radius.`,
      { status: response.status, retryable: response.status === 429 || response.status >= 502 },
    );
  }

  const json = (await response.json()) as OverpassResponse;
  const footprints = parseOverpassAreaFootprints(json);

  if (footprints.length > MAX_BUILDINGS) {
    throw new FootprintFetchError(
      `Found ${footprints.length} buildings, which is more than this app will mesh at once (${MAX_BUILDINGS}). Try a smaller radius.`,
    );
  }

  return footprints;
}
