// One-time migration: copy every workshop manifest file that only exists as a
// Discord-carrier attachment (storage_key IS NULL) into MinIO on the HDD, and
// record its storage key. Idempotent — rows that already have a key are
// skipped, and rows whose file is found nowhere are reported and left for a
// later run.
//
// Bytes come from the local workspace cache when present (fast path), else by
// re-downloading the carrier message's attachment (message fetch mints a fresh
// CDN url — the same trick as the watcher's rehydrate). Discord login happens
// only if some file is actually missing locally.
//
// Usage:
//   npx tsx scripts/migrate-workshop-to-minio.ts            # migrate
//   npx tsx scripts/migrate-workshop-to-minio.ts --dry-run  # report only
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.js';
import { SqliteMemoryStore } from '../src/memory/store.js';
import { WorkshopStore, type WorkshopFileRecord } from '../src/capabilities/workshop/store.js';
import { workspaceDirFor } from '../src/capabilities/workshop/workspace.js';
import { attachmentNameMatches } from '../src/capabilities/workshop/watcher.js';
import { uploadToStorage } from '../src/capabilities/workshop/storage.js';
import { createObjectStorage } from '../src/storage/index.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function fetchCarrierBytes(
  client: Client,
  rec: WorkshopFileRecord,
): Promise<Uint8Array | null> {
  const channel = await client.channels.fetch(rec.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  const msg = await channel.messages.fetch(rec.message_id).catch(() => null);
  if (!msg) return null;
  const att = [...msg.attachments.values()].find((a) =>
    attachmentNameMatches(a.name, rec.rel_path),
  );
  if (!att) return null;
  const res = await fetch(att.url);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const storage = createObjectStorage();
  if (!storage) {
    console.error('❌ MINIO_* no configurado — nada que migrar a.');
    process.exit(1);
  }
  if (!DRY_RUN && !(await storage!.ensureReady())) {
    console.error('❌ El bucket no está disponible.');
    process.exit(1);
  }

  const dataDir = resolve(process.cwd(), config.CHOPPERBOT_DATA_DIR);
  const mem = new SqliteMemoryStore({ path: join(dataDir, 'chopperbot.db') });
  const store = new WorkshopStore(mem.db());
  const pending = mem
    .db()
    .prepare('SELECT * FROM workshop_files WHERE storage_key IS NULL ORDER BY channel_id, rel_path')
    .all() as WorkshopFileRecord[];

  console.log(
    `${pending.length} archivo(s) sin copia en MinIO${DRY_RUN ? ' (dry-run, no se escribe nada)' : ''}…`,
  );
  if (pending.length === 0) {
    mem.close();
    return;
  }

  // Login only if some file is NOT in the local cache (needs the carrier).
  let client: Client | null = null;
  const ensureClient = async (): Promise<Client> => {
    if (client) return client;
    client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
    await client.login(config.DISCORD_TOKEN);
    await new Promise((res) => client!.once('ready', res));
    return client;
  };

  let migrated = 0;
  let skipped = 0;
  const failures: string[] = [];
  try {
    for (const rec of pending) {
      const label = `${rec.channel_id}/${rec.rel_path}`;
      let bytes: Uint8Array | null = null;
      let source = 'local';
      const localPath = join(workspaceDirFor(dataDir, rec.channel_id), rec.rel_path);
      if (existsSync(localPath)) {
        bytes = readFileSync(localPath);
      } else {
        source = 'discord';
        bytes = await fetchCarrierBytes(await ensureClient(), rec);
      }
      if (!bytes) {
        failures.push(`${label} (no se encontró ni local ni en Discord)`);
        continue;
      }
      if (DRY_RUN) {
        console.log(`  • ${label} — ${bytes.length} B desde ${source} (se subiría)`);
        skipped += 1;
        continue;
      }
      const ok = await uploadToStorage(storage!, store, {
        channelId: rec.channel_id,
        relPath: rec.rel_path,
        bytes,
      });
      if (ok) {
        console.log(`  ✓ ${label} — ${bytes.length} B desde ${source}`);
        migrated += 1;
      } else {
        failures.push(`${label} (falló la subida)`);
      }
    }
  } finally {
    if (client) await client.destroy();
    mem.close();
  }

  console.log(
    `\n${DRY_RUN ? 'Por migrar' : 'Migrados'}: ${DRY_RUN ? skipped : migrated}/${pending.length}`,
  );
  if (failures.length > 0) {
    console.log('Sin migrar:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
