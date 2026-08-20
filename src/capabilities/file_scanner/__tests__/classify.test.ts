import { describe, test, expect } from "vitest";
import {
   claimedKind,
   isMediaDisguise,
   isTrustedImage,
   sniffKind,
} from "../classify.js";
import { policyChannelId } from "../media-channels.js";

function bytes(hex: string): Uint8Array {
   const clean = hex.replace(/\s+/g, "");
   const out = new Uint8Array(clean.length / 2);
   for (let i = 0; i < out.length; i++)
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
   return out;
}

describe("sniffKind", () => {
   test("recognizes common image/video/audio magics", () => {
      expect(sniffKind(bytes("ffd8ffe00010"))).toBe("image"); // JPEG
      expect(sniffKind(bytes("89504e470d0a1a0a"))).toBe("image"); // PNG
      expect(sniffKind(Buffer.from("GIF89a...."))).toBe("image");
      // ftyp qt  = QuickTime / .mov
      const mov = new Uint8Array(12);
      mov.set(Buffer.from("ftypqt  "), 4);
      expect(sniffKind(mov)).toBe("video");
      const mp4 = new Uint8Array(12);
      mp4.set(Buffer.from("ftypisom"), 4);
      expect(sniffKind(mp4)).toBe("video");
      const m4a = new Uint8Array(12);
      m4a.set(Buffer.from("ftypM4A "), 4);
      expect(sniffKind(m4a)).toBe("audio");
      expect(sniffKind(Buffer.from("ID3\x04...."))).toBe("audio");
      expect(sniffKind(Buffer.from("OggS...."))).toBe("audio");
      expect(sniffKind(bytes("4d5a900003000000"))).toBe("unknown"); // PE/MZ
   });
});

describe("isMediaDisguise / isTrustedImage", () => {
   test("PE bytes behind a .mov name are a disguise", () => {
      expect(
         isMediaDisguise("video", sniffKind(bytes("4d5a900003000000"))),
      ).toBe(true);
   });
   test("video↔audio ftyp is not a disguise", () => {
      const m4a = new Uint8Array(12);
      m4a.set(Buffer.from("ftypM4A "), 4);
      expect(isMediaDisguise("video", sniffKind(m4a))).toBe(false);
   });
   test("trusted images need an image content-type or none", () => {
      expect(isTrustedImage("cat.png", "image/png")).toBe(true);
      expect(isTrustedImage("cat.png", null)).toBe(true);
      expect(isTrustedImage("cat.png", "application/octet-stream")).toBe(false);
      expect(isTrustedImage("clip.mov", "video/quicktime")).toBe(false);
   });
   test("claimedKind follows extension and content-type", () => {
      expect(claimedKind("a.mov", null)).toBe("video");
      expect(claimedKind("a.mp3", "audio/mpeg3")).toBe("audio");
      expect(claimedKind("a.pdf", "application/pdf")).toBe("other");
   });
});

describe("policyChannelId", () => {
   test("threads inherit the parent forum/channel", () => {
      expect(
         policyChannelId({
            id: "thread1",
            isThread: () => true,
            parentId: "forum1",
         }),
      ).toBe("forum1");
      expect(
         policyChannelId({
            id: "general",
            isThread: () => false,
            parentId: null,
         }),
      ).toBe("general");
   });
});
