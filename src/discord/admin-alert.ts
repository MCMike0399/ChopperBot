import { ChannelType, type Client } from 'discord.js';
import { CONFIGURATION_CHANNEL_ID } from '../capabilities/configuration/constants.js';
import { log } from '../log.js';

/**
 * Shared admin/config-channel alert sender, used by every operator-facing
 * alert in the bot (Instagram monitor pause/resume/digest, LLM health, crash
 * restarts). Errors are logged and swallowed — an alert must never bubble up
 * into the caller's loop (polling tick, LLM turn, boot sequence).
 *
 * `logTag` distinguishes the caller in the journal when the send fails.
 */
export async function sendAdminAlert(
  client: Client,
  lines: string[],
  logTag = 'admin_alert',
): Promise<void> {
  try {
    const channel = await client.channels.fetch(CONFIGURATION_CHANNEL_ID);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.DM)
    ) {
      log.warn({ channel: CONFIGURATION_CHANNEL_ID }, `${logTag}.channel_unavailable`);
      return;
    }
    await channel.send(lines.join('\n'));
  } catch (err) {
    log.warn({ err, channel: CONFIGURATION_CHANNEL_ID }, `${logTag}.send_failed`);
  }
}
