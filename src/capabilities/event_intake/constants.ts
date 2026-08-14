/**
 * The capability id, split out of `capability.ts` so the watcher can name
 * itself without importing the capability that constructs it (that edge is
 * already a cycle: capability.ts → watcher.ts). Same pattern as workshop and
 * general_chat.
 */
export const EVENT_INTAKE_CAPABILITY_ID = 'event_intake';
