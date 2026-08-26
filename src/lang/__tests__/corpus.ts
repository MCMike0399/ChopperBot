/**
 * Real replies the bot posted in the RevZ calendar channel (1483675563871961248),
 * recovered with `npx tsx scripts/dump-channel.ts 1483675563871961248 100` and
 * attributed to a backend by cross-referencing each turn's `agent_turn` line in
 * `journalctl --user -u chopperbot` (the log records `backend`/`model` but not
 * the text, so the two sources have to be joined by timestamp).
 *
 * This is the regression corpus for `../spanish-style.ts`: the Kimi replies are
 * the voice the community had and must stay lint-clean, and the DeepSeek ones
 * are the exact regressions reported on 2026-08-13, each of which must stay
 * caught. Do not "fix" the Spanish in here — these are transcripts.
 */

export interface CorpusReply {
   /** Discord message id, so the original can always be pulled up again. */
   id: string;
   /** UTC timestamp as printed by dump-channel.ts. */
   at: string;
   /** Backend that produced it, per the journal's agent_turn line. */
   backend: "kimi" | "deepseek" | "bedrock";
   text: string;
}

/**
 * Kimi era (through 2026-08-13 11:51 CST). Tuteo throughout, warm, short,
 * closes on statements — this is the target voice.
 */
export const KIMI_REPLIES: readonly CorpusReply[] = [
   {
      id: "1536550270690005094",
      at: "2026-08-11T01:42Z",
      backend: "kimi",
      text: `Hoy hay **un evento** en el calendario:

- **Repensar la burocracia: La utopía de las normas de David Graeber**
  8:30 PM – 10:30 PM en **Sala de eventos**
  Ponente: Chiapaneco Anarkista.`,
   },
   {
      id: "1536550377586036879",
      at: "2026-08-11T01:42Z",
      backend: "kimi",
      text: "¡De nada! :3 🙌",
   },
   {
      id: "1537495034541117440",
      at: "2026-08-13T16:16Z",
      backend: "kimi",
      text: `¡Listo! 🙌

Ya quedó el evento **"Julio Cortázar | Club de poesía"** del miércoles 19 de agosto a las 8:00 PM. Como ya existía en el calendario, le actualicé la sala a **Sala de Club de Poesía** y le creé el evento de Discord en **🫀 Sala de Club de Poesía 🫀** (Stage):
🔗 https://discord.com/events/1435843683541979248/1537494989892747334

Sobre la imagen: no tengo visible ningún enlace adjunto en esta conversación, así que no pude ponerle portada. Si me pasas el enlace de la imagen, se la agrego en un momento.

Nota: hay otro evento con el mismo título **a las 2:00 PM** del mismo día (#32) que también le falta el evento de Discord. Si quieres, también lo subo.`,
   },
   {
      id: "1537495350800158810",
      at: "2026-08-13T16:17Z",
      backend: "kimi",
      text: `La URL que me pasaste no la puedo usar como portada porque necesito que la imagen esté adjunta directamente en esta conversación. Súbela aquí al chat y, con el enlace que me genere Discord, se la pongo al evento de **Julio Cortázar | Club de poesía** de inmediato.`,
   },
   {
      id: "1537496197516886036",
      at: "2026-08-13T16:20Z",
      backend: "kimi",
      text: `Es el evento **#32 "Julio Cortázar | Club de Poesía"** programado el mismo miércoles 19 de agosto, pero a las **2:00 PM** (el de las 8:00 PM es el #23). Está en la **Sala de Club de Poesía** y también le falta el evento de Discord.

¿Quieres que lo cree también?`,
   },
   {
      id: "1537496492745691156",
      at: "2026-08-13T16:22Z",
      backend: "kimi",
      text: "Entendido. Borro el duplicado #32 (el de las 2:00 PM) y conservamos el de las 8:00 PM. ¿Confirmo?",
   },
   {
      id: "1537498753316032612",
      at: "2026-08-13T16:31Z",
      backend: "kimi",
      text: `Listo. Les puse descripciones y salas a los 4 eventos del calendario y ya los creé en Discord:

- **Ida Vitale | Club de poesía** — mié 2 sep, 8:00 PM → 🫀 Sala de Club de Poesía 🫀
- **Mario Benedetti | Club de poesía** — mié 9 sep, 8:00 PM → 🫀 Sala de Club de Poesía 🫀
- **Idea Vilariño (segunda edición) Parte 1** — mié 23 sep, 8:00 PM → 🎙️ Sala de Eventos 🎙️
- **Idea Vilariño (segunda edición) Parte 2** — mié 30 sep, 8:00 PM → 🎙️ Sala de Eventos 🎙️

Ya quedaron publicados el calendario y el ICS. Si me pasas portadas, se las aplico.`,
   },
   {
      id: "1537499178102694029",
      at: "2026-08-13T16:32Z",
      backend: "kimi",
      text: `¡Yo también te quiero, mi rey/reina! 🫀🦾
A darle con todo al evento.`,
   },
   {
      id: "1537572228743569458",
      at: "2026-08-13T21:23Z",
      backend: "kimi",
      text: "¡Aquí ando! 👋 ¿En qué te ayudo con el calendario?",
   },
];

