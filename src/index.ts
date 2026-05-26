import 'dotenv/config';
import { hydrateFromSecretsManager } from './secrets.js';

await hydrateFromSecretsManager();

const { run } = await import('./app.js');

try {
  await run();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', err);
  process.exit(1);
}
