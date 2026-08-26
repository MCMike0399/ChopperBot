/**
 * Live "how this server actually works" facts for the RevZ assistant.
 *
 * The curated primer (profile.ts) is a snapshot and has already been wrong
 * once: it told the model that tickets were how you propose (and, live on
 * 2026-08-25, attend) events. These helpers re-read the public channels
 * ChopperBot can see — topics, as the bot user — then filter to what the
 * ASKING MEMBER can view, so a stale primer cannot invent a trámite.
 *
 * Pure render is exported for tests; the Discord fetch is best-effort and
 * never throws into a turn.
 */
import {
   PermissionFlagsBits,
   type Client,
   type GuildBasedChannel,
} from "discord.js";
import { log } from "../../log.js";

export const REVZ_TICKET_CHANNEL_ID = "1436255397265670195";
export const REVZ_FORMULARIO_CIRCULOS_ID = "1525358955751276544";
export const REVZ_CALENDARIO_CHANNEL_ID = "1518328211165941912";
export const REVZ_ANUNCIOS_CHANNEL_ID = "1435843684628172953";
export const REVZ_PROXIMOS_CIRCULOS_ID = "1436425455396847646";

export type HowToRole =
   | "proponer_circulo"
   | "ticket"
   | "calendario"
   | "anuncios"
   | "proximos_circulos";

export interface HowToChannelSpec {
   id: string;
   role: HowToRole;
}

/** Public how-to doors, in the order they should appear in the prompt. */
export const REVZ_HOWTO_CHANNELS: readonly HowToChannelSpec[] = [
   { id: REVZ_FORMULARIO_CIRCULOS_ID, role: "proponer_circulo" },
   { id: REVZ_TICKET_CHANNEL_ID, role: "ticket" },
   { id: REVZ_CALENDARIO_CHANNEL_ID, role: "calendario" },
   { id: REVZ_ANUNCIOS_CHANNEL_ID, role: "anuncios" },
   { id: REVZ_PROXIMOS_CIRCULOS_ID, role: "proximos_circulos" },
];

export interface HowToChannelFact {
   id: string;
   name: string;
   role: HowToRole;
   topic: string | null;
}

const ROLE_HEAD: Record<HowToRole, string> = {
   proponer_circulo: "Proponer un círculo o actividad nueva",
   ticket: "Ticket — denuncias y soporte, NUNCA eventos",
   calendario: "Cartelera (consultar, no reservar)",
   anuncios: "Avisos del día",
   proximos_circulos: "Foro para difundir círculos",
};

const ROLE_FALLBACK: Record<HowToRole, string> = {
   proponer_circulo:
      "Formulario para proponer un círculo o actividad nueva. No es para entrar a un evento que ya está agendado.",
   ticket:
      "Denuncias, apelaciones y soporte técnico. No sirve para reservar ni para entrar a un evento.",
   calendario: "Cartelera del mes en imagen + archivo ICS. Consulta libre.",
   anuncios: "Avisos oficiales y el evento de hoy, con el enlace para apuntarse.",
   proximos_circulos:
      "Foro para que cualquiera abra y difunda círculos de estudio.",
};

const TOPIC_MAX = 400;

/**
 * Compact block injected into the assistant prompt. Always opens with the
 * attending rule so a 0-tool-call reply cannot invent a reservation.
 */
export function renderHowToBlock(facts: readonly HowToChannelFact[]): string {
   const lines = [
      "# Cómo se usa el servidor (leído EN VIVO del Discord, no lo contradigas)",
      "- **Asistir a un evento es abierto y gratis.** No hay reserva, no hay pase, no se abre ticket. Entras a la sala o le das \"Me interesa\" al evento de Discord (`discord_event_url` / pestaña Eventos). Si preguntan \"dónde reservo\" / \"cómo saco pase\": diles que no hace falta.",
      "- **Proponer** un círculo nuevo ≠ **asistir** a uno que ya está. Lo primero es el formulario de círculos; lo segundo es llegar.",
   ];
   for (const fact of facts) {
      const topic = (fact.topic?.trim() || ROLE_FALLBACK[fact.role]).slice(
         0,
         TOPIC_MAX,
      );
      lines.push(
         `- **${ROLE_HEAD[fact.role]}:** <#${fact.id}> (#${fact.name}) — ${topic}`,
      );
   }
   return lines.join("\n");
}

/**
 * Read the public how-to channels as ChopperBot, then keep only those the
 * asking member can ViewChannel. Fail closed (empty list) if the member
 * cannot be resolved — same security rule as the directory tools.
 */
export async function fetchHowToFacts(
   getClient: () => Client,
   guildId: string,
   userId: string,
): Promise<HowToChannelFact[]> {
   const client = getClient();
   const guild = await client.guilds.fetch(guildId);
   const member = await guild.members.fetch(userId);
   const out: HowToChannelFact[] = [];
   for (const spec of REVZ_HOWTO_CHANNELS) {
      const raw = await guild.channels.fetch(spec.id).catch(() => null);
      if (!raw) continue;
      const channel = raw as GuildBasedChannel;
      const perms = channel.permissionsFor(member);
      if (!perms?.has(PermissionFlagsBits.ViewChannel)) continue;
      const topicRaw =
         "topic" in channel && typeof channel.topic === "string"
            ? channel.topic
            : null;
      out.push({
         id: channel.id,
         name: channel.name,
         role: spec.role,
         topic: topicRaw,
      });
   }
   return out;
}

/** Best-effort wrapper: a Discord blip must not block the turn. */
export async function loadHowToBlock(
   getClient: () => Client,
   guildId: string,
   userId: string,
): Promise<string | null> {
   try {
      const facts = await fetchHowToFacts(getClient, guildId, userId);
      if (facts.length === 0) return null;
      return renderHowToBlock(facts);
   } catch (err) {
      log.warn({ err, guildId }, "general_chat.howto_fetch_failed");
      return null;
   }
}
