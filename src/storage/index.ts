import { config } from "../config.js";
import { log } from "../log.js";
import type { ObjectStorage } from "./object-storage.js";
import { MinioObjectStorage } from "./minio.js";

export type { ObjectStorage } from "./object-storage.js";
export { MinioObjectStorage } from "./minio.js";
export { LocalObjectStorage } from "./local.js";

/**
 * Build the process-wide object storage from env config. Returns null when no
 * backend is configured (MINIO_ACCESS_KEY/MINIO_SECRET_KEY unset) — callers
 * then keep their pre-storage behavior (for the workshop: Discord messages as
 * the only durable file carrier). Construction never performs I/O, so a
 * down server doesn't block boot; per-call failures degrade gracefully.
 */
export function createObjectStorage(): ObjectStorage | null {
   if (!config.MINIO_ACCESS_KEY || !config.MINIO_SECRET_KEY) return null;
   const storage = new MinioObjectStorage({
      endpoint: config.MINIO_ENDPOINT,
      region: config.MINIO_REGION,
      bucket: config.MINIO_BUCKET,
      accessKey: config.MINIO_ACCESS_KEY,
      secretKey: config.MINIO_SECRET_KEY,
   });
   log.info(
      {
         backend: storage.backend,
         endpoint: config.MINIO_ENDPOINT,
         bucket: config.MINIO_BUCKET,
      },
      "storage.configured",
   );
   return storage;
}
