import { ChannelType, type Client } from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityStartDeps,
  CapabilityTurnBundle,
  CapabilityTurnContext,
} from '../capability.js';
import { CONFIGURATION_CHANNEL_ID } from '../configuration/constants.js';
import { INSTAGRAM_MONITOR_MIGRATIONS, InstagramMonitorStore } from './store.js';
import {
  DirectInstagramFetcher,
  LambdaInstagramFetcher,
  type InstagramAuth,
  type InstagramFetcher,
} from './fetcher.js';
import { AwsLambdaRelay } from './lambda-relay-client.js';
import { InstagramMonitorScheduler } from './scheduler.js';
import { InstagramMonitorToolSource } from './source.js';
import { renderInstagramMonitorPrompt } from './preamble.js';

export const INSTAGRAM_MONITOR_CAPABILITY_ID = 'instagram_monitor';

export class InstagramMonitorCapability implements Capability {
  readonly id = INSTAGRAM_MONITOR_CAPABILITY_ID;
  readonly description =
    'Monitorea cuentas públicas de Instagram y publica eventos/alertas/convocatorias en el canal de Discord vinculado. Sondeo en segundo plano cada ~20 minutos.';

  private store: InstagramMonitorStore | null = null;
  private fetcher: InstagramFetcher | null = null;
  private scheduler: InstagramMonitorScheduler | null = null;

  async init({ memory }: CapabilityInitDeps): Promise<void> {
    await memory.migrate(this.id, INSTAGRAM_MONITOR_MIGRATIONS);
    this.store = new InstagramMonitorStore(memory.db());

    if (config.INSTAGRAM_RELAY_LAMBDA_ARN) {
      const relay = new AwsLambdaRelay(
        config.INSTAGRAM_RELAY_LAMBDA_ARN,
        config.AWS_REGION_LAMBDA_RELAY,
      );
      this.fetcher = new LambdaInstagramFetcher(relay);
      log.info(
        {
          capability: this.id,
          source: 'lambda',
          arn: config.INSTAGRAM_RELAY_LAMBDA_ARN,
          region: config.AWS_REGION_LAMBDA_RELAY,
        },
        'InstagramMonitorCapability initialized (production: Lambda relay)',
      );
    } else {
      const auth: InstagramAuth | null =
        config.IG_SESSIONID && config.IG_CSRFTOKEN && config.IG_DS_USER_ID
          ? {
              sessionid: config.IG_SESSIONID,
              csrftoken: config.IG_CSRFTOKEN,
              dsUserId: config.IG_DS_USER_ID,
              mid: config.IG_MID,
              igDid: config.IG_DID,
            }
          : null;
      this.fetcher = new DirectInstagramFetcher(auth);
      log.warn(
        { capability: this.id, source: 'direct', authed: auth !== null },
        auth
          ? 'InstagramMonitorCapability initialized in DIRECT+AUTH mode (logged-in IG session cookies). Higher rate limits; session can expire (watch for instagram_monitor.auth.expired).'
          : 'InstagramMonitorCapability initialized in DIRECT mode (no auth). OK for local dev; in prod this risks IP throttling.',
      );
    }
  }

  async start({ client, router }: CapabilityStartDeps): Promise<void> {
    if (!this.store || !this.fetcher) {
      throw new Error('InstagramMonitorCapability.start() called before init()');
    }
    this.scheduler = new InstagramMonitorScheduler({
      store: this.store,
      fetcher: this.fetcher,
      client,
      // Re-read on every tick so live re-bindings take effect without a restart.
      getBoundChannels: () => {
        const out: string[] = [];
        for (const [channelId, capabilityId] of router.getAllBindings()) {
          if (capabilityId === this.id) out.push(channelId);
        }
        return out;
      },
      notifyAuthExpired: ({ account, reason }) =>
        postAuthExpiredAlert(client, account, reason),
    });
    this.scheduler.start();
    log.info({ capability: this.id }, 'InstagramMonitorCapability scheduler started');
  }

  async buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle> {
    if (!this.store || !this.fetcher) {
      throw new Error('InstagramMonitorCapability.buildTurn called before init');
    }
    const source = new InstagramMonitorToolSource({
      store: this.store,
      channelId: ctx.channelId,
      userId: ctx.userId,
      nowMs: ctx.now.getTime(),
      fetcherSource: this.fetcher.source(),
    });
    return {
      system: renderInstagramMonitorPrompt(ctx.now, this.fetcher.source()),
      tools: composeToolSources([source]),
    };
  }

  async dispose(): Promise<void> {
    if (this.scheduler) {
      await this.scheduler.dispose();
      this.scheduler = null;
    }
  }
}

/**
 * Sends an alert to the admin/config Discord channel when IG flags the session.
 * The scheduler already rate-limits these calls to one per 6 h, so this helper
 * just sends; it doesn't need its own dedup. Any send error is logged and
 * swallowed (it must not bubble up into the polling loop).
 *
 * Exported so verification scripts (e.g. `scripts/verify-auth-alert.ts`) can
 * drive this exact code path without faking an IG auth failure.
 */
export async function postAuthExpiredAlert(
  client: Client,
  account: string,
  reason: string,
): Promise<void> {
  try {
    const channel = await client.channels.fetch(CONFIGURATION_CHANNEL_ID);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.DM)
    ) {
      log.warn(
        { channel: CONFIGURATION_CHANNEL_ID },
        'instagram_monitor.auth_alert.channel_unavailable',
      );
      return;
    }
    const lines = [
      '⚠️ **Instagram monitor: sesión bloqueada**',
      `Cuenta probada: \`${account}\``,
      `Detalle: ${reason}`,
      '',
      'Acción:',
      '1. Abre `instagram.com` en el navegador con la cuenta throwaway y completa el reto / "¿Fuiste tú?".',
      '2. Saca cookies nuevas (`sessionid`, `csrftoken`, `ds_user_id`, `mid`, `ig_did`) y reemplázalas en `.env`.',
      '3. `pnpm run build && systemctl --user restart chopperbot.service`.',
      '',
      `Mientras tanto el sondeo está suspendido 1 h y se reanudará automáticamente si la sesión recupera. ` +
        `Cuentas con ≥5 fallos de auth seguidos quedan fuera de la cola hasta el próximo reinicio.`,
    ];
    await channel.send(lines.join('\n'));
  } catch (err) {
    log.warn(
      { err, channel: CONFIGURATION_CHANNEL_ID },
      'instagram_monitor.auth_alert.send_failed',
    );
  }
}
