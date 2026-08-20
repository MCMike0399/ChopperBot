import {
   mkdirSync,
   existsSync,
   readFileSync,
   writeFileSync,
   unlinkSync,
   readdirSync,
   rmSync,
} from "node:fs";
import { join, resolve, sep, normalize, dirname } from "node:path";
import type { ObjectStorage } from "./object-storage.js";

/** Resolve a key INSIDE `root`, rejecting absolute paths and `..` traversal. */
function safeKey(root: string, key: string): string {
   if (key.includes("\0")) throw new Error(`Invalid storage key: ${key}`);
   const abs = resolve(root, normalize(key.replace(/^[/\\]+/, "")));
   const rootAbs = resolve(root);
   if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
      throw new Error(`Storage key escapes the root: ${key}`);
   }
   return abs;
}

/**
 * Filesystem-backed ObjectStorage rooted at a local directory. The dev/test
 * backend — the same semantics as MinIO with no server to run. The factory
 * only builds MinIO (unset creds → no storage at all, by design); this exists
 * for tests and local experiments.
 */
export class LocalObjectStorage implements ObjectStorage {
   readonly backend = "local";

   constructor(private readonly rootDir: string) {}

   async put(key: string, bytes: Uint8Array): Promise<void> {
      const abs = safeKey(this.rootDir, key);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
   }

   async get(key: string): Promise<Uint8Array | null> {
      const abs = safeKey(this.rootDir, key);
      if (!existsSync(abs)) return null;
      // Wrap the Buffer so callers get a plain Uint8Array either way.
      return new Uint8Array(readFileSync(abs));
   }

   async delete(key: string): Promise<void> {
      try {
         unlinkSync(safeKey(this.rootDir, key));
      } catch (err) {
         if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
   }

   async deletePrefix(prefix: string): Promise<number> {
      const abs = safeKey(this.rootDir, prefix || ".");
      if (!existsSync(abs)) return 0;
      let removed = 0;
      const walk = (dir: string): void => {
         for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.isFile()) {
               unlinkSync(p);
               removed += 1;
            }
         }
      };
      walk(abs);
      rmSync(abs, { recursive: true, force: true });
      return removed;
   }

   async ensureReady(): Promise<boolean> {
      try {
         mkdirSync(this.rootDir, { recursive: true });
         return true;
      } catch {
         return false;
      }
   }
}
