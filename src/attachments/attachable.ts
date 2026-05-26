export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/**
 * OpenAI-style content part for image input. The Kimi Code API accepts the
 * standard `image_url` block with a `data:` URI (base64). Documents/PDFs are
 * not supported by the API, so this codebase only emits image parts.
 */
export interface ImageUrlPart {
  type: 'image_url';
  image_url: { url: string };
}

export interface Attachable {
  readonly kind: 'image';
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  toContentPart(): ImageUrlPart;
}

export class ImageAttachable implements Attachable {
  kind = 'image' as const;

  constructor(
    public fileName: string,
    public mimeType: string,
    public bytes: Uint8Array,
    public format: ImageFormat,
  ) {}

  toContentPart(): ImageUrlPart {
    const base64 = Buffer.from(this.bytes).toString('base64');
    return {
      type: 'image_url',
      image_url: { url: `data:${this.mimeType};base64,${base64}` },
    };
  }
}
