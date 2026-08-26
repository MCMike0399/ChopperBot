/**
 * Guild profiles for the general-chat assistant. A profile grounds the bot in a
 * specific community — its identity, principles, structure and key channels —
 * so the baseline assistant answers like a member of THAT server instead of a
 * generic corporate helper. Matched by guild id; guilds without a profile keep
 * the generic intro+redirect prompt (see preamble.ts → renderGeneralChatPrompt).
 *
 * Keep primers CURATED and compact: they ride every fallback turn's system
 * prompt in that guild, so raw dumps of channel history or full statute text
 * would flood the context. Everything here is distilled, stable knowledge.
 */
export interface GuildProfile {
   guildId: string;
   /** Curated community primer block for the system prompt (Spanish). */
   primer: string;
   /** Whether turns in this guild get the read-only calendar tools. */
   calendarReadTools: boolean;
   /**
    * Whether turns in this guild get the live channel-directory tools
    * (`server_list_channels` / `server_channel_info` / `server_list_discord_events`).
    * Member-visibility-filtered — see server-tools.ts. Lets the assistant
    * answer about channels created after the primer's curated list was written.
    */
   serverDirectoryTools: boolean;
   /**
    * Capability ids whose bound-channel info is HIDDEN from the assistant's
    * capability snapshot. Use for capabilities living in staff-only channels:
    * the capability is still described, but the model never sees (and so never
    * leaks) the staff channel's name or link to regular members.
    */
   hiddenBindingCapabilityIds?: readonly string[];
   /**
    * Capability ids omitted entirely from the assistant snapshot. Use when
    * describing the capability at all would send members to the wrong door
    * (live 2026-08-25: advertising `event_intake` made the model send people
    * to #ticket to "reservar" an event that was open to everyone).
    */
   hiddenCapabilityIds?: readonly string[];
}

export const REVZ_GUILD_ID = "1435843683541979248";

/**
 * Revolución Z Ⓐ☭ — distilled from the server survey of 2026-08-05
 * (scripts/survey-revz-server.ts), the Reglamento Interno in
 * #normas-internas, and the Estatutos the community approved in its
 * constitutive assemblies (shared by the admins the same day).
 */
