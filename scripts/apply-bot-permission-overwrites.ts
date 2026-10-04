/**
 * Human-authorized application of audit-bot-permissions.ts's minimal checklist.
 * No gateway, no member/role/intents changes. Preserves unrelated overwrite bits.
 * npx tsx scripts/apply-bot-permission-overwrites.ts <audit.txt> <private-backup.json> --apply
 * Run the read-only audit immediately before AND after this operation.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REST, Routes } from "discord.js";
import type { APIGuildChannel, APIRole, APIUser } from "discord.js";
import { config } from "../src/config.js";
import { MODERATION_GUILD_ID as guildId } from "../src/moderation/store.js";

const [auditPath, backupPath, apply] = process.argv.slice(2);
assert(
   auditPath && backupPath && apply === "--apply",
   "Uso: apply-bot-permission-overwrites.ts <audit.txt> <private-backup.json> --apply",
);
assert(
   !resolve(backupPath).startsWith(`${process.cwd()}/`),
   "Backup must remain outside the public repo.",
);
const audit = await readFile(auditPath, "utf8");
const header = JSON.parse(audit.split("\n")[0]);
assert.equal(header.guild_id, guildId);
assert(
   header.without === "1517610228969902130" ||
      (header.without === null && header.administrator_after === false),
);
assert.deepEqual(header.guild_missing, []);
assert(
   !audit.includes("remove_bot_member_deny_bits"),
   "Individual denies need a separate reviewed fix.",
);
const fixes = [
   ...audit.matchAll(
      /^- \[ \] (\d{17,20}): permitir .* \(bits (\d+)\) al rol (\d{17,20}); conservar los otros bits\.$/gm,
   ),
];
assert(fixes.length > 0);
const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
const me = (await rest.get(Routes.user())) as APIUser;
assert.equal(me.id, header.bot_id);
const roles = (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
const managed = roles.find((r) => r.tags?.bot_id === me.id);
assert.equal(managed?.id, header.managed_role_id);
const channels = (await rest.get(
   Routes.guildChannels(guildId),
)) as APIGuildChannel[];
const before = fixes.map(([, id, bits, roleId]) => {
   assert.equal(roleId, managed!.id);
   const channel = channels.find((c) => c.id === id);
   assert(channel, `Unknown guild channel ${id}`);
   return {
      channel_id: id,
      add_allow_bits: bits,
      role_id: roleId,
      overwrites: channel.permission_overwrites ?? [],
   };
});
await writeFile(
   backupPath,
   JSON.stringify(
      {
         guild_id: guildId,
         bot_id: me.id,
         captured_at: new Date().toISOString(),
         before,
      },
      null,
      2,
   ),
   { flag: "wx", mode: 0o600 },
);
for (const row of before) {
   const channel = (await rest.get(
      Routes.channel(row.channel_id),
   )) as APIGuildChannel;
   assert.equal(channel.guild_id, guildId);
   const canonical = (overwrites: typeof row.overwrites) =>
      [...overwrites].sort((a, b) => a.id.localeCompare(b.id));
   assert.deepEqual(
      canonical(channel.permission_overwrites ?? []),
      canonical(row.overwrites),
      "Overwrite drift: re-audit before applying.",
   );
   const old = row.overwrites.find((o) => o.id === row.role_id && o.type === 0);
   const bits = BigInt(row.add_allow_bits);
   const body = {
      type: 0,
      allow: (BigInt(old?.allow ?? "0") | bits).toString(),
      deny: (BigInt(old?.deny ?? "0") & ~bits).toString(),
   };
   await rest.put(Routes.channelPermission(row.channel_id, row.role_id), {
      body,
      reason:
         "Human-authorized least-privilege preparation for removing bot Administrator.",
   });
   const verified = (await rest.get(
      Routes.channel(row.channel_id),
   )) as APIGuildChannel;
   const actual = verified.permission_overwrites?.find(
      (o) => o.id === row.role_id && o.type === 0,
   );
   assert.equal(actual?.allow, body.allow);
   assert.equal(actual?.deny, body.deny);
   console.log(
      JSON.stringify({
         channel_id: row.channel_id,
         role_id: row.role_id,
         added_allow_bits: row.add_allow_bits,
         verified: true,
      }),
   );
}
console.log(
   JSON.stringify({
      applied: before.length,
      roles_changed: false,
      backup: resolve(backupPath),
   }),
);
