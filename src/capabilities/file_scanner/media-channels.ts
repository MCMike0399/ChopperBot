/**
 * Channels whose purpose is media (clips, memes, art, music, cine). Videos
 * there are expected and skipped to protect the VirusTotal quota. Conversation
 * channels (general, fuera-de-tema, cuidados, …) scan videos because a .mov
 * landing there is unusual.
 *
 * Seeded into `file_scanner_settings.media_channels_json` on first boot; the
 * operator can retune live with `config_filescanner action:set_media_channels`.
 * IDs are Revolución Z's; they are harmless no-ops in any other guild.
 */
export const DEFAULT_MEDIA_NATIVE_CHANNEL_IDS: readonly string[] = [
   "1436243508171116665", // 🖼️│multimedia-general
   "1436232502598438983", // 😹│momos
   "1438634407538983114", // 🫀│arte
   "1438277484918477031", // 📽️│videoclub
   "1438596681619996873", // 🎵│música
   "1438623761363501086", // 🏴‍☠️│anime-y-manga
   "1438754421369475163", // 📽️│chat-cineclub
   "1438782260865273937", // 🗳️│votaciones (cineclub)
   "1440173663784538192", // 🗓️│cartelera-cineclub
   "1440180202742481128", // 🖼️│galería-de-artistas
   "1505807633808887900", // video-agitprop
];

/** Scan videos (conversation) vs skip genuine videos (media-native). */
export type VideoPolicy = "scan" | "skip";

/**
 * Threads and forum posts inherit the parent's media policy so a clip inside
 * #galería-de-artistas is treated like one in the forum itself.
 */
export function policyChannelId(channel: {
   id: string;
   isThread?: () => boolean;
   parentId?: string | null;
}): string {
   if (typeof channel.isThread === "function" && channel.isThread()) {
      return channel.parentId ?? channel.id;
   }
   return channel.id;
}
