import {
   isAudioAttachment,
   isImageAttachment,
   isVideoAttachment,
} from "./format.js";

/** What the filename / Content-Type claim the file is. */
export type ClaimedKind = "image" | "video" | "audio" | "other";

/** What the first bytes actually look like. `unknown` = no recognized magic. */
export type SniffedKind = ClaimedKind | "unknown";

export function claimedKind(
   name: string,
   contentType: string | null,
): ClaimedKind {
   if (isImageAttachment(name, contentType)) return "image";
   if (isVideoAttachment(name, contentType)) return "video";
   if (isAudioAttachment(name, contentType)) return "audio";
   return "other";
}

/**
 * True when the name/type says image/video/audio but the bytes are something
 * else (or unrecognizable). Catches `malware.exe` renamed to `clip.mov`.
 * Video↔audio mismatches are NOT disguises (m4a often travels as video/mp4).
 */
export function isMediaDisguise(
   claimed: ClaimedKind,
   sniffed: SniffedKind,
): boolean {
   if (claimed === "other") return false;
   if (sniffed === "unknown") return true;
   if (claimed === "image") return sniffed !== "image";
   return sniffed !== "video" && sniffed !== "audio";
}

/**
 * Skip ordinary Discord images without downloading. An image extension with a
 * non-image Content-Type (octet-stream, empty, application/…) is NOT trusted
 * — those go through the scanner.
 */
export function isTrustedImage(
   name: string,
   contentType: string | null,
): boolean {
   if (!isImageAttachment(name, contentType)) return false;
   const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
   return ct === "" || ct.startsWith("image/");
}

const ascii = (bytes: Uint8Array, start: number, len: number): string =>
   String.fromCharCode(...bytes.subarray(start, start + len));

/**
 * Classify a file from its first bytes. Keep this conservative: unknown is
 * safer than a false image/video match that would skip a scan.
 */
export function sniffKind(bytes: Uint8Array): SniffedKind {
   if (bytes.length < 4) return "unknown";

   // Images
   if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
      return "image"; // JPEG
   if (
      bytes[0] === 0x89 &&
      ascii(bytes, 1, 3) === "PNG" &&
      bytes.length >= 8 &&
      bytes[4] === 0x0d
   )
      return "image";
   if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
      return "image";
   if (
      bytes.length >= 12 &&
      ascii(bytes, 0, 4) === "RIFF" &&
      ascii(bytes, 8, 4) === "WEBP"
   )
      return "image";

   // ISO-BMFF: mp4 / mov / m4v / m4a (ftyp box at offset 4)
   if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
      const brand = ascii(bytes, 8, 4);
      if (brand === "M4A " || brand === "M4B " || brand === "mp4a")
         return "audio";
      return "video";
   }

   // Matroska / WebM
   if (
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
   )
      return "video";

   if (
      bytes.length >= 12 &&
      ascii(bytes, 0, 4) === "RIFF" &&
      ascii(bytes, 8, 4) === "AVI "
   )
      return "video";

   // Audio
   if (ascii(bytes, 0, 3) === "ID3") return "audio";
   if (ascii(bytes, 0, 4) === "OggS") return "audio";
   if (ascii(bytes, 0, 4) === "fLaC") return "audio";
   if (
      bytes.length >= 12 &&
      ascii(bytes, 0, 4) === "RIFF" &&
      ascii(bytes, 8, 4) === "WAVE"
   )
      return "audio";

   return "unknown";
}
