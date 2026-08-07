import { describe, test, expect, afterEach } from 'vitest';
import { config } from '../../config.js';
import { createObjectStorage } from '../index.js';
import { MinioObjectStorage } from '../minio.js';

// dotenv loads the host's real .env into the test process — stub the MINIO_*
// config keys explicitly (and restore them) so this test is host-independent.
const orig = {
  ak: config.MINIO_ACCESS_KEY,
  sk: config.MINIO_SECRET_KEY,
};

afterEach(() => {
  config.MINIO_ACCESS_KEY = orig.ak;
  config.MINIO_SECRET_KEY = orig.sk;
});

describe('createObjectStorage', () => {
  test('no credentials → null (callers keep the Discord-only behavior)', () => {
    config.MINIO_ACCESS_KEY = undefined;
    config.MINIO_SECRET_KEY = undefined;
    expect(createObjectStorage()).toBeNull();
  });

  test('only one of the pair set → null', () => {
    config.MINIO_ACCESS_KEY = 'k';
    config.MINIO_SECRET_KEY = undefined;
    expect(createObjectStorage()).toBeNull();
  });

  test('credentials set → MinIO backend (no I/O at construction)', () => {
    config.MINIO_ACCESS_KEY = 'k';
    config.MINIO_SECRET_KEY = 's';
    const storage = createObjectStorage();
    expect(storage).toBeInstanceOf(MinioObjectStorage);
    expect(storage?.backend).toBe('minio');
  });
});
