/**
 * READ-ONLY: who passes each authority tier (v2.3.1) against the LIVE DB + guild.
 *
 *   npx tsx scripts/verify-mod-authority.ts [memberId…]
 *
 * Prints both tiers' effective tokens, every guild role that passes `moderation`
 * and/or `events`, and — for each memberId given — that member's verdict (single
 * member GETs; no member-list intent). Posts nothing, writes nothing, IDs only.
 *
 * The failure mode worth catching: a configured token that matches NO role in
 * the guild reads in the bot as "nobody is a mod" — a silently dead console.
 * The script warns when no non-Administrator role passes a tier.
 */
import "dotenv/config";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { config } from "../src/config.js";
import {
   authoritySnapshot,
   isEventTurn,
   isModTurn,
} from "../src/capabilities/mod-authority.js";

const db = new Database(
   process.env.CHOPPERBOT_DB ??
      resolve(config.CHOPPERBOT_DATA_DIR, "chopperbot.db"),
   { readonly: true, fileMustExist: true },
);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
try {
   const ready = new Promise<void>((r) =>
      client.once("clientReady", () => r()),
   );
   await client.login(config.DISCORD_TOKEN);
   await ready;
   console.log(JSON.stringify({ authority: authoritySnapshot(db) }));
   for (const guild of client.guilds.cache.values()) {
      const roles = await guild.roles.fetch();
      const passing = { moderation: 0, events: 0 };
      for (const role of roles.values()) {
         const caller = {
            memberRoles: [{ id: role.id, name: role.name }],
            isAdministrator: role.permissions.has(
               PermissionFlagsBits.Administrator,
            ),
            isBot: false,
         };
         const byRole = { ...caller, isAdministrator: false };
         if (isModTurn(db, byRole)) passing.moderation++;
         if (isEventTurn(db, byRole)) passing.events++;
         if (isEventTurn(db, caller) || isModTurn(db, caller))
            console.log(
               JSON.stringify({
                  guild: guild.id,
                  role: role.id,
                  moderation: isModTurn(db, caller),
                  events: isEventTurn(db, caller),
               }),
            );
      }
      for (const tier of ["moderation", "events"] as const)
         if (passing[tier] === 0)
            console.log(
               `⚠️  ${guild.id}: no role matches the ${tier} tokens — only Administrator holders pass ${tier}`,
            );
      for (const id of process.argv.slice(2)) {
         const member = await guild.members
            .fetch({ user: id, force: true })
            .catch(() => null);
         if (!member) continue;
         const caller = {
            memberRoles: member.roles.cache.map((r) => ({
               id: r.id,
               name: r.name,
            })),
            isAdministrator: member.permissions.has(
               PermissionFlagsBits.Administrator,
            ),
            isBot: member.user.bot,
         };
         console.log(
            JSON.stringify({
               member: id,
               moderation: isModTurn(db, caller),
               events: isEventTurn(db, caller),
               bot: member.user.bot,
            }),
         );
      }
   }
} finally {
   await client.destroy();
   db.close();
}