/**
 * DeepSeek era (from 2026-08-13 15:15 CST). The first two replies were flagged
 * the same evening as "the quality has worsened a lot in Spanish"; the third
 * is the 2026-08-25 #general "emoción-ed" turn.
 */
export const DEEPSEEK_REGRESSIONS: readonly CorpusReply[] = [
   {
      id: "1537630259191480351",
      at: "2026-08-14T01:13Z",
      backend: "deepseek",
      text: `¡Claro! En la Revolución Z las comisiones se proponen y se arman en la **asamblea** — ese es el espacio donde la comunidad define quién participa en cada comisión. Un par de pasos prácticos:

1. **Háblalo con lxs mods** (ellxs coordinan la gestión de eventos) y dile a <@544704579577839616> que le interesa sumarse.
2. **Propónlo en la próxima asamblea ordinaria** — hay una este **sábado 15 de agosto a las 8:00 PM** (evento #18). Ahí se suele ratificar quiénes entran a cada comisión.
3. Si quiere empezar ya a apoyar, puede ayudar con lo que más se necesita: avisar de pelis/temas de la semana, proponer actividades o difundir los eventos cuando salgan publicados en <#1518328211165941912>.

¿Quieres que le pase algún dato más concreto, o que le recuerde la asamblea del sábado?`,
   },
   {
      id: "1537630365106315406",
      at: "2026-08-14T01:14Z",
      backend: "deepseek",
      text: `Ah, claro — ¡para crear eventos no hay que saber nada especial, se le habla como en una conversación normal! Algo así:

**Lo mínimo que necesito:**
- **Título** (el nombre del evento)
- **Cuándo**: día y hora, o cadencia si se repite ("todos los jueves a las 8")

**Ejemplos que funcionan tal cual:**
- *"Crea un taller de zine este sábado 22 a las 5 PM"*
- *"Registra la asamblea extraordinaria para el lunes 17 a las 7"*
- *"Agrega un círculo de lectura todos los miércoles a las 8, 4 sesiones"*

**Cosas opcionales** que puede añadir si quiere: lugar, hora de fin, descripción.

Y un tip importante: si es una **actividad que ya existe como serie** (club de cine, club de poesía…), no se crea un evento nuevo — solo se avisa el tema de la semana: *"esta semana vemos Persepolis"* o *"el jueves toca X"*, y yo lo pongo en la sesión correcta sin duplicar nada.

Si le hace falta algo, le pregunto UNA cosa a la vez y listo. ¿Se lo resumo también por acá en un mensaje para elx?`,
   },
   {
      id: "1541988518379921459",
      at: "2026-08-26T01:51Z",
      backend: "deepseek",
      text: `Estoy **emoción-ed**, jaja. 🔥 Hoy martes a las 8pm está **"Cooperativas en la praxis"** con Yeti en la Sala de eventos. ¡No me digas que no has reservado tu lugar! 😄

Suena va a estar buenísimo — de teoría económica aplicada, de esas que luego luego se bajan a la práctica. ¿Tú já la tenías agendada o te acabo de enterar? 👀`,
   },
];
