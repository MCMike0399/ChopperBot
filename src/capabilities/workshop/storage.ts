import { log } from "../../log.js";
import type { ObjectStorage } from "../../storage/object-storage.js";
import type { WorkshopFileRecord, WorkshopStore } from "./store.js";
import type { SessionWorkspace } from "./workspace.js";

/**
 * Workshop ↔ object-storage glue. MinIO (on the 1 TB SSD) is the PRIMARY
 * durable copy of a session file; the Discord carrier message stays as the
 * fallback. Every helper here is best-effort — a storage failure is logged
 * and the Discord path keeps working, so a down MinIO never breaks a turn.
 */

/** Object key for one session file. Deterministic, so a re-write overwrites. */
export function storageKeyFor(channelId: string, relPath: string): string {
   return `workshop/${channelId}/${relPath}`;
}

/**
 * Upload a workspace file's bytes and record the key in the manifest.
 * Returns true when the copy landed; on any failure the row keeps its old
 * storage_key (NULL = the migration script / a later turn can retry).
 */
export async function uploadToStorage(
   storage: ObjectStorage,
   store: Pick<WorkshopStore, "setStorageKey">,
   input: { channelId: string; relPath: string; bytes: Uint8Array },
): Promise<boolean> {
   const key = storageKeyFor(input.channelId, input.relPath);
   try {
      await storage.put(key, input.bytes);
      store.setStorageKey(input.channelId, input.relPath, key);
      log.info(
         { channelId: input.channelId, file: input.relPath },
         "workshop.storage_uploaded",
      );
      return true;
   } catch (err) {
      log.warn(
         { err, channelId: input.channelId, file: input.relPath },
         "workshop.storage_put_failed",
      );
      return false;
   }
}

/**
 * Restore a manifest file from object storage into the workspace. Returns the
 * bytes written, or null when the object is missing/unreachable — the caller
 * then falls back to the Discord carrier message.
 */
export async function restoreFromStorage(
   storage: ObjectStorage,
   workspace: SessionWorkspace,
   record: WorkshopFileRecord,
): Promise<Uint8Array | null> {
   if (!record.storage_key) return null;
   try {
      const bytes = await storage.get(record.storage_key);
      if (!bytes) return null;
      workspace.writeBytes(record.rel_path, bytes);
      return bytes;
   } catch (err) {
      log.warn(
         { err, channelId: record.channel_id, file: record.rel_path },
         "workshop.storage_get_failed",
      );
      return null;
   }
}

/**
 * Delete every stored object of a session (channel closed / workspace
 * orphaned) — close semantics stay "everything is gone" across BOTH stores.
 */
export async function deleteSessionObjects(
   storage: ObjectStorage,
   channelId: string,
): Promise<number> {
   try {
      const removed = await storage.deletePrefix(`workshop/${channelId}/`);
      if (removed > 0)
         log.info({ channelId, removed }, "workshop.storage_objects_deleted");
      return removed;
   } catch (err) {
      log.warn({ err, channelId }, "workshop.storage_delete_failed");
      return 0;
   }
}
