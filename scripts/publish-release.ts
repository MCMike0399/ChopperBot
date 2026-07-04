// Publish a release note to the Discord "novedades" (release notes) channel.
//
// The single source of truth for release content is CHANGELOG.md at the repo
// root. This script parses the section for a given version and posts it,
// formatted, to the release channel. It never edits the DB and logs out cleanly.
//
// Usage:
//   tsx scripts/publish-release.ts            # publish the latest (topmost) version
//   tsx scripts/publish-release.ts 1.0.1      # publish a specific version
//   tsx scripts/publish-release.ts 1.0.1 --dry-run   # print the post, don't send
//
// Channel: RELEASE_NOTES_CHANNEL_ID env var, defaulting to the Revolución Z
// novedades channel. Login uses DISCORD_TOKEN (same bot account).
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';

const DEFAULT_RELEASE_CHANNEL_ID = '1519178790058725508';

const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

interface ReleaseSection {
  version: string;
  date: string; // YYYY-MM-DD as written in the changelog
  body: string; // markdown between this header and the next version header
}

function changelogPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'CHANGELOG.md');
}

/** Parse every `## <version> — <date>` section out of CHANGELOG.md, newest first. */
function parseChangelog(md: string): ReleaseSection[] {
  const lines = md.split('\n');
  const headerRe = /^##\s+(\d+\.\d+\.\d+)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/;
  const sections: ReleaseSection[] = [];
  let current: ReleaseSection | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) {
      current.body = buf.join('\n').trim();
      sections.push(current);
    }
  };
  for (const line of lines) {
    const m = headerRe.exec(line);
    if (m) {
      flush();
      current = { version: m[1], date: m[2], body: '' };
      buf = [];
      continue;
    }
    if (current) {
      // A horizontal rule separates versions in the changelog — don't carry it.
      if (line.trim() === '---') continue;
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function formatSpanishDate(iso: string): string {
  const [y, mo, d] = iso.split('-').map((n) => parseInt(n, 10));
  return `${d} de ${MONTHS_ES[mo - 1]} de ${y}`;
}

/** Build the exact Discord message body for a release section. */
function renderPost(section: ReleaseSection): string {
  // Demote `### Section` headings to bold so they render inline on Discord.
  const body = section.body
    .split('\n')
    .map((l) => l.replace(/^###\s+(.*)$/, '**$1**'))
    .join('\n')
    .trim();
  return [
    `🚀 **ChopperBot v${section.version}**`,
    `_${formatSpanishDate(section.date)}_`,
    '',
    body,
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const versionArg = args.find((a) => !a.startsWith('--'));

  const md = readFileSync(changelogPath(), 'utf8');
  const sections = parseChangelog(md);
  if (sections.length === 0) {
    throw new Error('No version sections found in CHANGELOG.md');
  }

  const section = versionArg
    ? sections.find((s) => s.version === versionArg)
    : sections[0]; // topmost = latest
  if (!section) {
    throw new Error(
      `Version ${versionArg} not found in CHANGELOG.md. Available: ${sections
        .map((s) => s.version)
        .join(', ')}`,
    );
  }

  const post = renderPost(section);
  if (post.length > 2000) {
    console.warn(
      `⚠️  Post is ${post.length} chars, over Discord's 2000-char limit — trim the changelog entry.`,
    );
  }

  const channelId = process.env.RELEASE_NOTES_CHANNEL_ID ?? DEFAULT_RELEASE_CHANNEL_ID;

  console.log(`\n--- release note for v${section.version} → channel ${channelId} ---\n`);
  console.log(post);
  console.log('\n--- end ---\n');

  if (dryRun) {
    console.log('(dry run — nothing sent)');
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  await client.login(config.DISCORD_TOKEN);
  await new Promise<void>((resolve) => {
    if (client.isReady()) return resolve();
    client.once('ready', () => resolve());
  });

  try {
    const channel = await client.channels.fetch(channelId);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    ) {
      throw new Error(`channel ${channelId} is not a postable guild text/announcement channel`);
    }
    const sent = await channel.send(post);
    console.log(`✅ Published v${section.version} → #${channel.name} (message ${sent.id})`);
  } finally {
    await client.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
