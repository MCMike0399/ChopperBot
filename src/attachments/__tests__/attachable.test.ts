import { describe, test, expect } from 'vitest';
import { ImageAttachable } from '../attachable.js';

describe('ImageAttachable', () => {
  test('toContentPart returns OpenAI image_url shape with data URI', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const img = new ImageAttachable('test.png', 'image/png', bytes, 'png');
    const part = img.toContentPart();
    expect(part.type).toBe('image_url');
    expect(part.image_url.url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
  });

  test('toContentPart preserves the provided mimeType in the data URI', () => {
    const bytes = new Uint8Array([255, 216, 255]);
    const img = new ImageAttachable('photo.jpg', 'image/jpeg', bytes, 'jpeg');
    const part = img.toContentPart();
    expect(part.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});
