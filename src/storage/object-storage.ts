/**
 * Provider-neutral object storage — the durable byte store behind capabilities
 * that outgrow the local disk (today: the workshop's session files, whose
 * Pi-side workspace is only a bounded cache).
 *
 * The abstraction is deliberately tiny (put/get/delete/deletePrefix): keys are
 * opaque slash-separated strings owned by the caller, and every implementation
 * must tolerate being unreachable — callers treat failures as "fall back to
 * the next durable copy", never as fatal.
 */

export interface ObjectStorage {
   /** Short backend id for logs/status ('minio', 'local', ...). */
   readonly backend: string;

   /** Create/overwrite an object. */
   put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;

   /** Fetch an object's bytes; null when the key does not exist. */
   get(key: string): Promise<Uint8Array | null>;

   /** Delete one object; deleting a missing key is not an error. */
   delete(key: string): Promise<void>;

   /** Delete every object under `prefix`; returns how many were removed. */
   deletePrefix(prefix: string): Promise<number>;

   /**
    * One-time readiness check at boot (create the bucket/dir if needed).
    * Implementations MUST NOT throw — an unavailable backend degrades to
    * "storage disabled" behavior in the caller, not a boot failure.
    */
   ensureReady(): Promise<boolean>;

   /** Release underlying resources (HTTP agents, clients). */
   destroy?(): void;
}
