/**
 * Repair tool: deliver workspace files to a workshop session channel AS THE
 * BOT, keeping the bot's own invariants — the sent message is recorded in the
 * workshop_files manifest (Discord carrier = fallback durable copy) and the
 * bytes are uploaded to MinIO (primary durable copy) when storage is
 * configured. Use after a delivery failure (e.g. the model generated files
 * but never attached them).
 *
 *   npx tsx scripts/workshop-deliver-file.ts <channelId> <relPath...> [--caption "texto"]
 *
 * Default caption: a brief apology note. --dry-run prints what would happen.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AttachmentBuilder, ChannelType, Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { SqliteMemoryStore } from '../src/memory/store.js';
import { WorkshopStore } from '../src/capabilities/workshop/store.js';
import { workspaceDirFor } from '../src/capabilities/workshop/workspace.js';
import { uploadToStorage } from '../src/capabilities/workshop/storage.js';
import { createObjectStorage } from '../src/storage/index.js';

const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
const DRY_RUN = process.argv.includes('--dry-run');
const captionIdx = args.indexOf('--caption');
const caption =
  captionIdx >= 0
    ? args.splice(captionIdx, 2)[1]
    : 'Una disculpa: estos archivos quedaron generados pero no se adjuntaron en su momento. Aquí están. 📄';
const [channelId, ...relPaths] = args;

if (!channelId || relPaths.length === 0) {
  console.error(
    'usage: npx tsx scripts/workshop-deliver-file.ts <channelId> <relPath...> [--caption "texto"] [--dry-run]',
  );
  process.exit(1);
}

const dataDir = resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR);
const wsRoot = workspaceDirFor(dataDir, channelId);
for (const rel of relPaths) {
  if (!existsSync(join(wsRoot, rel))) {
    console.error(`❌ no existe en el workspace: ${rel} (${wsRoot})`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const mem = new SqliteMemoryStore({ path: join(dataDir, 'chopperbot.db') });
  const store = new WorkshopStore(mem.db());
  const session = store.getSession(channelId);
  if (!session) {
    console.error(`❌ no hay sesión de workshop para el canal ${channelId}`);
    process.exit(1);
  }
  const storage = createObjectStorage();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(config.DISCORD_TOKEN);
    await new Promise((res) => client.once('clientReady', res));
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`el canal ${channelId} no es un canal de texto`);
    }

    const files = relPaths.map(
      (rel) => new AttachmentBuilder(join(wsRoot, rel), { name: basename(rel) }),
    );
    if (DRY_RUN) {
      console.log(`dry-run: enviaría ${relPaths.join(', ')} a #${channel.name} con caption:`);
      console.log(`> ${caption}`);
      return;
    }
    const sent = await channel.send({ content: caption, files });
    console.log(`✅ mensaje ${sent.id} enviado a #${channel.name} (${session.user_tag})`);

    for (const rel of relPaths) {
      const bytes = readFileSync(join(wsRoot, rel));
      store.recordFile({
        channelId,
        relPath: rel,
        messageId: sent.id,
        bytes: bytes.length,
        nowMs: Date.now(),
      });
      console.log(`  ✓ manifest: ${rel} (${bytes.length} B)`);
      if (storage) {
        const ok = await uploadToStorage(storage, store, { channelId, relPath: rel, bytes });
        console.log(`  ${ok ? '✓' : '✗'} minio: ${rel}`);
      }
    }
  } finally {
    await client.destroy();
    mem.close();
  }
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
