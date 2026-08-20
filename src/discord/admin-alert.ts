import { ChannelType, type Client } from "discord.js";
import { CONFIGURATION_CHANNEL_ID } from "../capabilities/configuration/constants.js";
import { log } from "../log.js";

/**
 * Shared admin/config-channel alert sender, used by every operator-facing
 * alert in the bot (Instagram monitor pause/resume/digest, LLM health, crash
 * restarts). Errors are logged and swallowed — an alert must never bubble up
 * into the caller's loop (polling tick, LLM turn, boot sequence).
 *
 * `logTag` distinguishes the caller in the journal when the send fails.
 *
 * `roleIds` is the explicit allowlist of roles this alert may actually ping —
 * the calendar's "falta crear el evento de Discord" nudge falls back here when
 * the mod-facing channel can't be resolved, and it must still reach the mods.
 * Everything else pings nobody but users: the client-wide policy blocks
 * @everyone/@here, and a message-level policy REPLACES that default rather than
 * merging with it, so the safe parts are spelled out again here.
 */
export async function sendAdminAlert(
   client: Client,
   lines: string[],
   logTag = "admin_alert",
   roleIds: readonly string[] = [],
): Promise<void> {
   try {
      const channel = await client.channels.fetch(CONFIGURATION_CHANNEL_ID);
      if (
         !channel ||
         (channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.DM)
      ) {
         log.warn(
            { channel: CONFIGURATION_CHANNEL_ID },
            `${logTag}.channel_unavailable`,
         );
         return;
      }
      await channel.send({
         content: lines.join("\n"),
         allowedMentions: { parse: ["users"], roles: [...roleIds] },
      });
   } catch (err) {
      log.warn(
         { err, channel: CONFIGURATION_CHANNEL_ID },
         `${logTag}.send_failed`,
      );
   }
}
