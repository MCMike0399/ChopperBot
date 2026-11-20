import { PermissionFlagsBits, type Message } from "discord.js";
import { log } from "../../log.js";

export interface DeleteMaliciousOpts {
   /** Operator switch (`VIRUSTOTAL_DELETE_MALICIOUS`). False = warn-only. */
   enabled: boolean;
   fileName: string;
}

/**
 * Whether the bot may delete *someone else's* message here. `ManageMessages` is
 * the bit that governs it inside threads too. Discord can't remove a single
 * attachment, so the whole message goes — which is why this is gated anyway.
 * Returns true when permissions can't be resolved: never block on uncertainty,
 * and the delete call itself is wrapped.
 */
export function canDeleteMessage(message: Message): boolean {
   if (!message.inGuild()) return true;
   const me = message.guild.members.me;
   if (!me) return true;
   const perms = message.channel.permissionsFor(me);
   if (!perms) return true;
   return perms.has(PermissionFlagsBits.ManageMessages);
}

/**
 * Delete the upload message that carried a 🛑 malicious file.
 *
 * Discord has no per-attachment delete, so the whole message (its text and every
 * attachment on it) is removed — including any clean file that shared the
 * upload. The audit trail survives: the hash, counts, uploader and the verdict
 * card stay in `file_scanner_scans` and in the channel.
 *
 * Never throws: a permission denial or an already-deleted message is logged and
 * reported as `false`, and the verdict card says nothing about deletion.
 */
export async function deleteMaliciousMessage(
   message: Message,
   opts: DeleteMaliciousOpts,
): Promise<boolean> {
   if (!opts.enabled) return false;
   if (!canDeleteMessage(message)) {
      log.warn(
         {
            channelId: message.channelId,
            guildId: message.guildId,
            messageId: message.id,
            fileName: opts.fileName,
         },
         "file_scanner.watcher.cannot_delete",
      );
      return false;
   }
   try {
      await message.delete();
      log.warn(
         {
            channelId: message.channelId,
            guildId: message.guildId,
            messageId: message.id,
            uploader: message.author?.id ?? null,
            fileName: opts.fileName,
         },
         "file_scanner.watcher.deleted_malicious",
      );
      return true;
   } catch (err) {
      log.error(
         { err, channelId: message.channelId, messageId: message.id },
         "file_scanner.watcher.delete_failed",
      );
      return false;
   }
}
