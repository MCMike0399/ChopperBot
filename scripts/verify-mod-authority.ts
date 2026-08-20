/**
 * READ-ONLY: who can drive the privileged surfaces after the 2026-08-13 gate.
 *
 * The admin console, the calendar's write tools and the Instagram watch list are
 * no longer authorized by channel access alone — a turn's author must hold an
 * approver role (the SAME setting event_intake uses, `config_eventintake
 * set_mod_roles`) or Discord's Administrator permission. That makes one question
 * operationally important: **does anyone still pass?** This answers it against
 * the live DB + the live guild, without sending or writing anything.
 *
 *   npx tsx scripts/verify-mod-authority.ts
 *
 * Reads `event_intake_settings.mod_roles_json`; an empty setting falls back to
 * DEFAULT_MOD_ROLES (never to "everybody"). Needs DISCORD_TOKEN to resolve the
 * tokens against the guild's actual roles — a token that matches NOTHING is the
 * failure mode worth catching here, because in the bot it reads as "nobody is a
 * mod", i.e. a silently dead console.
 */
import "dotenv/config";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { Client, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { config } from "../src/config.js";
import { EventIntakeStore } from "../src/capabilities/event_intake/store.js";
import { effectiveModTokens, matchModRoles } from "../src/discord/mod-roles.js";
import { CONFIGURATION_CHANNEL_ID } from "../src/capabilities/configuration/constants.js";

const DB_PATH =
   process.env.CHOPPERBOT_DB ??
   resolve(config.CHOPPERBOT_DATA_DIR, "chopperbot.db");

async function main(): Promise<void> {
   const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
   let configured: string[] = [];
   try {
      configured = new EventIntakeStore(db).getModRoles();
   } catch {
      console.log(
         "⚠️  event_intake never migrated — falling back to the built-in defaults.",
      );
   }
   const tokens = effectiveModTokens(configured);
   console.log(
      `Approver tokens: ${configured.length > 0 ? "configured" : "DEFAULTS (nothing configured)"}`,
   );
   for (const t of tokens) console.log(`  · ${t}`);

   const client = new Client({ intents: [GatewayIntentBits.Guilds] });
   await client.login(config.DISCORD_TOKEN);
   await new Promise<void>((r) => client.once("clientReady", () => r()));

   for (const guild of client.guilds.cache.values()) {
      const roles = [...(await guild.roles.fetch()).values()].map((r) => ({
         id: r.id,
         name: r.name,
         admin: r.permissions.has(PermissionFlagsBits.Administrator),
      }));
      const matched = matchModRoles(roles, [...tokens]);
      const admins = roles.filter((r) => r.admin);
      const hasConfigChannel = guild.channels.cache.has(
         CONFIGURATION_CHANNEL_ID,
      );
      console.log(
         `\n${guild.name} (${guild.id})${hasConfigChannel ? "  ← holds the config channel" : ""}`,
      );
      console.log(
         `  owner: ${guild.ownerId} (always passes — owners hold Administrator)`,
      );
      console.log(
         matched.length > 0
            ? `  ✅ approver roles present: ${matched.map((r) => `${r.name} [${r.id}]`).join(", ")}`
            : "  ❌ NO approver role matches here — only Administrator holders pass",
      );
      console.log(
         admins.length > 0
            ? `  ✅ roles carrying Administrator: ${admins.map((r) => r.name).join(", ")}`
            : "  ⚠️  no role carries Administrator",
      );
   }

   await client.destroy();
   db.close();
}

void main();
