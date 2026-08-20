import type { ParsedForm } from "./parse.js";
import type { FlyerStatus } from "./store.js";

function fmt(value: string | null | undefined): string {
   return value && value.trim() ? value.trim() : "(sin especificar)";
}

export interface FlyerCardInput {
   ticketChannelId: string;
   requesterId: string | null;
   parsed: ParsedForm;
   location?: string | null;
   notes?: string | null;
   status?: FlyerStatus;
}

/**
 * Deterministic Agitprop request card — the brief must not depend on the model.
 * Edited in place on cancel/update (same pattern as calendar month cards).
 */
export function renderFlyerRequestCard(input: FlyerCardInput): string {
   const { ticketChannelId, requesterId, parsed, location, notes } = input;
   const status = input.status ?? "requested";
   const who = requesterId ? `<@${requesterId}>` : "el/la solicitante";

   if (status === "cancelled") {
      return (
         `~~🎨 **Solicitud de flyer — CANCELADA**~~\n` +
         `~~**${fmt(parsed.title)}** · ticket <#${ticketChannelId}>~~\n\n` +
         `_Esta solicitud ya no está activa._`
      );
   }

   if (status === "delivered") {
      return (
         `✅ **Flyer entregado**\n` +
         `**${fmt(parsed.title)}** · ticket <#${ticketChannelId}>\n` +
         `_El diseño ya está en el ticket y en el evento (si ya estaba aprobado)._`
      );
   }

   const lines = [
      "🎨 **Solicitud de flyer — Comisión de Agitprop**",
      "",
      `- **Evento:** ${fmt(parsed.title)}`,
      `- **Día (como lo escribió):** ${fmt(parsed.dayRaw)}`,
      `- **Hora (como la escribió):** ${fmt(parsed.timeRaw)}`,
      `- **Ponente(s):** ${fmt(parsed.speaker)}`,
   ];
   if (location?.trim()) lines.push(`- **Sala:** ${location.trim()}`);
   lines.push(
      `- **Solicitante:** ${who}`,
      `- **Ticket:** <#${ticketChannelId}>`,
      "",
      "_El solicitante **no** hará su propio flyer — lo toma Agitprop._",
   );
   if (notes?.trim()) lines.push("", `**Notas:** ${notes.trim()}`);
   lines.push(
      "",
      "**Para entregar:** responde **a este mensaje** con la imagen del flyer.",
      "**Para cancelar o cambiar detalles:** menciona a ChopperBot aquí o en el ticket.",
   );
   return lines.join("\n");
}

/** Short deterministic notices posted to the ticket on flyer job transitions. */
export function renderTicketFlyerNotice(
   kind:
      | "opened"
      | "open_failed"
      | "edited"
      | "cancelled"
      | "delivered"
      | "delivered_in_ticket",
): string {
   switch (kind) {
      case "opened":
         return "🎨 Ya le pedí el flyer a la **Comisión de Agitprop** — cuando lo entreguen, lo verás aquí mismo.";
      case "open_failed":
         return "🎨 No pude abrir la solicitud de flyer en Agitprop (el canal no está configurado o no pude publicar ahí). Lxs mods pueden reintentarlo mencionándome en este ticket.";
      case "edited":
         return "🎨 Actualicé la solicitud de flyer en Agitprop con los nuevos detalles.";
      case "cancelled":
         return "🎨 Cancelé la solicitud de flyer en Agitprop.";
      case "delivered":
         return "🎨 **Flyer listo** — Agitprop entregó el diseño (arriba). Si el evento ya está en el calendario, también quedó de portada en Discord.";
      case "delivered_in_ticket":
         return "🎨 **Flyer listo** — el diseño se subió aquí en el ticket. Ya avisé a Agitprop. Si el evento ya está en el calendario, también quedó de portada en Discord.";
   }
}

/** Short notice posted to Agitprop when the ticket side drives a transition. */
export function renderAgitpropFlyerNotice(
   ticketChannelId: string,
   kind: "cancelled" | "edited" | "delivered_in_ticket",
): string {
   switch (kind) {
      case "cancelled":
         return `🎨 La solicitud de flyer del ticket <#${ticketChannelId}> fue **cancelada** desde el ticket.`;
      case "edited":
         return `🎨 Actualizaron los detalles del flyer del ticket <#${ticketChannelId}> — revisa la tarjeta de arriba.`;
      case "delivered_in_ticket":
         return `🎨 El flyer del ticket <#${ticketChannelId}> se subió **desde el ticket** — ya no hace falta diseñarlo aquí.`;
   }
}
