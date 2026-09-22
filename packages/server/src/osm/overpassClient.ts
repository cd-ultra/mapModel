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
  isRetryableOverpassStatus,
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
  /** Injectable for tests — real delay by default. */
  sleep?: (ms: number) => Promise<void>;
}

/** Attempts for a single footprint fetch, including the first try. */
const MAX_ATTEMPTS = 3;

export class OverpassClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<FootprintResponse>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OverpassClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  /**
   * A complex building — a cathedral's multipolygon, a stepped tower modelled
   * as many parts — asks Overpass to resolve more geometry than a plain box,
   * and the public instance's own processing budget is shared with every
   * other client hitting it. That shows up as a 429/502/503/504 that clears
   * up moments later, not a hard failure — so a retryable response status is
   * retried here rather than turned into an error on the first attempt.
   *
   * Deliberately not extended to an aborted request (our own timeout) or a
   * network exception: both already waited out the full `timeoutMs` budget
   * once, and stacking that same wait on top via retries would make a real
   * outage take minutes to report instead of seconds.
   */
  private async fetchFootprint(
    ref: OsmRef,
    tileHeight: number | null,
  ): Promise<FootprintResponse> {
    const query = buildOverpassQuery(ref);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        // 1s, 2s — enough for a load spike to pass without a tight retry loop.
        await this.sleep(1000 * 2 ** (attempt - 1));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

      let response: Response;
      try {
        response = await this.fetchImpl(this.options.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            // Overpass asks clients to identify themselves; anonymous traffic
            // is throttled first when the endpoint is busy.
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

      if (!response.ok) {
        const willRetry = isRetryableOverpassStatus(response.status) && attempt < MAX_ATTEMPTS - 1;
        if (willRetry) continue;
        if (response.status === 429) {
          throw new OverpassError('Overpass rate limit reached. Try again shortly.', 429);
        }
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
        // A parse failure here means the element is gone or is not a
        // building — a client error, not an upstream outage. Not retryable.
        throw new OverpassError(
          error instanceof Error ? error.message : 'Could not parse the OSM footprint',
          404,
        );
      }
    }

    // Unreachable: the loop body always returns or throws before exhausting
    // its attempts. Satisfies the compiler's control-flow analysis.
    throw new OverpassError('Overpass request failed');
  }
}
