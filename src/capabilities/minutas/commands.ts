import {
   ChannelType,
   PermissionFlagsBits,
   type ApplicationCommandData,
   type ChatInputCommandInteraction,
   type Client,
   type GuildMember,
} from "discord.js";
import type Database from "better-sqlite3";
import { log } from "../../log.js";
import {
   isModCaller,
   type NamedRole,
   type TurnAuthority,
} from "../../discord/mod-roles.js";
import { modRoleTokens } from "../mod-authority.js";
import { JOIN_COMMAND, LEAVE_COMMAND } from "./constants.js";
import { UserVisibleError, type MinutasSessions } from "./session.js";
import type { MinutasStore } from "./store.js";
import { allowErrorReply } from "../../discord/error-replies.js";

export function minutasCommandDefinitions(): ApplicationCommandData[] {
   return [
      {
         name: JOIN_COMMAND,
         description:
            "Me uno a tu canal de voz/stage y grabo la sesión para la minuta (solo moderación).",
         dmPermission: false,
         options: [
            {
               name: "titulo",
               description: "Título de la sesión para la minuta (opcional)",
               type: 3, // STRING
               required: false,
               maxLength: 120,
            },
         ],
      },
      {
         name: LEAVE_COMMAND,
         description:
            "Cierro la grabación, transcribo y publico la minuta (solo moderación).",
         dmPermission: false,
      },
   ];
}

/**
 * Guild-scoped registration (instant propagation — global commands take up to
 * an hour). `commands.set` replaces only THIS application's commands in the
 * guild; the bot ships no other slash commands today.
 */
export async function registerMinutasSlashCommands(
   client: Client,
): Promise<void> {
   for (const guild of client.guilds.cache.values()) {
      try {
         await guild.commands.set(minutasCommandDefinitions());
         log.info({ guild: guild.id }, "minutas.commands_registered");
      } catch (err) {
         log.warn({ err, guild: guild.id }, "minutas.commands_register_failed");
      }
   }
}

/**
 * Recording captures private voices: start/stop requires the moderation tier,
 * independently from event approval. Bots excluded; fails closed via isModCaller.
 */
export function resolveInteractionAuthority(
   interaction: ChatInputCommandInteraction,
): TurnAuthority {
   if (!interaction.inGuild() || !interaction.member) return {};
   if (interaction.user.bot) return { isBot: true };
   const guild = interaction.guild;
   const member = interaction.member;
   // Cached GuildMember: roles carry names. Raw API member: role ids only —
   // resolve names through the guild role cache (empty name still matches id
   // tokens, which is what the defaults use).
   if ("cache" in member.roles) {
      const gm = member as GuildMember;
      return {
         memberRoles: gm.roles.cache.map((r): NamedRole => ({
            id: r.id,
            name: r.name,
         })),
         isAdministrator: gm.permissions.has(PermissionFlagsBits.Administrator),
      };
   }
   const ids = member.roles as unknown as string[];
   const perms = interaction.memberPermissions;
   return {
      memberRoles: ids.map((id) => ({
         id,
         name: guild?.roles.cache.get(id)?.name ?? "",
      })),
      isAdministrator:
         typeof perms === "object" &&
         perms !== null &&
         perms.has(PermissionFlagsBits.Administrator),
   };
}

export interface MinutasCommandDeps {
   store: MinutasStore;
   db: Database.Database;
   sessions: MinutasSessions;
   /**
    * Ends the guild's active session and kicks the async finalize pipeline.
    * Returns the ack text for the interaction reply.
    */
   requestLeaveProcessing: (guildId: string, reason: string) => Promise<string>;
}

/**
 * The InteractionCreate listener for /chopperbot-join and /chopperbot-leave.
 * Never throws into the gateway.
 */
