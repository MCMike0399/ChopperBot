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
      this.fetcher = new DirectInstagramFetcher();
      log.warn(
        { capability: this.id, source: 'direct' },
        'InstagramMonitorCapability initialized in DIRECT mode (no INSTAGRAM_RELAY_LAMBDA_ARN set). OK for local dev; in prod this risks IP throttling.',
      );
    }
  }

  async start({ client }: CapabilityStartDeps): Promise<void> {
    if (!this.store || !this.fetcher) {
      throw new Error('InstagramMonitorCapability.start() called before init()');
    }
    this.scheduler = new InstagramMonitorScheduler({
      store: this.store,
      fetcher: this.fetcher,
      client,
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
