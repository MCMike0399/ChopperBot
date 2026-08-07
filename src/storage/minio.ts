import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { log } from '../log.js';
import type { ObjectStorage } from './object-storage.js';

export interface MinioStorageDeps {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  /** Test seam: a prebuilt client (real or fake) overrides the constructed one. */
  client?: S3Client;
}

/** Is this error just "the object isn't there"? (NoSuchKey / 404.) */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/**
 * S3-compatible object storage backed by MinIO (on the Pi, the 2 TB HDD).
 * Any S3 API works — path-style addressing + a custom endpoint are the only
 * MinIO-isms. One instance per process; the client is lazily connected, so
 * constructing it while the server is down is fine — individual calls fail
 * and the caller falls back.
 */
export class MinioObjectStorage implements ObjectStorage {
  readonly backend = 'minio';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(deps: MinioStorageDeps) {
    this.bucket = deps.bucket;
    if (deps.client) {
      this.client = deps.client;
    } else {
      const cfg: S3ClientConfig = {
        endpoint: deps.endpoint,
        region: deps.region,
        forcePathStyle: true, // MinIO wants /bucket/key, not bucket.host/key
        credentials: { accessKeyId: deps.accessKey, secretAccessKey: deps.secretKey },
      };
      this.client = new S3Client(cfg);
    }
  }

  async put(key: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return await res.Body.transformToByteArray();
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let removed = 0;
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (page.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string');
      if (keys.length > 0) {
        // DeleteObjects accepts at most 1000 keys — ListObjectsV2 pages at 1000,
        // so one batch per page is always within the limit.
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        removed += keys.length;
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return removed;
  }

  /**
   * Verify the bucket exists (create it if missing and permitted). Never
   * throws: a scoped-down user that can't create buckets simply reports
   * `false` when the bucket is absent, and the caller stays degraded.
   */
  async ensureReady(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (err) {
      if (!isNotFound(err) && (err as { name?: string })?.name !== 'NoSuchBucket') {
        log.warn({ err, bucket: this.bucket }, 'storage.minio.ensure_failed');
        return false;
      }
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      log.info({ bucket: this.bucket }, 'storage.minio.bucket_created');
      return true;
    } catch (err) {
      log.warn({ err, bucket: this.bucket }, 'storage.minio.bucket_create_failed');
      return false;
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}
