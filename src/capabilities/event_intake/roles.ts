import { PermissionFlagsBits, type GuildMember, type Message, type TextChannel } from 'discord.js';
import {
  effectiveModTokens,
  isModByRole,
  matchModRoles,
  resolveModMentions,
  type ModMentions,
  type NamedRole,
} from '../../discord/mod-roles.js';
import { DEFAULT_AGITPROP_ROLES } from './constants.js';

export { DEFAULT_AGITPROP_ROLES };

/** The tokens actually in force for Agitprop matching. */
export function effectiveAgitpropTokens(tokens: readonly string[]): readonly string[] {
  return effectiveModTokens(tokens.length > 0 ? tokens : DEFAULT_AGITPROP_ROLES);
}

/** Whether any of the member's roles matches an Agitprop token. */
export function isAgitpropByRole(
  memberRoles: ReadonlyArray<NamedRole>,
  tokens: readonly string[],
): boolean {
  return matchModRoles(memberRoles, effectiveAgitpropTokens(tokens)).length > 0;
}

/**
 * Staff (mod approver) OR Agitprop commission — may drive the flyer job, but
 * NOT calendar approval unless they are also a mod.
 */
export async function isFlyerOperator(
  message: Message,
  modTokens: readonly string[],
  agitpropTokens: readonly string[],
): Promise<boolean> {
  if (!message.inGuild()) return false;
  let member: GuildMember | null = message.member;
  if (!member) {
    member = await message.guild.members.fetch(message.author.id).catch(() => null);
  }
  if (!member) return false;
  const roles = member.roles.cache.map((r) => ({ id: r.id, name: r.name }));
  if (isModByRole(roles, modTokens)) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return isAgitpropByRole(roles, agitpropTokens);
}

/** Resolve Agitprop roles into something postable (same pingability rules as mods). */
export async function resolveAgitpropMentions(
  message: Message,
  agitpropTokens: readonly string[],
): Promise<ModMentions> {
  if (!message.inGuild()) {
    return { matched: [], notifyIds: [], silent: [], text: '', notifies: false };
  }
  return resolveAgitpropMentionsInGuild(message.guild, message.channel, agitpropTokens);
}

/** Same as {@link resolveAgitpropMentions} but from a known text channel (no Message). */
export async function resolveAgitpropMentionsInGuild(
  guild: Message['guild'],
  channel: TextChannel | Message['channel'],
  agitpropTokens: readonly string[],
): Promise<ModMentions> {
  if (!guild) {
    return { matched: [], notifyIds: [], silent: [], text: '', notifies: false };
  }
  let roles = guild.roles.cache;
  if (roles.size === 0) roles = await guild.roles.fetch();
  const me = guild.members.me;
  const canMentionAny =
    me !== null &&
    ('permissionsFor' in channel
      ? (channel.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone) ?? false)
      : false);
  return resolveModMentions(
    roles.map((r) => ({ id: r.id, name: r.name, mentionable: r.mentionable })),
    [...effectiveAgitpropTokens(agitpropTokens)],
    { canMentionAny },
  );
}
