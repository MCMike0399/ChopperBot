import {
   PermissionFlagsBits as P,
   Routes,
   type APIGuildMember,
   type Guild,
   type GuildBasedChannel,
} from "discord.js";

interface RoleSnapshot {
   id: string;
   permissions: bigint;
}
interface OverwriteSnapshot {
   id: string;
   type: number;
   allow: bigint;
   deny: bigint;
}
export interface AudienceSnapshot {
   id: string;
   overwrites: OverwriteSnapshot[];
}
interface MemberSnapshot {
   id: string;
   roleIds: string[];
}

function projected(bits: bigint, audit = false): number {
   return audit
      ? bits & P.ViewAuditLog
         ? 3
         : 0
      : (bits & P.ViewChannel ? 1 : 0) | (bits & P.ReadMessageHistory ? 2 : 0);
}

/** Proves every possible destination viewer can read the source, not just caller.
 * Role combinations are overapproximated (<=4096 bit signatures). Individual
 * overwrites use resolved members. Source=null models guild audit permission.
 */
export function audienceContained(
   guildId: string,
   roles: RoleSnapshot[],
   source: AudienceSnapshot | null,
   destination: AudienceSnapshot,
   members: MemberSnapshot[],
   ownerId: string,
): boolean {
   const byRole = new Map(roles.map((r) => [r.id, r]));
   const everyone = byRole.get(guildId);
   if (!everyone) return false;
   const channels = [source, destination].filter(
      (c): c is AudienceSnapshot => !!c,
   );
   for (const channel of channels)
      for (const o of channel.overwrites) {
         if ((o.type !== 0 && o.type !== 1) || (o.allow & o.deny) !== 0n)
            return false;
         if (o.type === 0 && !byRole.has(o.id)) return false;
         if (o.type === 1 && !members.some((m) => m.id === o.id)) return false;
      }
   const overwrite = (c: AudienceSnapshot | null, id: string) =>
      c?.overwrites.find((o) => o.type === 0 && o.id === id);
   const signature = (r: RoleSnapshot): number => {
      const src = overwrite(source, r.id),
         dst = overwrite(destination, r.id);
      return (
         projected(r.permissions, source === null) |
         (projected(r.permissions) << 2) |
         (projected(src?.deny ?? 0n) << 4) |
         (projected(src?.allow ?? 0n) << 6) |
         (projected(dst?.deny ?? 0n) << 8) |
         (projected(dst?.allow ?? 0n) << 10)
      );
   };
   const apply = (
      base: number,
      c: AudienceSnapshot | null,
      state: number,
      shift: number,
      memberId?: string,
   ): number => {
      if (!c) return base;
      const eo = overwrite(c, guildId);
      let bits =
         (base & ~projected(eo?.deny ?? 0n)) | projected(eo?.allow ?? 0n);
      bits = (bits & ~((state >> shift) & 3)) | ((state >> (shift + 2)) & 3);
      const mo =
         memberId &&
         c.overwrites.find((o) => o.type === 1 && o.id === memberId);
      if (mo) bits = (bits & ~projected(mo.deny)) | projected(mo.allow);
      return bits;
   };
   const safe = (state: number, memberId?: string) => {
      const srcBase =
         (state & 3) | projected(everyone.permissions, source === null);
      const dstBase = ((state >> 2) & 3) | projected(everyone.permissions);
      return (
         !(apply(dstBase, destination, state, 8, memberId) & 1) ||
         apply(srcBase, source, state, 4, memberId) === 3
      );
   };
   // Administrators and the owner bypass all channel overwrites in both sources.
   const ordinary = roles.filter(
      (r) => r.id !== guildId && !(r.permissions & P.Administrator),
   );
   let states = new Set([0]);
   for (const r of ordinary) {
      const sig = signature(r);
      if (sig)
         states = new Set([...states, ...[...states].map((s) => s | sig)]);
   }
   if ([...states].some((s) => !safe(s))) return false;
   for (const m of members) {
      if (m.roleIds.some((id) => !byRole.has(id))) return false;
      if (
         m.id === ownerId ||
         everyone.permissions & P.Administrator ||
         m.roleIds.some(
            (id) => !!(byRole.get(id)!.permissions & P.Administrator),
         )
      )
         continue;
      const state = m.roleIds
         .filter((id) => id !== guildId)
         .reduce((s, id) => s | signature(byRole.get(id)!), 0);
      if (!safe(state, m.id)) return false;
   }
   return true;
}

/** Fresh single-member GETs handle individual grants without GuildMembers intent.
 * Initially excludes cross-channel threads: membership is a separate audience.
 */
export async function verifyAudienceContainment(
   guild: Guild,
   source: GuildBasedChannel | null,
   destination: GuildBasedChannel,
): Promise<boolean> {
   try {
      if (
         destination.guildId !== guild.id ||
         (source && source.guildId !== guild.id)
      )
         return false;
      if (
         ![0, 5].includes(destination.type) ||
         (source && ![0, 5].includes(source.type))
      )
         return false;
      if (
         !("permissionOverwrites" in destination) ||
         (source && !("permissionOverwrites" in source))
      )
         return false;
      const snapshot = (c: GuildBasedChannel): AudienceSnapshot => ({
         id: c.id,
         overwrites:
            "permissionOverwrites" in c
               ? c.permissionOverwrites.cache.map((o) => ({
                    id: o.id,
                    type: o.type,
                    allow: o.allow.bitfield,
                    deny: o.deny.bitfield,
                 }))
               : [],
      });
      const src = source ? snapshot(source) : null,
         dst = snapshot(destination);
      const roles = (await guild.roles.fetch()).map((r) => ({
         id: r.id,
         permissions: r.permissions.bitfield,
      }));
      const ids = [
         ...new Set(
            [...(src?.overwrites ?? []), ...dst.overwrites]
               .filter((o) => o.type === 1)
               .map((o) => o.id),
         ),
      ];
      const members: MemberSnapshot[] = [];
      for (const id of ids) {
         // Raw IDs matter: GuildMember.roles.cache can silently omit an
         // unresolved role. Never turn that missing role into a safety proof.
         const member = (await guild.client.rest.get(
            Routes.guildMember(guild.id, id),
         )) as APIGuildMember;
         if (!Array.isArray(member.roles)) return false;
         members.push({ id, roleIds: member.roles });
      }
      return audienceContained(
         guild.id,
         roles,
         src,
         dst,
         members,
         guild.ownerId,
      );
   } catch {
      return false;
   }
}
