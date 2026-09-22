import { describe, expect, it, vi } from 'vitest';
import { OverpassClient, OverpassError } from './overpassClient.js';
import type { OsmRef } from '@gme/shared';

const REF: OsmRef = { id: 24950831, type: 'way' };

const SQUARE = [
  { lon: -122.4194, lat: 37.7749 },
  { lon: -122.4192, lat: 37.7749 },
  { lon: -122.4192, lat: 37.7751 },
  { lon: -122.4194, lat: 37.7751 },
  { lon: -122.4194, lat: 37.7749 },
];

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const goodPayload = {
  elements: [{ type: 'way', id: REF.id, tags: { building: 'yes', height: '30' }, geometry: SQUARE }],
};

function makeClient(fetchImpl: typeof fetch, now = () => 1_000_000) {
  return new OverpassClient({
    endpoint: 'https://overpass.test/api',
    cacheTtlMs: 60_000,
    maxCacheEntries: 3,
    timeoutMs: 5_000,
    fetchImpl,
    now,
    // Retries are exercised for real below; no test needs to wait out the
    // actual 1s/2s backoff.
    sleep: async () => {},
  });
}

describe('OverpassClient', () => {
  it('fetches and parses a footprint', async () => {
    const fetchImpl = vi.fn(async () => okResponse(goodPayload)) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    const result = await client.getFootprint(REF, null);
    expect(result.footprint.osm).toEqual(REF);
    expect(result.footprint.heightMeters).toBeCloseTo(30);
    expect(result.attribution).toContain('OpenStreetMap');
  });

  it('sends a POST with the Overpass query in the body', async () => {
    const fetchImpl = vi.fn(async () => okResponse(goodPayload));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getFootprint(REF, null);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://overpass.test/api');
    expect((init as RequestInit).method).toBe('POST');

    // The query travels form-urlencoded under the `data` key.
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get('data')).toBe('[out:json][timeout:25];way(24950831);out geom tags;');
  });

  it('identifies itself with a user agent, as Overpass asks clients to', async () => {
    const fetchImpl = vi.fn(async () => okResponse(goodPayload));
    await makeClient(fetchImpl as unknown as typeof fetch).getFootprint(REF, null);

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('geo-model-editor');
  });

  it('serves a second request from cache', async () => {
    const fetchImpl = vi.fn(async () => okResponse(goodPayload)) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    await client.getFootprint(REF, null);
    await client.getFootprint(REF, null);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.stats().entries).toBe(1);
  });

  it('re-fetches once the cache entry expires', async () => {
    const fetchImpl = vi.fn(async () => okResponse(goodPayload)) as unknown as typeof fetch;
    let clock = 1_000_000;
    const client = makeClient(fetchImpl, () => clock);

    await client.getFootprint(REF, null);
    clock += 60_001;
    await client.getFootprint(REF, null);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent requests for the same building into one upstream call', async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const a = client.getFootprint(REF, null);
    const b = client.getFootprint(REF, null);
    expect(client.stats().inFlight).toBe(1);

    resolveFetch!(okResponse(goodPayload));
    const [first, second] = await Promise.all([a, b]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('keys the cache on tile height, which overrides the OSM tags', async () => {
    const fetchImpl = vi.fn(async () => okResponse(goodPayload)) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    const tagged = await client.getFootprint(REF, null);
    const overridden = await client.getFootprint(REF, 55);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(tagged.footprint.heightMeters).toBeCloseTo(30);
    expect(overridden.footprint.heightMeters).toBeCloseTo(55);
  });

  it('evicts the oldest entry past the cache limit', async () => {
    const fetchImpl = vi.fn(async () => okResponse(goodPayload)) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    for (const height of [1, 2, 3, 4]) {
      await client.getFootprint(REF, height);
    }
    expect(client.stats().entries).toBe(3);
  });

  it('does not cache failures', async () => {
    // Three retryable 429s exhausts every attempt for the first call; the
    // fourth response is a fresh, separate call's turn.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(okResponse(goodPayload)) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    await expect(client.getFootprint(REF, null)).rejects.toThrow(OverpassError);
    await expect(client.getFootprint(REF, null)).resolves.toBeDefined();
  });

  it('retries a 504 and succeeds once Overpass recovers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }))
      .mockResolvedValueOnce(okResponse(goodPayload)) as unknown as typeof fetch;

    const result = await makeClient(fetchImpl).getFootprint(REF, null);
    expect(result.footprint.osm).toEqual(REF);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries on a persistent 504', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('gateway timeout', { status: 504 }),
    ) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getFootprint(REF, null)).rejects.toMatchObject({
      status: 502,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('surfaces a rate limit as 429 rather than a generic failure, after retrying', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('slow down', { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getFootprint(REF, null)).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('maps an upstream 500 to a 502 without retrying — it is not a transient status', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getFootprint(REF, null)).rejects.toMatchObject({
      status: 502,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a deleted element as a 404, not an outage', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ elements: [] })) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getFootprint(REF, null)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('reports malformed JSON as a 502', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>not json</html>', { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getFootprint(REF, null)).rejects.toMatchObject({
      status: 502,
    });
  });

  it('turns an abort into a 504 with the timeout in the message', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getFootprint(REF, null)).rejects.toMatchObject({
      status: 504,
    });
  });

  it('wraps a network failure as a 502', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).getFootprint(REF, null)).rejects.toMatchObject({
      status: 502,
    });
  });
});
