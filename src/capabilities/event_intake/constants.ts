/**
 * The capability id, split out of `capability.ts` so the watcher can name
 * itself without importing the capability that constructs it (that edge is
 * already a cycle: capability.ts → watcher.ts). Same pattern as workshop and
 * general_chat.
 */
export const EVENT_INTAKE_CAPABILITY_ID = 'event_intake';

/**
 * Default Agitprop role tokens when none are configured — matched by normalized
 * role NAME (accent/case-insensitive). The live guild's commission role is
 * typically named "Agitprop" or similar.
 */
export const DEFAULT_AGITPROP_ROLES = ['Agitprop'] as const;

/** Live RevZ Agitprop channel (Comisión de Agitprop — diseño y propaganda). */
export const DEFAULT_AGITPROP_CHANNEL_ID = '1483639272413200606';
