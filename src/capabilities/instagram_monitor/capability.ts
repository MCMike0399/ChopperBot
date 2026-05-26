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
