import { describe, test, expect } from 'vitest';
import { ImageAttachable, sniffImageFormat } from '../attachable.js';

describe('ImageAttachable', () => {
  test('exposes the provider-neutral fields the LLM client needs', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const img = new ImageAttachable('test.png', 'image/png', bytes, 'png');
    expect(img.kind).toBe('image');
    expect(img.fileName).toBe('test.png');
    expect(img.mimeType).toBe('image/png');
    expect(img.format).toBe('png');
    expect(img.bytes).toBe(bytes);
  });

  test('preserves the jpeg format', () => {
    const img = new ImageAttachable('photo.jpg', 'image/jpeg', new Uint8Array([255, 216, 255]), 'jpeg');
    expect(img.format).toBe('jpeg');
    expect(img.mimeType).toBe('image/jpeg');
  });
});

describe('sniffImageFormat', () => {
  test('detects jpeg / png / gif / webp from magic bytes', () => {
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffImageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif');
    expect(
      sniffImageFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe('webp');
  });

  test('returns null for unrecognized or too-short bytes', () => {
    expect(sniffImageFormat(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8]))).toBeNull(); // truncated jpeg sig
    expect(sniffImageFormat(new Uint8Array([]))).toBeNull();
  });
});