export function buildMinutasInteractionHandler(
   deps: MinutasCommandDeps,
): (interaction: unknown) => Promise<void> {
   return async (raw: unknown) => {
      const interaction = raw as ChatInputCommandInteraction;
      try {
         if (!interaction.isChatInputCommand?.()) return;
         if (
            interaction.commandName !== JOIN_COMMAND &&
            interaction.commandName !== LEAVE_COMMAND
         )
            return;
         if (!interaction.inGuild() || !interaction.guild) return;

         if (
            !isModCaller(
               resolveInteractionAuthority(interaction),
               modRoleTokens(deps.db),
            )
         ) {
            await interaction.reply({
               content:
                  "La grabación solo la puede iniciar o cerrar el equipo de moderación.",
               ephemeral: true,
            });
            log.info(
               { user: interaction.user.id, command: interaction.commandName },
               "minutas.command_denied",
            );
            return;
         }

         if (interaction.commandName === JOIN_COMMAND) {
            await handleJoin(interaction, deps);
         } else {
            await handleLeave(interaction, deps);
         }
      } catch (err) {
         log.error({ err }, "minutas.interaction_error");
         try {
            const content = "Se me atravesó un error. Inténtalo de nuevo.";
            // Ephemeral replies reach only the caller and can't flood a
            // channel, so the flood guard must not leave a moderator unsure
            // whether /chopperbot-join worked. A deferred reply may be public:
            // only that path is guarded (and then answered ephemerally).
            if (
               interaction.deferred &&
               !allowErrorReply(
                  interaction.channelId ?? interaction.guildId ?? "unknown",
                  content,
               )
            ) {
               await interaction.deleteReply();
               await interaction.followUp({ content, ephemeral: true });
               return;
            }
            if (interaction.deferred) await interaction.editReply(content);
            else if (!interaction.replied)
               await interaction.reply({
                  content,
                  ephemeral: true,
               });
         } catch {
            /* interaction already answered/expired */
         }
      }
   };
}

async function handleJoin(
   interaction: ChatInputCommandInteraction,
   deps: MinutasCommandDeps,
): Promise<void> {
   if (!deps.store.getOutputChannelId()) {
      await interaction.reply({
         content:
            "No tengo configurado el canal donde publicar las minutas. Un admin puede fijarlo desde la consola de configuración (`config_minutas`) o con `MINUTAS_OUTPUT_CHANNEL_ID`.",
         ephemeral: true,
      });
      return;
   }
   const member = await interaction.guild!.members.fetch(interaction.user.id);
   const voice = member.voice.channel;
   if (
      !voice ||
      (voice.type !== ChannelType.GuildVoice &&
         voice.type !== ChannelType.GuildStageVoice)
   ) {
      await interaction.reply({
         content:
            "Entra primero al canal de voz o stage que quieres que grabe, y luego corres el comando.",
         ephemeral: true,
      });
      return;
   }
   await interaction.deferReply();
   try {
      const row = await deps.sessions.start({
         guild: interaction.guild!,
         channel: voice,
         startedBy: {
            id: interaction.user.id,
            tag: member.displayName || interaction.user.tag,
         },
         title: interaction.options.getString("titulo"),
      });
      await interaction.editReply(
         `🔴 Grabando **${row.channel_name}**${row.title ? ` — _${row.title}_` : ""}. ` +
            "Cierro con `/chopperbot-leave`, cuando el canal quede vacío o cuando termine el evento programado.",
      );
   } catch (err) {
      if (err instanceof UserVisibleError) {
         await interaction.editReply(err.message);
      } else {
         throw err;
      }
   }
}

async function handleLeave(
   interaction: ChatInputCommandInteraction,
   deps: MinutasCommandDeps,
): Promise<void> {
   if (!deps.sessions.getActive(interaction.guildId!)) {
      await interaction.reply({
         content: "No hay ninguna grabación activa en este servidor.",
         ephemeral: true,
      });
      return;
   }
   await interaction.deferReply();
   const ack = await deps.requestLeaveProcessing(
      interaction.guildId!,
      "/chopperbot-leave",
   );
   await interaction.editReply(ack);
}
