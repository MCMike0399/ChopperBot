import 'dotenv/config';
import { run } from './app.js';

try {
  await run();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', err);
  process.exit(1);
}
