/**
 * The 📁 archive message posted after "limpiar": the plan partition (what can
 * be re-attached vs what must keep its original carrier), the message content
 * (grouped, capped), and the Discord driver (re-post → re-point manifest →
 * delete only the carriers that no record needs anymore).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveSessionFiles,
  planArchive,
  renderArchiveContent,
  type ArchiveChannel,
} from '../archive.js';
import type { WorkshopFileRecord } from '../store.js';
import { SessionWorkspace } from '../workspace.js';

const CH = '123456789012345678';
const SEND_CAP = 100; // tiny cap so tests don't write real megabytes

function rec(relPath: string, messageId: string, bytes = 0): WorkshopFileRecord {
  return { channel_id: CH, rel_path: relPath, message_id: messageId, bytes, updated_at: 0 };
}

class FakeStore {
  rows = new Map<string, WorkshopFileRecord>();
  fileManifest(channelId: string): WorkshopFileRecord[] {
    return [...this.rows.values()].filter((r) => r.channel_id === channelId);
  }
  recordFile(input: {
    channelId: string;
    relPath: string;
    messageId: string;
    bytes: number;
    nowMs: number;
  }): void {
    this.rows.set(input.relPath, {
      channel_id: input.channelId,
      rel_path: input.relPath,
      message_id: input.messageId,
      bytes: input.bytes,
      updated_at: input.nowMs,
    });
  }
  removeFileRecord(channelId: string, relPath: string): void {
    this.rows.delete(relPath);
  }
}

class FakeChannel implements ArchiveChannel {
  sent: Array<{ id: string; content: string; files: unknown[] }> = [];
  deleted: string[] = [];
  private n = 0;
  async send(payload: { content: string; files?: unknown[] }): Promise<{ id: string }> {
    const id = `new-${++this.n}`;
    this.sent.push({ id, content: payload.content, files: payload.files ?? [] });
    return { id };
  }
  messages = {
    delete: async (messageId: string): Promise<unknown> => {
      this.deleted.push(messageId);
      return null;
    },
  };
}

let dir: string;
let workspace: SessionWorkspace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workshop-archive-'));
  workspace = new SessionWorkspace(dir);
  workspace.ensure();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('planArchive', () => {
  test('partitions by the send cap', () => {
    const plan = planArchive([rec('a.txt', 'm1', 50), rec('big.bin', 'm2', 5000)], SEND_CAP);
    expect(plan.attach.map((r) => r.rel_path)).toEqual(['a.txt']);
    expect(plan.keepInPlace.map((r) => r.rel_path)).toEqual(['big.bin']);
  });
});

describe('renderArchiveContent', () => {
  test('groups uploads vs generated and notes oversized files', () => {
    const content = renderArchiveContent(
      {
        attach: [rec('uploads/libro.pdf', 'm1', 5_400_000), rec('resumen.md', 'm2', 2048)],
        keepInPlace: [rec('uploads/video.zip', 'm3', 24_000_000)],
      },
      9_500_000,
    );
    expect(content).toContain('📁 **Archivos del taller**');
    expect(content).toContain('📥 **Subidos por ti**\n• `uploads/libro.pdf` (5.1 MB)');
    expect(content).toContain('🛠️ **Generados aquí**\n• `resumen.md` (2.0 KB)');
    expect(content).toContain('`uploads/video.zip`');
    expect(content).toContain('su mensaje original');
  });

  test('caps long listings', () => {
    const many = Array.from({ length: 40 }, (_, i) => rec(`f${i}.txt`, 'm', 10));
    const content = renderArchiveContent({ attach: many, keepInPlace: [] }, SEND_CAP * 1000);
    expect(content).toContain('… y');
    expect(content.length).toBeLessThan(2000);
  });
});

describe('archiveSessionFiles', () => {
  test('re-posts files, re-points the manifest and deletes only freed carriers', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a'.repeat(50));
    workspace.writeText('notas.md', 'n'.repeat(60));
    writeFileSync(join(dir, 'big.bin'), 'b'.repeat(500));
    const store = new FakeStore();
    store.rows.set('a.txt', rec('a.txt', 'old-1'));
    store.rows.set('notas.md', rec('notas.md', 'old-2'));
    store.rows.set('big.bin', rec('big.bin', 'old-3'));
    const channel = new FakeChannel();

    const res = await archiveSessionFiles({
      store,
      workspace,
      channel,
      channelId: CH,
      nowMs: () => 1234,
      maxSendBytes: SEND_CAP,
    });

    expect(res.attached).toBe(2);
    expect(res.keptInPlace).toBe(1);
    // One message, two attachments, and the listing mentions the big file.
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].files).toHaveLength(2);
    expect(channel.sent[0].content).toContain('big.bin');
    // Manifest re-pointed: small files at the new message, big file untouched.
    expect(store.rows.get('a.txt')?.message_id).toBe('new-1');
    expect(store.rows.get('notas.md')?.message_id).toBe('new-1');
    expect(store.rows.get('big.bin')?.message_id).toBe('old-3');
    // Only the freed carriers are deleted — never the oversized file's.
    expect(channel.deleted.sort()).toEqual(['old-1', 'old-2']);
  });

  test('drops records whose file is gone for good and posts nothing when empty', async () => {
    const store = new FakeStore();
    store.rows.set('ghost.txt', rec('ghost.txt', 'old-9'));
    const channel = new FakeChannel();

    const res = await archiveSessionFiles({
      store,
      workspace,
      channel,
      channelId: CH,
      nowMs: () => 1,
      maxSendBytes: SEND_CAP,
    });

    expect(res.attached).toBe(0);
    expect(channel.sent).toHaveLength(0);
    expect(channel.deleted).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });

  test('posts a text-only listing when every file is over the cap', async () => {
    writeFileSync(join(dir, 'huge.bin'), 'h'.repeat(500));
    const store = new FakeStore();
    store.rows.set('huge.bin', rec('huge.bin', 'old-7'));
    const channel = new FakeChannel();

    const res = await archiveSessionFiles({
      store,
      workspace,
      channel,
      channelId: CH,
      nowMs: () => 1,
      maxSendBytes: SEND_CAP,
    });

    expect(res.attached).toBe(0);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].files).toHaveLength(0);
    expect(channel.sent[0].content).toContain('huge.bin');
    // The oversized file's carrier is its only durable copy — never deleted.
    expect(channel.deleted).toHaveLength(0);
    expect(store.rows.get('huge.bin')?.message_id).toBe('old-7');
  });
});
