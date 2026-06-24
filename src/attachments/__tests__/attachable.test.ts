import { describe, test, expect } from 'vitest';
import { ImageAttachable } from '../attachable.js';

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
