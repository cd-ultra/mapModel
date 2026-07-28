/**
 * Object storage for generated GLB assets.
 *
 * Two drivers behind one interface: S3-compatible (S3, R2, MinIO) for
 * deployment, and local disk so a developer can run the whole pipeline without
 * standing up a bucket. The route layer never knows which is active.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ServerConfig } from '../config.js';

export interface StoredObject {
  key: string;
  /** URL a browser can fetch the object from. */
  url: string;
  bytes: number;
}

export interface StorageAdapter {
  readonly driver: 's3' | 'local';
  put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  /** A URL valid for `ttlSeconds`; local storage returns a static path. */
  url(key: string, ttlSeconds?: number): Promise<string>;
}

/** Deterministic key so re-uploading identical geometry does not duplicate it. */
export function contentKey(prefix: string, body: Uint8Array, extension = 'glb'): string {
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 32);
  return `${prefix}/${digest}.${extension}`;
}

export class LocalStorage implements StorageAdapter {
  readonly driver = 'local' as const;

  constructor(
    private readonly directory: string,
    private readonly publicBaseUrl: string,
  ) {}

  private pathFor(key: string): string {
    // Keys are generated internally, but treat them as untrusted anyway: a key
    // containing ".." must not escape the storage directory.
    const resolved = path.resolve(this.directory, key);
    const root = path.resolve(this.directory);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Refusing to write outside the storage directory: ${key}`);
    }
    return resolved;
  }

  async put(key: string, body: Uint8Array): Promise<StoredObject> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return { key, url: await this.url(key), bytes: body.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async url(key: string): Promise<string> {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
}

export class S3Storage implements StorageAdapter {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: { region?: string | null; endpoint?: string | null; publicBaseUrl?: string | null },
  ) {
    this.client = new S3Client({
      ...(options.region ? { region: options.region } : {}),
      ...(options.endpoint
        ? // Path-style addressing is what MinIO and most S3-compatible
          // endpoints expect; virtual-host style needs DNS per bucket.
          { endpoint: options.endpoint, forcePathStyle: true }
        : {}),
    });
    this.publicBaseUrl = options.publicBaseUrl ?? null;
  }

  private readonly publicBaseUrl: string | null;

  async put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Assets are content-addressed, so they can be cached forever.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return { key, url: await this.url(key), bytes: body.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await result.Body?.transformToByteArray();
      return bytes ? new Uint8Array(bytes) : null;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw error;
    }
  }

  async url(key: string, ttlSeconds = 3600): Promise<string> {
    // A CDN in front of the bucket removes the need to sign at all.
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}

export function createStorage(config: ServerConfig): StorageAdapter {
  if (config.storage.driver === 's3' && config.storage.bucket) {
    return new S3Storage(config.storage.bucket, {
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      publicBaseUrl: config.storage.publicBaseUrl,
    });
  }
  return new LocalStorage(
    config.storage.localDir,
    config.storage.publicBaseUrl ?? '/assets',
  );
}
