// Deliberately billed, never CI. Build first. Production SQLite is READ ONLY;
// all calendar changes use :memory:. --discord creates and removes a private
// proof channel/room/event, never touches the public board or announcements.
// Usage: npx tsx scripts/live-calendar-banner-smoke.ts IMAGE --title terror
//   --date 2026-10-28 --room lectura [--series] [--clarify] [--discord]
// --announce --discord also replays create + announce, then runs the daily job.
import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
   ChannelType,
   Client,
   GatewayIntentBits,
   PermissionFlagsBits,
} from "discord.js";
const { config } = await import("../dist/config.js");
const { CalendarCapability } =
   await import("../dist/capabilities/calendar/capability.js");
const { CalendarStore } =
   await import("../dist/capabilities/calendar/store.js");
const { SqliteMemoryStore, NamespacedMemory } =
   await import("../dist/memory/store.js");
const { CalendarToolSource } =
   await import("../dist/capabilities/calendar/source.js");
const { OutputChannelPublisher } =
   await import("../dist/capabilities/calendar/publisher.js");
const { createEventSyncer, fetchScheduledEvent } =
   await import("../dist/capabilities/calendar/discord-events.js");
const { createBroadcaster } =
   await import("../dist/capabilities/calendar/broadcast-channels.js");
const { CalendarAnnouncer } =
   await import("../dist/capabilities/calendar/announcer.js");
const { composeToolSources } = await import("../dist/tools/source.js");
const { unsupportedParticipation } =
   await import("../dist/capabilities/calendar/announcement-copy.js");
const { ImageAttachable, sniffImageFormat } =
   await import("../dist/attachments/attachable.js");
const { ask } = await import("../dist/llm/client.js");
const { buildCalendar } = await import("../dist/capabilities/calendar/ics.js");
const { normalizeTitle } =
   await import("../dist/capabilities/calendar/match.js");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args[args.indexOf(`--${name}`) + 1];
