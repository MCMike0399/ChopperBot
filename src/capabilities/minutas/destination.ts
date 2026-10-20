import {
   ChannelType,
   type Guild,
   type GuildMember,
   type NewsChannel,
   type TextChannel,
} from "discord.js";
import { UserVisibleError } from "./session.js";

/** Recheck the session's destination at start and before publication. */
export async function resolveMinutesDestination(
   guild: Guild,
   channelId: string,
   caller?: GuildMember,
): Promise<TextChannel | NewsChannel> {
   const channel = await guild.channels
      .fetch(channelId, { force: true })
      .catch(() => null);
   if (
      !channel ||
      channel.guildId !== guild.id ||
      (channel.type !== ChannelType.GuildText &&
         channel.type !== ChannelType.GuildAnnouncement)
   ) {
      throw new UserVisibleError(
         "Elige un canal de texto o anuncios de este servidor para publicar la minuta.",
      );
   }
   if (
      caller &&
      !channel.permissionsFor(caller)?.has(["ViewChannel", "SendMessages"])
   ) {
      throw new UserVisibleError(
         "Necesitas poder ver y escribir en el canal elegido para publicar la minuta.",
      );
   }
   const bot = await guild.members.fetchMe({ force: true });
   if (
      !channel
         .permissionsFor(bot)
         ?.has(["ViewChannel", "SendMessages", "AttachFiles"])
   ) {
      throw new UserVisibleError(
         "Necesito ver el canal elegido, enviar mensajes y adjuntar archivos para publicar la minuta.",
      );
   }
   return channel;
}
