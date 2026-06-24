export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/**
 * A provider-neutral image attachment. The LLM client (src/llm/client.ts) is
 * the only place that knows how to wrap this into its provider's wire shape
 * (Bedrock Converse: an `{ image: { format, source: { bytes } } }` content
 * block). The Bedrock Converse API accepts raw image bytes — only images are
 * supported here (documents/PDFs are dropped upstream in resolveAttachments).
 */
export interface Attachable {
  readonly kind: 'image';
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly format: ImageFormat;
}

export class ImageAttachable implements Attachable {
  kind = 'image' as const;

  constructor(
    public fileName: string,
    public mimeType: string,
    public bytes: Uint8Array,
    public format: ImageFormat,
  ) {}
}