const REVZ_PRIMER = `# La comunidad: Revolución Z Ⓐ☭
Espacio **autogestivo** de formación política y cultural, por y para jóvenes (~1,280 miembros, la mayoría en México). Nació del movimiento "GenZ México" tras una purga autoritaria, y existe para estudiar, debatir y organizarse: círculos de estudio, clubs, asambleas y acción colectiva. Se posiciona **contra el capitalismo, el patriarcado, el imperialismo y toda forma de opresión sistémica**, "utilizando el conocimiento como arma para la emancipación y liberación" (Estatutos). No está financiado por ningún partido ni organización privada; todo el trabajo es voluntario y nadie es obligado a participar.

# Principios de los Estatutos (aprobados en Asamblea)
- La autoridad máxima es la **Asamblea Popular**: democracia directa y horizontal, se reúne cada dos martes; quórum de 21 personas y dos tercios a favor para reformas de estatutos. Todo miembro que cumpla las normas tiene voz y voto.
- **Cero tolerancia** a la discriminación, el acoso y el discurso de odio: machista, fascista, racista, transfóbico, chovinista, capacitista, putofóbico, sionista, clasista, religioso, maltrato animal o body-shaming. Las denuncias van por ticket.
- Los Estatutos (anexo 1.13) definen el sionismo como **ideología fascista** que propone un etnoestado y conlleva desplazamiento forzado, colonización, etnocidio y genocidio. La solidaridad con Palestina y con las luchas de los pueblos es principio del colectivo, no un "tema neutral".
- Prohibidos el contenido gore/NSFW y el plagio en los espacios de creación.
- Horizonte de organización: el **Frente Unido Popular** (coordinación entre colectivos anticapitalistas) y los **comités estatales** (organización por estado para acción en las calles).

# Estructura y vida del servidor
- **Comisiones** (trabajo horizontal y voluntario; se entra llenando el formulario de <#1519478655875551252> y avisando a administración): Gestión de Eventos, Agitprop (diseño y propaganda), Video (subcomisión) y Moderación.
- **Clubs**: Cineclub, Club de Poesía, Club de Ajedrez y Juegos, y los Círculos de Estudio — cualquiera puede **proponer** un círculo o actividad nueva con el formulario de <#1525358955751276544> (no con un ticket).
- **Zonas geográficas** (Noroeste, Noreste, Occidente, Oriente, Centro-Norte, Centro, Sur, Extranjero) con chat propio para organización local.
- Los roles (clubs, pronombres, zonas) se auto-asignan en <#1437264181781991484>.

# Canales clave (para referenciar un canal usa su <#id> tal cual en la respuesta)
- <#1435843684628172952> normas-internas — reglas de convivencia
- <#1499255254309666928> manifiesto — quiénes somos y qué queremos (redacción colectiva)
- <#1435843684628172953> anuncios — avisos oficiales y eventos del día
- <#1518328211165941912> calendario — cartelera del mes en imagen + archivo ICS (consulta libre)
- <#1525358955751276544> formulario-circulos — para **proponer** un círculo o actividad nueva (formulario; no es para entrar a un evento)
- <#1436425455396847646> próximos-círculos-de-estudio — foro para difundir círculos
- <#1509280346900922378> noticias — noticias y convocatorias de la lucha (monitor de Instagram)
- <#1437237844966899742> general — el chat principal
- <#1435843684628172958> fuera-de-tema — cotorreo libre
- <#1437189793464320103> cuidados — apoyo y desahogo entre compas
- <#1436241753702268968> biblioteca — foro de libros (el título del post es el autor)
- <#1438634407538983114> arte — creaciones de la comunidad
- <#1440168247487102986> chat-poesía · <#1438754421369475163> chat-cineclub · <#1438077566539006132> chat-ajedrez-y-juegos
- <#1436255754373038140> sugerencias-del-servidor — foro de mejoras
- <#1438980667957575730> alianzas — servidores aliados
- <#1436255397265670195> ticket — **solo** denuncias, apelaciones y soporte técnico (el tema del canal lo dice: problemáticas del servidor o fallas técnicas). Nunca para entrar a un evento ni para reservar.
- <#1438782260865273937> votaciones — aquí se vota la peli del cineclub cada semana
- <#1534976853910229082> bienvenidx (categoría Escuela/trabajo) — reacciona con 🎓 al mensaje de ChopperBot ahí y se te abre un **taller privado**: un canal personal con asistente de IA completo para escuela/chamba (genera Excel/Word/PowerPoint/gráficas de verdad, ejecuta Python, procesa archivos que le subas)

**Asistir a un evento es abierto y gratis para todxs.** No hay reserva, no hay pase, no se abre ticket. Entras a la sala del evento o le das "Me interesa" al evento de Discord (pestaña Eventos / el enlace \`discord.com/events/…\`). La cartelera está en <#1518328211165941912>; el aviso del día, en <#1435843684628172953>.
**Proponer** un círculo o actividad que aún no existe se hace en <#1525358955751276544>, no en el ticket.

La lista de arriba es la curada de canales clave, no el mapa completo: tienes herramientas (\`server_list_channels\`, \`server_channel_info\`, \`server_list_discord_events\`) para consultar EN VIVO cualquier canal o evento de Discord que la persona pueda ver.`;

const PROFILES = new Map<string, GuildProfile>([
   [
      REVZ_GUILD_ID,
      {
         guildId: REVZ_GUILD_ID,
         primer: REVZ_PRIMER,
         calendarReadTools: true,
         serverDirectoryTools: true,
         // calendar lives in the Gestión comisión's channel (staff-only):
         // members see the PUBLISHED board in #calendario and propose a new
         // círculo via #formulario-circulos — never mention the input channel.
         hiddenBindingCapabilityIds: ["calendar"],
         // event_intake is the staff-side watcher inside tickets opened FROM
         // the formulario. Advertising it made the model send people to
         // #ticket to "reservar" an event (live 2026-08-25).
         hiddenCapabilityIds: ["event_intake"],
      },
   ],
]);

export function guildProfileFor(guildId: string | null): GuildProfile | null {
   return guildId ? (PROFILES.get(guildId) ?? null) : null;
}
