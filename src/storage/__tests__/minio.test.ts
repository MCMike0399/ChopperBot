import { describe, test, expect, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { MinioObjectStorage } from '../minio.js';

/** A fake S3Client whose send() dispatches on the command class name. */
function fakeClient(handler: (commandName: string, input: Record<string, unknown>) => unknown) {
  const send = vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
    handler(cmd.constructor.name, cmd.input),
  );
  return { client: { send } as unknown as S3Client, send };
}

function storageWith(client: S3Client): MinioObjectStorage {
  return new MinioObjectStorage({
    endpoint: 'http://127.0.0.1:9500',
    region: 'us-east-1',
    bucket: 'chopperbot',
    accessKey: 'k',
    secretKey: 's',
    client,
  });
}

describe('MinioObjectStorage', () => {
  test('put sends a PutObject with bucket, key and bytes', async () => {
    const { client, send } = fakeClient(() => ({}));
    await storageWith(client).put('workshop/c1/a.txt', new TextEncoder().encode('hola'));
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0] as unknown as { constructor: { name: string }; input: Record<string, unknown> };
    expect(cmd.constructor.name).toBe('PutObjectCommand');
    expect(cmd.input).toMatchObject({ Bucket: 'chopperbot', Key: 'workshop/c1/a.txt' });
  });

  test('get returns the object bytes', async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const { client } = fakeClient(() => ({
      Body: { transformToByteArray: async () => payload },
    }));
    expect(await storageWith(client).get('k')).toEqual(payload);
  });

  test('get maps NoSuchKey / NotFound / 404 to null', async () => {
    for (const err of [
      Object.assign(new Error('no'), { name: 'NoSuchKey' }),
      Object.assign(new Error('no'), { name: 'NotFound' }),
      Object.assign(new Error('no'), { $metadata: { httpStatusCode: 404 } }),
    ]) {
      const { client } = fakeClient(() => {
        throw err;
      });
      expect(await storageWith(client).get('k')).toBeNull();
    }
  });

  test('get rethrows non-404 errors (the caller degrades on those)', async () => {
    const { client } = fakeClient(() => {
      throw new Error('connection refused');
    });
    await expect(storageWith(client).get('k')).rejects.toThrow('connection refused');
  });

  test('deletePrefix paginates and batch-deletes, returning the count', async () => {
    const pages = [
      { Contents: [{ Key: 'p/a' }, { Key: 'p/b' }], IsTruncated: true, NextContinuationToken: 't1' },
      { Contents: [{ Key: 'p/c' }], IsTruncated: false },
    ];
    const deleted: string[][] = [];
    const { client } = fakeClient((name, input) => {
      if (name === 'ListObjectsV2Command') return input.ContinuationToken ? pages[1] : pages[0];
      if (name === 'DeleteObjectsCommand') {
        deleted.push((input.Delete as { Objects: Array<{ Key: string }> }).Objects.map((o) => o.Key));
        return {};
      }
      throw new Error(`unexpected ${name}`);
    });
    const removed = await storageWith(client).deletePrefix('p/');
    expect(removed).toBe(3);
    expect(deleted).toEqual([['p/a', 'p/b'], ['p/c']]);
  });

  test('deletePrefix on an empty prefix deletes nothing', async () => {
    const { client } = fakeClient(() => ({ Contents: [], IsTruncated: false }));
    expect(await storageWith(client).deletePrefix('nada/')).toBe(0);
  });

  test('ensureReady: existing bucket → true, no create attempted', async () => {
    const { client, send } = fakeClient(() => ({}));
    expect(await storageWith(client).ensureReady()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]![0] as unknown as { constructor: { name: string } }).constructor.name).toBe(
      'HeadBucketCommand',
    );
  });

  test('ensureReady: missing bucket → created', async () => {
    const names: string[] = [];
    const { client } = fakeClient((name) => {
      names.push(name);
      if (name === 'HeadBucketCommand') throw Object.assign(new Error('no'), { name: 'NoSuchBucket' });
      return {};
    });
    expect(await storageWith(client).ensureReady()).toBe(true);
    expect(names).toEqual(['HeadBucketCommand', 'CreateBucketCommand']);
  });

  test('ensureReady never throws: server down → false; create denied → false', async () => {
    const down = fakeClient(() => {
      throw new Error('ECONNREFUSED');
    });
    expect(await storageWith(down.client).ensureReady()).toBe(false);

    const denied = fakeClient((name) => {
      if (name === 'HeadBucketCommand') throw Object.assign(new Error('no'), { name: 'NoSuchBucket' });
      throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    });
    expect(await storageWith(denied.client).ensureReady()).toBe(false);
  });
});
