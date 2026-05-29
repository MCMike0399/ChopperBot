// One-off migration verification: prove the authenticated IG fetch path works on
// the Pi using the cookies in .env. Fetches ONE account (least rate-limit impact).
// Run: tsx scripts/verify-ig-auth-fetch.ts [username]
import 'dotenv/config';
import { config } from '../src/config.js';
import {
  DirectInstagramFetcher,
  InstagramAuthError,
  type InstagramAuth,
} from '../src/capabilities/instagram_monitor/fetcher.js';

const username = process.argv[2] ?? 'revueltasperiodico';

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

console.log(
  `auth mode: ${auth ? 'AUTHENTICATED' : 'ANONYMOUS'}  account: @${username}  ` +
    `UA: ${config.IG_USER_AGENT ? 'custom (.env)' : 'default'}`,
);

// Mirror production: use the configured IG_USER_AGENT so the fingerprint we
// verify matches what the running service sends.
const fetcher = new DirectInstagramFetcher(auth, 0.5, config.IG_USER_AGENT);
try {
  const posts = await fetcher.fetchRecentPosts(username);
  console.log(`OK: fetched ${posts.length} posts`);
  for (const p of posts.slice(0, 5)) {
    console.log(`  igPostId=${p.igPostId} takenAtMs=${p.takenAtMs} caption=${(p.caption ?? '').slice(0, 50).replace(/\n/g, ' ')}`);
  }
} catch (err) {
  if (err instanceof InstagramAuthError) {
    console.error(`AUTH FAILURE (cookies expired/invalid): ${err.message}`);
    process.exit(2);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP 429/.test(msg)) {
    console.error(`THROTTLED (429) — auth path reached IG but was rate-limited, NOT an auth failure: ${msg}`);
    process.exit(3);
  }
  console.error(`OTHER ERROR: ${msg}`);
  process.exit(1);
}
