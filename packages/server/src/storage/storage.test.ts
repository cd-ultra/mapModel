import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorage, contentKey, createStorage } from './index.js';
import { loadConfig } from '../config.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gme-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('contentKey', () => {
  it('is stable for identical bytes and different for different bytes', () => {
    const a = contentKey('models/1', new Uint8Array([1, 2, 3]));
    const b = contentKey('models/1', new Uint8Array([1, 2, 3]));
    const c = contentKey('models/1', new Uint8Array([1, 2, 4]));

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^models\/1\/[0-9a-f]{32}\.glb$/);
  });
});

describe('LocalStorage', () => {
  it('writes, reads back, and reports size', async () => {
    const storage = new LocalStorage(dir, '/assets');
    const body = new Uint8Array([1, 2, 3, 4]);

    const stored = await storage.put('models/a/x.glb', body, 'model/gltf-binary');
    expect(stored.bytes).toBe(4);
    expect(stored.url).toBe('/assets/models/a/x.glb');

    expect(await storage.get('models/a/x.glb')).toEqual(body);
  });

  it('creates nested directories as needed', async () => {
    const storage = new LocalStorage(dir, '/assets');
    await storage.put('deep/nested/path/x.glb', new Uint8Array([9]), 'model/gltf-binary');
    expect(await storage.get('deep/nested/path/x.glb')).toEqual(new Uint8Array([9]));
  });

  it('returns null for a missing key rather than throwing', async () => {
    expect(await new LocalStorage(dir, '/assets').get('nope.glb')).toBeNull();
  });

  it('refuses a key that would escape the storage directory', async () => {
    const storage = new LocalStorage(dir, '/assets');
    await expect(
      storage.put('../../escaped.glb', new Uint8Array([1]), 'model/gltf-binary'),
    ).rejects.toThrow(/outside the storage directory/);
  });

  it('trims a trailing slash from the public base url', async () => {
    const storage = new LocalStorage(dir, 'https://cdn.example.com/');
    expect(await storage.url('models/x.glb')).toBe('https://cdn.example.com/models/x.glb');
  });
});

describe('createStorage', () => {
  it('picks local storage when no bucket is configured', () => {
    const storage = createStorage(loadConfig({} as NodeJS.ProcessEnv));
    expect(storage.driver).toBe('local');
  });

  it('picks s3 when a bucket is configured', () => {
    const storage = createStorage(
      loadConfig({ S3_BUCKET: 'my-bucket', S3_REGION: 'us-east-1' } as NodeJS.ProcessEnv),
    );
    expect(storage.driver).toBe('s3');
  });

  it('picks blob when a Vercel Blob store is connected but no bucket is set', () => {
    const storage = createStorage(
      loadConfig({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test' } as NodeJS.ProcessEnv),
    );
    expect(storage.driver).toBe('blob');
  });

  it('prefers s3 over blob when both are configured', () => {
    const storage = createStorage(
      loadConfig({
        S3_BUCKET: 'my-bucket',
        BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test',
      } as NodeJS.ProcessEnv),
    );
    expect(storage.driver).toBe('s3');
  });
});
