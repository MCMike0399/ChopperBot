// Deliberately live/billed, never CI. Build first. Uses scratch SQLite and
// temporary private Discord channels; no production calendar writes or pings.
import "dotenv/config";
import assert from "node:assert/strict";
import {
   Client,
   ChannelType,
   GatewayIntentBits,
   PermissionFlagsBits,
} from "discord.js";
const { config } = await import("../dist/config.js");
const { SqliteMemoryStore } = await import("../dist/memory/store.js");
const { CalendarStore } =
   await import("../dist/capabilities/calendar/store.js");
const { CalendarCapability } =
   await import("../dist/capabilities/calendar/capability.js");
const { CalendarToolSource } =
   await import("../dist/capabilities/calendar/source.js");
const { createBroadcaster } =
   await import("../dist/capabilities/calendar/broadcast-channels.js");
const { CalendarAnnouncer } =
   await import("../dist/capabilities/calendar/announcer.js");
const { composeToolSources } = await import("../dist/tools/source.js");
const { ask } = await import("../dist/llm/client.js");
const { localDateKey } = await import("../dist/capabilities/calendar/time.js");
const client = new Client({
   intents: [GatewayIntentBits.Guilds],
   allowedMentions: { parse: [] },
});
const memory = new SqliteMemoryStore({ path: ":memory:" });
const channels: any[] = [];
const now = new Date();
try {
   await new Promise<void>((resolve, reject) => {
      client.once("clientReady", () => resolve());
      client.login(config.DISCORD_TOKEN).catch(reject);
   });
   const reference = await client.channels.fetch(
      process.env.CHOPPERBOT_CONFIG_CHANNEL_ID!,
   );
   assert(reference && "guild" in reference);
   const guild = reference.guild;
   assert(client.user);
   for (const suffix of ["a", "b"])
      channels.push(
         await guild.channels.create({
            name: `calendar-recovery-proof-${suffix}-${Date.now()}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
               { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
               {
                  id: client.user.id,
                  allow: [
                     PermissionFlagsBits.ViewChannel,
                     PermissionFlagsBits.SendMessages,
                     PermissionFlagsBits.ReadMessageHistory,
                  ],
               },
            ],
         }),
      );
   const [channel, other] = channels;
   const cap = new CalendarCapability();
   await cap.init({ memory, projectRoot: process.cwd() } as any);
   const store = new CalendarStore(memory.db());
   store.setAnnounceChannelId(channel.id);
   store.setAnnounceMentions([]);
   const start = now.getTime() + 30 * 60_000;
   assert.equal(
      localDateKey(start),
      localDateKey(now.getTime()),
      "Run before 23:30 CDMX",
   );
   const event = store.create({
      created_by: client.user.id,
      title: "Prueba privada de recuperación de anuncios",
      start_at: start,
      location: "Sala de pruebas",
   });
   const broadcaster = createBroadcaster({ client, guildId: guild.id });
   const copy =
      "Prueba privada: hoy tenemos una sesión de verificación en la Sala de pruebas. Este mensaje comprueba que el anuncio aprobado se publica una sola vez.";
   function source(override: any = broadcaster, liveWriter = false) {
      return new CalendarToolSource(
         store,
         client.user!.id,
         now.getTime(),
         undefined,
         {
            broadcaster: override,
            sourceChannelId: channel.id,
            allowedMentionTokens: [],
            writeAnnouncement: liveWriter
               ? async (system: string) =>
                    ask({
                       system,
                       messages: [
                          { role: "user", content: "Escribe el anuncio." },
                       ],
                       tools: composeToolSources([]),
                       effort: "high",
                    })
               : async () => copy,
            announcementRequestText: "Publica el anuncio de prueba sin ping.",
            include: [
               "calendar_draft_announcement",
               "calendar_send_announcement",
            ],
         },
      );
   }
   async function draft(extra = {}, tools = source()) {
      const result = await tools.handle("calendar_draft_announcement", {
         event_id: event.id,
         channels: [channel.id],
         mentions: ["nadie"],
         ...extra,
      });
      assert.equal(result.status, "success", JSON.stringify(result.payload));
      return result.payload as any;
   }
   const count = async () =>
      (await channel.messages.fetch({ limit: 100, cache: false })).size;
   const initial = await draft({ publish_now: true });
   assert.equal(await count(), 1);
   const receipt = initial.channels[0].message_id;
   const cached = await channel.messages.fetch(receipt);
   await cached.delete();
   assert.equal(
      await broadcaster.checkReceipt!(
         { id: channel.id, name: channel.name, kind: "text" },
         receipt,
      ),
      "deleted",
   );
   const preview = await draft();
   assert.equal(await count(), 0);
   const sent = await source().handle("calendar_send_announcement", {
      token: preview.token,
   });
   assert.equal(sent.status, "success");
   assert.equal(await count(), 1);
   const newReceipt = (sent.payload as any).channels[0].message_id;
   const readback = await channel.messages.fetch({
      message: newReceipt,
      force: true,
      cache: false,
   });
   assert.equal(readback.content, preview.draft);
   assert.equal(readback.mentions.roles.size, 0);
   assert.equal(readback.mentions.everyone, false);
   assert.deepEqual(
      store.getAnnouncementDraft(preview.token)?.postedMessageIds,
      [newReceipt],
   );
   const daily = () =>
      new CalendarAnnouncer({
         client,
         store,
         getAnnounceChannelId: () => channel.id,
         getAnnounceMentions: () => [],
         getModRoles: () => [],
         getManagementChannelId: () => null,
         getAnnounceHour: () => 0,
         now: () => now.getTime(),
      });
   await daily().run();
   await daily().run();
   assert.equal(await count(), 1);
   console.log(
      "PASS deleted receipt -> preview -> confirmation -> fresh exact readback; two daily jobs sent zero extra posts",
   );
   const intentional = await draft({ repost: true });
   assert.equal(await count(), 1);
   const resend = await source().handle("calendar_send_announcement", {
      token: intentional.token,
   });
   assert.equal(resend.status, "success");
   assert.equal(await count(), 2);
   assert.equal(
      (
         await source().handle("calendar_send_announcement", {
            token: intentional.token,
         })
      ).status,
      "error",
   );
   await daily().run();
   assert.equal(await count(), 2);
   console.log(
      "PASS explicit immediate repost persisted across preview/confirmation; repeated confirmation and daily job sent zero extras",
   );
   const mixed = await draft({
      channels: [channel.id, other.id],
      repost: true,
   });
   let failOther = true;
   const mixedBroadcaster = {
      ...broadcaster,
      post: async (input: any) =>
         input.target.id === other.id && failOther
            ? { ok: false as const, error: "channel_not_sendable" }
            : broadcaster.post(input),
   };
   await source(mixedBroadcaster).handle("calendar_send_announcement", {
      token: mixed.token,
   });
   assert.equal(await count(), 3);
   assert.deepEqual(
      store.getAnnouncementDraft(mixed.token)?.targets.map((t) => t.id),
      [other.id],
   );
   failOther = false;
   const retried = await source(mixedBroadcaster).handle(
      "calendar_send_announcement",
      { token: mixed.token },
   );
   assert.equal(retried.status, "success");
   assert.equal(await count(), 3);
   assert.equal(
      (await other.messages.fetch({ limit: 100, cache: false })).size,
      1,
   );
   assert.equal(
      store.getAnnouncementDraft(mixed.token)?.postedMessageIds.length,
      2,
   );
   console.log(
      "PASS partial failure retried the same approved draft only in the failed destination",
   );
   // Real model replay with the production calendar prompt and bounded real tools.
   const turn = await cap.buildTurn({
      guildId: guild.id,
      channelId: channel.id,
      userId: client.user.id,
      userTag: "synthetic-operator",
      isAdministrator: true,
      now,
   });
   const modelSource = source(broadcaster, true);
   const reply = await ask({
      system: turn.system,
      effort: "high",
      tools: composeToolSources([modelSource]),
      messages: [
         {
            role: "user",
            content: `Publica el anuncio del evento #${event.id} únicamente en <#${channel.id}> sin ping.`,
         },
         {
            role: "assistant",
            content: `Ya publiqué el anuncio #${event.id} en <#${channel.id}>.`,
         },
         {
            role: "user",
            content:
               "A ver, anúncialo otra vez, con solo los datos base y este texto: hoy verificamos que se pueden corregir anuncios. Publícalo ya en el mismo canal sin ping.",
         },
      ],
   });
   assert.equal(
      await count(),
      4,
      `Expected exactly one intentional model repost; reply: ${reply}`,
   );
   assert(
      !/borra.*(?:mensaje|registro)|espera.*minuto|no (?:puedo|salió)/i.test(
         reply,
      ),
      reply,
   );
   console.log(
      "PASS real high-effort model selected intentional repost and delivered exactly one private message:",
      reply,
   );
   console.log(
      JSON.stringify({
         proof: "calendar-delivery-recovery",
         privateMessagesRemaining: 5,
         publicMessages: 0,
         pings: 0,
         productionDbWrites: 0,
      }),
   );
} finally {
   for (const channel of channels.reverse())
      await channel.delete("Completed private calendar delivery proof");
   await client.destroy();
   memory.close();
   console.log("Proof channels removed");
}
