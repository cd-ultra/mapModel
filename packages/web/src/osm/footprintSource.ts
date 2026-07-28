/**
 * Fetching building footprints for a picked OSM element.
 *
 * Two interchangeable sources:
 *
 * - `ServerFootprintSource` calls our own API, which caches and rate-limits on
 *   our behalf. This is the production path — Overpass's public endpoint is
 *   explicitly not meant to back interactive apps.
 * - `OverpassFootprintSource` talks to Overpass directly from the browser. It
 *   exists so the app is useful with no backend running, and because Overpass
 *   does send permissive CORS headers. Not for production traffic.
 *
 * Which one is used is decided by `createFootprintSource` from configuration,
 * so the rest of the app never branches on it.
 */

import {
  DEFAULT_OVERPASS_ENDPOINT,
  buildOverpassQuery,
  parseOverpassFootprint,
  type FootprintResponse,
  type OsmRef,
  type OverpassResponse,
} from '@gme/shared';

export interface FootprintRequest {
  ref: OsmRef;
  /** Height Cesium drew this building at, preferred over OSM tags. */
  tileHeight?: number | null;
  signal?: AbortSignal;
}

export interface FootprintSource {
  readonly kind: 'server' | 'overpass';
  fetchFootprint(request: FootprintRequest): Promise<FootprintResponse>;
}

export class FootprintFetchError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'FootprintFetchError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Overpass answers overload with 429 and 504. Both clear up on their own, so
 * they are worth retrying with backoff; everything else is surfaced at once.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export class OverpassFootprintSource implements FootprintSource {
  readonly kind = 'overpass' as const;

  constructor(
    private readonly endpoint: string = DEFAULT_OVERPASS_ENDPOINT,
    private readonly maxAttempts = 3,
  ) {}

  async fetchFootprint(request: FootprintRequest): Promise<FootprintResponse> {
    const query = buildOverpassQuery(request.ref);
    let lastError: FootprintFetchError | null = null;

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) {
        // 1s, 2s — Overpass asks for a slow retry, not a tight loop.
        await delay(1000 * 2 ** (attempt - 1), request.signal);
      }

      const response = await fetch(this.endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: request.signal ?? null,
      });

      if (!response.ok) {
        const retryable = isRetryableStatus(response.status);
        lastError = new FootprintFetchError(
          `Overpass returned ${response.status}. The public endpoint rate-limits aggressively; configure VITE_API_BASE_URL to use the cached server proxy instead.`,
          { status: response.status, retryable },
        );
        if (!retryable) throw lastError;
        continue;
      }

      const json = (await response.json()) as OverpassResponse;
      return parseOverpassFootprint(json, request.ref, {
        tileHeight: request.tileHeight ?? null,
      });
    }

    throw lastError ?? new FootprintFetchError('Overpass request failed');
  }
}

export class ServerFootprintSource implements FootprintSource {
  readonly kind = 'server' as const;

  constructor(private readonly baseUrl: string) {}

  async fetchFootprint(request: FootprintRequest): Promise<FootprintResponse> {
    const url = new URL(`${this.baseUrl.replace(/\/$/, '')}/api/osm/footprint`, location.origin);
    url.searchParams.set('type', request.ref.type);
    url.searchParams.set('id', String(request.ref.id));
    if (typeof request.tileHeight === 'number') {
      url.searchParams.set('tileHeight', String(request.tileHeight));
    }

    const response = await fetch(url, { signal: request.signal ?? null });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new FootprintFetchError(
        `Footprint service returned ${response.status}${detail ? `: ${detail}` : ''}`,
        { status: response.status, retryable: isRetryableStatus(response.status) },
      );
    }
    return (await response.json()) as FootprintResponse;
  }
}

/**
 * An in-memory memoiser. Users click the same building repeatedly while
 * framing a shot, and each miss is a full Overpass round trip.
 */
export class CachingFootprintSource implements FootprintSource {
  private readonly cache = new Map<string, Promise<FootprintResponse>>();

  constructor(private readonly inner: FootprintSource, private readonly maxEntries = 64) {}

  get kind() {
    return this.inner.kind;
  }

  fetchFootprint(request: FootprintRequest): Promise<FootprintResponse> {
    const key = `${request.ref.type}/${request.ref.id}/${request.tileHeight ?? ''}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const pending = this.inner.fetchFootprint(request).catch((error: unknown) => {
      // Never cache a failure: the next click should retry.
      this.cache.delete(key);
      throw error;
    });

    this.cache.set(key, pending);
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    return pending;
  }
}

export function createFootprintSource(apiBaseUrl: string | undefined): FootprintSource {
  const inner: FootprintSource = apiBaseUrl
    ? new ServerFootprintSource(apiBaseUrl)
    : new OverpassFootprintSource();
  return new CachingFootprintSource(inner);
}
