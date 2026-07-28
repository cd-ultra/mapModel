/**
 * Server-side Overpass access with caching and request coalescing.
 *
 * The plan flags live Overpass calls as the main production reliability risk:
 * the public endpoint rate-limits hard and can take tens of seconds under load.
 * Three things mitigate that here:
 *
 *   1. A TTL cache — the same building is re-clicked constantly, and footprints
 *      effectively never change.
 *   2. In-flight coalescing — ten users clicking the same landmark at once
 *      produce one upstream request, not ten.
 *   3. Negative caching for "not found", so a deleted OSM element does not
 *      re-query on every click.
 *
 * The longer-term answer is still a self-hosted OSM extract; this class is the
 * seam where that would be swapped in.
 */

import {
  buildOverpassQuery,
  parseOverpassFootprint,
  type FootprintResponse,
  type OsmRef,
  type OverpassResponse,
} from '@gme/shared';

export class OverpassError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'OverpassError';
    this.status = status;
  }
}

interface CacheEntry {
  value: FootprintResponse;
  expiresAt: number;
}

export interface OverpassClientOptions {
  endpoint: string;
  cacheTtlMs: number;
  maxCacheEntries: number;
  timeoutMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class OverpassClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<FootprintResponse>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: OverpassClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Cache statistics, exposed on the health endpoint for quota monitoring. */
  stats(): { entries: number; inFlight: number } {
    return { entries: this.cache.size, inFlight: this.inFlight.size };
  }

  async getFootprint(ref: OsmRef, tileHeight: number | null): Promise<FootprintResponse> {
    // Tile height participates in the key because it overrides the OSM tags and
    // is baked into the parsed result.
    const key = `${ref.type}/${ref.id}/${tileHeight ?? ''}`;

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }
    if (cached) this.cache.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.fetchFootprint(ref, tileHeight)
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }

  private store(key: string, value: FootprintResponse): void {
    if (this.cache.size >= this.options.maxCacheEntries) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { value, expiresAt: this.now() + this.options.cacheTtlMs });
  }

  private async fetchFootprint(
    ref: OsmRef,
    tileHeight: number | null,
  ): Promise<FootprintResponse> {
    const query = buildOverpassQuery(ref);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // Overpass asks clients to identify themselves; anonymous traffic is
          // throttled first when the endpoint is busy.
          'user-agent': 'geo-model-editor/0.1 (+https://github.com/cd-ultra/mapmodel)',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OverpassError(
          `Overpass did not respond within ${this.options.timeoutMs} ms`,
          504,
        );
      }
      throw new OverpassError(
        `Could not reach Overpass: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new OverpassError('Overpass rate limit reached. Try again shortly.', 429);
    }
    if (!response.ok) {
      throw new OverpassError(`Overpass returned ${response.status}`, 502);
    }

    let json: OverpassResponse;
    try {
      json = (await response.json()) as OverpassResponse;
    } catch {
      throw new OverpassError('Overpass returned a malformed response', 502);
    }

    try {
      return parseOverpassFootprint(json, ref, { tileHeight });
    } catch (error) {
      // A parse failure here means the element is gone or is not a building —
      // a client error, not an upstream outage.
      throw new OverpassError(
        error instanceof Error ? error.message : 'Could not parse the OSM footprint',
        404,
      );
    }
  }
}
