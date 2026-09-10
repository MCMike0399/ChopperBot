export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

/**
 * A provider-neutral image attachment. The LLM client (src/llm/client.ts) is
 * the only place that knows how to wrap this into its provider's wire shape —
 * since the 2026-09-14 v4.1 migration that is an OpenAI-style
 * `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,…' } }` content
 * part, previously an Amazon Bedrock Converse
 * `{ image: { format, source: { bytes } } }` block.
 *
 * Only images are supported here (documents/PDFs are dropped upstream in
 * resolveAttachments); the bytes are kept raw so the wire shape stays the
 * client's business.
 */
export interface Attachable {
   readonly kind: "image";
   readonly fileName: string;
   readonly mimeType: string;
   readonly bytes: Uint8Array;
   readonly format: ImageFormat;
}

export class ImageAttachable implements Attachable {
   kind = "image" as const;

   constructor(
      public fileName: string,
      public mimeType: string,
      public bytes: Uint8Array,
      public format: ImageFormat,
   ) {}
}

/**
 * Detect an image format from its leading magic bytes — used when bytes arrive
 * without a trustworthy content-type (e.g. the IG cover fetched by the monitor,
 * which we feed to the vision classifier). Returns null for anything we don't
 * recognize, so callers can fall back to text-only instead of mislabeling bytes.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
   const b = bytes;
   if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
      return "jpeg";
   if (
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47
   )
      return "png";
   if (
      b.length >= 6 &&
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38
   )
      return "gif";
   // RIFF....WEBP
   if (
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50
   )
      return "webp";
   return null;
}
