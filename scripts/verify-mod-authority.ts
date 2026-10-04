/** Read-only live proof: no member list intent, no posts or effects. IDs only. */
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
      for (const role of roles.values()) {
         const caller = {
            memberRoles: [{ id: role.id, name: role.name }],
            isAdministrator: role.permissions.has(
               PermissionFlagsBits.Administrator,
            ),
            isBot: false,
         };
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