assert(args[0] && !args[0].startsWith("--"), "Pass a local flyer image");
const bytes = readFileSync(args[0]);
const format = sniffImageFormat(bytes);
assert(format, "Supported image required");
const now = flag("now") ? new Date(value("now")) : new Date();
const memory = new SqliteMemoryStore({ path: ":memory:" });
const client = new Client({
   intents: [GatewayIntentBits.Guilds],
   allowedMentions: { parse: [] },
});
let proofText: any, proofVoice: any;
let proofAnnouncement: any, proofGeneral: any;
let proofGuild: any;
const createdEvents = new Set<string>();
const artifactDir = mkdtempSync(join(tmpdir(), "calendar-banner-proof-"));
try {
   await new Promise<void>((res, rej) => {
      client.once("clientReady", () => res());
      client.login(config.DISCORD_TOKEN).catch(rej);
   });
   const live = new Database(
      resolve(config.CHOPPERBOT_DATA_DIR, "chopperbot.db"),
      { readonly: true, fileMustExist: true },
   );
   const input = live
      .prepare(
         "SELECT channel_id FROM configuration_bindings WHERE capability_id='calendar' LIMIT 1",
      )
      .get() as { channel_id: string };
   const inputChannel = await client.channels.fetch(input.channel_id);
   assert(inputChannel && "guild" in inputChannel);
   const guild = inputChannel.guild;
   proofGuild = guild;
   const caller = await guild.fetchOwner();
   proofText = await guild.channels.create({
      name: "calendar-banner-proof",
      type: ChannelType.GuildText,
      permissionOverwrites: [
         { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
         {
            id: client.user!.id,
            allow: [
               PermissionFlagsBits.ViewChannel,
               PermissionFlagsBits.ReadMessageHistory,
               PermissionFlagsBits.SendMessages,
               PermissionFlagsBits.AttachFiles,
            ],
         },
      ],
      reason: "Temporary isolated calendar banner verification",
   });
   if (flag("announce")) {
      assert(
         flag("discord"),
         "--announce requires --discord for a real isolated linked event",
      );
      const options = {
         type: ChannelType.GuildText as const,
         permissionOverwrites: proofText.permissionOverwrites.cache.map(
            (o: any) => ({
               id: o.id,
               type: o.type,
               allow: o.allow.bitfield,
               deny: o.deny.bitfield,
            }),
         ),
      };
      proofAnnouncement = await guild.channels.create({
         ...options,
         name: "calendar-announcement-proof",
      });
      proofGeneral = await guild.channels.create({
         ...options,
         name: "calendar-general-proof",
      });
   }
   if (flag("discord"))
      proofVoice = await guild.channels.create({
         name: "Calendar Banner Proof Room",
         type: ChannelType.GuildVoice,
         permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            {
               id: client.user!.id,
               allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.Connect,
               ],
            },
         ],
         reason: "Temporary isolated calendar event verification",
      });
   const carrier = await proofText.send({
      content: "Prueba privada del calendario; se elimina al terminar.",
      files: [{ attachment: bytes, name: `flyer.${format}` }],
      allowedMentions: { parse: [] },
   });
   const imageUrl = carrier.attachments.first()!.url;
   const cap = new CalendarCapability();
   await cap.init({
      memory: new NamespacedMemory(memory, cap.id),
      projectRoot: process.cwd(),
      getDiscordClient: () => client,
   });
   const store = new CalendarStore(memory.db());
   for (const row of new CalendarStore(live).listAll()) {
      if (
         flag("announce") &&
         flag("title") &&
         normalizeTitle(row.title).includes(normalizeTitle(value("title")))
      )
         continue;
      const { id, created_at, updated_at, discord_event_id, ...fields } = row;
      store.create({ ...fields, created_by: "proof-fixture" });
   }
   live.close();
   if (flag("series")) {
      assert(flag("date"));
      store.create({
         created_by: "proof-fixture",
         title: "Círculo de lectura",
         start_at: Date.parse(value("date") + "T20:00:00-06:00"),
         recurrence_freq: "weekly",
         location: "Sala de Lectura",
      });
   }
   // Publishers built by the REAL capability can only post into the proof channel.
   store.setOutputChannelId(proofText.id);
   store.setAnnounceChannelId(proofAnnouncement?.id ?? null);
   const before = store.listAll().length;
   const requestText = flag("request")
      ? value("request")
      : "Crea el evento con los datos de este cartel.";
   const bundle = await cap.buildTurn({
      guildId: guild.id,
      channelId: proofText.id,
      userId: caller.id,
      userTag: "proof-operator",
      isAdministrator: true,
      requestText,
      now,
      attachments: [
         { url: imageUrl, name: "flyer.png", contentType: "image/png" },
      ],
   });
   const syncer = flag("discord")
      ? createEventSyncer({
           client,
           guildId: guild.id,
           store,
           now: () => now.getTime(),
        })
      : null;
   const calls: Array<{ name: string; input: any; result: any }> = [];
   let selectedId: number | undefined;
   const safeSyncer = {
      async sync(id: number, opts: any = {}) {
         selectedId = id;
         const row = store.get(id)!;
         assert(row, "Sync must refer to a real scratch calendar row");
         if (syncer) {
            assert(proofVoice);
            assert(
               !row.discord_event_id || createdEvents.has(row.discord_event_id),
               "Never edit/adopt a public event",
            );
            const original = { title: row.title, location: row.location };
            store.update(row.id, {
               title: `[PRUEBA PRIVADA] ${row.title}`,
               location: proofVoice.name,
            });
            try {
               const synced = await syncer.sync(row.id, opts);
               if (synced.ok && synced.created)
                  createdEvents.add(synced.discordEventId);
               assert(synced.ok, JSON.stringify(synced));
               return synced;
            } finally {
               store.update(row.id, original);
            }
         } else {
            return {
               ok: true,
               discordEventId: "PROOF",
               url: "https://discord.com/events/PROOF/PROOF",
               created: true,
               imageSet: Boolean(opts.imageUrl),
               venue: { kind: "voice", name: row.location },
               startAtLocal: "prueba aislada",
            };
         }
      },
      async refresh() {
         return { ok: true, action: "unchanged" };
      },
      async remove() {
         throw new Error("Delete is outside proof scope");
      },
   };
   // All mutation paths, including theme's automatic sync, use the isolated
   // publisher/syncer. The live bundle contributes prompts/specs only.
   const publisher = new OutputChannelPublisher({
      client,
      store,
      projectRoot: process.cwd(),
      getOutputChannelId: () => proofText.id,
   });
   const realBroadcaster = createBroadcaster({ client, guildId: guild.id });
   const proofBroadcaster = proofAnnouncement
      ? {
           resolve: async (queries: string[]) =>
              (await realBroadcaster.resolve(queries)).map((r: any) => {
                 if (r.reason !== "ok") return r;
                 const name = normalizeTitle(r.match.name);
                 const channel =
                    name.includes("anuncios") ||
                    r.match.id === proofAnnouncement.id
                       ? proofAnnouncement
                       : name.includes("general") ||
                           r.match.id === proofGeneral.id
                         ? proofGeneral
                         : null;
                 assert(
                    channel,
                    `Unexpected proof announcement destination ${r.match.name}`,
                 );
                 return {
                    ...r,
                    match: { id: channel.id, name: channel.name, kind: "text" },
                 };
              }),
           post: async (input: any) => {
              assert(
                 [proofAnnouncement.id, proofGeneral.id].includes(
                    input.target.id,
                 ),
                 "Never publish to a community channel",
              );
              return realBroadcaster.post({
                 ...input,
                 mentions: { roleIds: [], everyone: false },
              });
           },
        }
      : undefined;
   const source = new CalendarToolSource(
      store,
      "proof-operator",
      now.getTime(),
      publisher,
      {
         syncer: safeSyncer,
         allowedImageUrls: [imageUrl],
         guildId: guild.id,
         getDiscordEvent: (id: string) =>
            fetchScheduledEvent(client, guild.id, id),
         ...(proofBroadcaster
            ? {
                 broadcaster: proofBroadcaster,
                 writeAnnouncement: (system: string) =>
                    ask({
                       system,
                       messages: [
                          { role: "user", content: "Escribe el anuncio." },
                       ],
                       tools: composeToolSources([]),
                       effort: "high",
                    }),
                 announcementRequestText: requestText,
                 allowedMentionTokens: [],
                 sourceChannelId: proofText.id,
              }
            : {}),
      },
   );
   const tools = {
      tools: bundle.tools.tools.filter(
         (t: any) =>
            !(
               flag("announce")
                  ? /publish|delete/
                  : /announcement|publish|delete/
            ).test(t.name),
      ),
      async handle(name: string, input: any) {
         const result = await source.handle(name, input);
         calls.push({ name, input, result });
         return result;
      },
   };
   const answer = await ask({
      ...bundle,
      tools,
      messages: [
         {
            role: "user",
            content: requestText,
            attachments: [
               new ImageAttachable(
                  "flyer." + format,
                  "image/" + format,
                  bytes,
                  format,
               ),
            ],
         },
      ],
   });
   console.log(
      JSON.stringify({
         phase: "model-result",
         calls: calls.map((c) => ({ name: c.name, input: c.input })),
         answer,
      }),
   );
   if (flag("clarify")) {
      assert.equal(store.listAll().length, before);
      assert.equal(selectedId, undefined);
      assert(
         !calls.some((c) => /create|update|theme|delete/.test(c.name)),
         "Incomplete flyer must not write",
      );
      assert(answer.includes("?"), "Ask for missing/conflicting data");
   } else {
      assert(
         selectedId,
         "Must finish by syncing Discord plus cover without another confirmation",
      );
      assert(
         calls.some(
            (c) =>
               c.name === "calendar_sync_discord_event" &&
               c.input.image_url === imageUrl,
         ),
         "Must attach offered image as cover",
      );
      const occurrence = store
         .listUpcoming(now.getTime(), 200)
         .find((e: any) => e.id === selectedId)!;
      assert(occurrence, "Scheduled occurrence must exist");
      if (flag("title"))
         assert(
            normalizeTitle(occurrence.title).includes(
               normalizeTitle(value("title")),
            ),
            occurrence.title,
         );
      if (flag("date"))
         assert.equal(
            new Date(occurrence.start_at - 6 * 3600000)
               .toISOString()
               .slice(0, 10),
            value("date"),
         );
      if (flag("time"))
         assert.equal(
            new Date(occurrence.start_at - 6 * 3600000)
               .toISOString()
               .slice(11, 16),
            value("time"),
         );
      if (flag("room"))
         assert(
            normalizeTitle(occurrence.location ?? "").includes(
               normalizeTitle(value("room")),
            ),
            occurrence.location ?? "missing room",
         );
      assert.equal(store.listAll().length, before + (flag("series") ? 0 : 1));
      if (flag("series"))
         assert(
            store.overridesByMaster().get(selectedId)?.size,
            "One occurrence themed",
         );
      if (flag("discord")) {
         const eventId = store.get(selectedId)!.discord_event_id!;
         const event = await guild.scheduledEvents.fetch(eventId);
         assert.equal(event.channelId, proofVoice.id);
         assert.equal(event.scheduledStartTimestamp, occurrence.start_at);
         assert(event.coverImageURL(), "Discord must retain the cover");
         const repeat = await syncer!.sync(selectedId, { imageUrl });
         assert(
            repeat.ok && !repeat.created && repeat.discordEventId === eventId,
            "No duplicate RSVP event",
         );
         const published = store.listPublished();
         assert(
            published.some(
               (p: any) =>
                  p.pub_key ===
                  `pdf:${new Date(Date.now() - 6 * 3600000).toISOString().slice(0, 7)}`,
            ),
         );
         assert(published.some((p: any) => p.pub_key === "ics"));
         for (const row of published) {
            const msg = await proofText.messages.fetch({
               message: row.message_id,
               force: true,
            });
            const attachment = msg.attachments.first();
            assert(attachment);
            const response = await fetch(attachment.url);
            assert(response.ok, `Artifact readback HTTP ${response.status}`);
            const data = Buffer.from(await response.arrayBuffer());
            assert(data.length > 100);
            writeFileSync(join(artifactDir, attachment.name), data, {
               mode: 0o600,
            });
            if (row.pub_key === "ics")
               assert(data.toString().includes("SUMMARY:"));
         }
         console.log(
            JSON.stringify({
               phase: "discord-readback",
               eventId,
               room: proofVoice.name,
               cover: true,
               artifacts: published.map((p: any) => p.pub_key),
               repeatedSyncCreated: false,
               artifactDir,
            }),
         );
      }
      console.log(
         JSON.stringify({
            phase: "extraction",
            title: occurrence.title,
            start: new Date(occurrence.start_at).toISOString(),
            room: occurrence.location,
            recurring: Boolean(occurrence.recurrence_freq),
            rowsAdded: store.listAll().length - before,
         }),
      );
      assert(
         buildCalendar(store.listAll(), { nowMs: now.getTime() }).includes(
            "BEGIN:VEVENT",
         ),
      );
      if (proofAnnouncement) {
         const posts = async (channel: any) =>
            [
               ...(
                  await channel.messages.fetch({ limit: 100, cache: false })
               ).values(),
            ] as any[];
         const initial = await posts(proofAnnouncement);
         assert.equal(
            initial.length,
            1,
            "The requested announcement must post exactly once",
         );
         assert(
            initial[0].content.includes(
               store.get(selectedId)!.discord_event_id!,
            ),
            "Announcement must include the real RSVP link",
         );
         assert.equal(
            unsupportedParticipation(initial[0].content, [
               occurrence.title,
               occurrence.description ?? "",
               requestText,
            ]).length,
            0,
         );
         // Keep only the proof event before driving the real background job:
         // other fixture rows must never cause nudges to an operator channel.
         memory
            .db()
            .prepare("DELETE FROM calendar_events WHERE id <> ?")
            .run(selectedId);
         const daily = () =>
            new CalendarAnnouncer({
               client,
               store,
               getAnnounceChannelId: () => proofAnnouncement.id,
               getAnnounceMentions: () => [],
               getModRoles: () => [],
               getManagementChannelId: () => null,
               getAnnounceHour: () => 0,
               now: () => now.getTime(),
            });
         await daily().run();
         await daily().run();
         assert.equal(
            (await posts(proofAnnouncement)).length,
            1,
            "No second automatic announcement/ping",
         );
         console.log(
            JSON.stringify({
               phase: "announcement-coordination",
               requestedPosts: 1,
               automaticExtraPosts: 0,
               generalPosts: (await posts(proofGeneral)).length,
               content: initial[0].content,
            }),
         );
      }
   }
   console.log(
      JSON.stringify({
         phase: "verification",
         passed: true,
         note: "Billed usage is printed in agent_turn (input/output/reasoning tokens). Calendar DB is isolated; Discord proof effects are private and removed.",
      }),
   );
} finally {
   for (const id of createdEvents) await proofGuild.scheduledEvents.delete(id);
   if (proofVoice) await proofVoice.delete("Calendar banner proof cleanup");
   if (proofAnnouncement)
      await proofAnnouncement.delete("Calendar announcement proof cleanup");
   if (proofGeneral)
      await proofGeneral.delete("Calendar announcement proof cleanup");
   if (proofText) await proofText.delete("Calendar banner proof cleanup");
   await client.destroy();
   memory.close();
}
