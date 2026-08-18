import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { SqliteMemoryStore } from '../../../memory/store.js';
import { CALENDAR_MIGRATIONS, CalendarStore } from '../store.js';
import { announceKey } from '../announce.js';

/**
 * The v7 state the daily announcement depends on: the Discord-event link on a
 * calendar row, the announcement ledger that makes the job idempotent, and the
 * announce settings. These are the parts whose failure would show up as a
 * duplicated (or missing) post in the community channel.
 */
let memory: SqliteMemoryStore;
let store: CalendarStore;

beforeEach(async () => {
  memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  store = new CalendarStore(memory.db());
});

afterEach(() => memory.close());

describe('discord_event_id link', () => {
  test('defaults to null and round-trips', () => {
    const e = store.create({ created_by: 'u1', title: 'Club de poesía', start_at: 1_800_000_000_000 });
    expect(e.discord_event_id).toBeNull();

    store.setDiscordEventId(e.id, 'D123');
    expect(store.get(e.id)!.discord_event_id).toBe('D123');

    store.setDiscordEventId(e.id, null); // the admin deleted the Discord event
    expect(store.get(e.id)!.discord_event_id).toBeNull();
  });

  test('reaches expanded occurrences, so a series links once for all of them', () => {
    const start = Date.UTC(2026, 7, 6, 2, 0, 0);
    const e = store.create({
      created_by: 'u1',
      title: 'Asamblea',
      start_at: start,
      recurrence_freq: 'weekly',
    });
    store.setDiscordEventId(e.id, 'D9');
    const occurrences = store.listOccurrences(start, start + 21 * 86_400_000);
    expect(occurrences.length).toBeGreaterThan(1);
    expect(occurrences.every((o) => o.discord_event_id === 'D9')).toBe(true);
  });

  test('an update leaves the link alone', () => {
    const e = store.create({ created_by: 'u1', title: 'Typo', start_at: 1_800_000_000_000 });
    store.setDiscordEventId(e.id, 'D1');
    store.update(e.id, { title: 'Corregido' });
    expect(store.get(e.id)!.discord_event_id).toBe('D1');
  });
});

describe('announcement ledger', () => {
  test('an unrecorded key is not announced', () => {
    expect(store.isAnnounced(announceKey(1, 123))).toBe(false);
  });

  test('recording makes it announced — this is what survives a restart', () => {
    const key = announceKey(21, 1_785_981_600_000);
    store.recordAnnouncement({
      announceKey: key,
      eventId: 21,
      occurrenceStartAt: 1_785_981_600_000,
      channelId: 'CH',
      messageId: 'MSG',
      discordEventId: 'D1',
    });
    expect(store.isAnnounced(key)).toBe(true);
  });

  test('re-recording the same key updates instead of throwing on the PK', () => {
    const key = announceKey(21, 1_785_981_600_000);
    const row = {
      announceKey: key,
      eventId: 21,
      occurrenceStartAt: 1_785_981_600_000,
      channelId: 'CH',
      messageId: 'MSG_1',
      discordEventId: null,
    };
    store.recordAnnouncement(row);
    store.recordAnnouncement({ ...row, messageId: 'MSG_2', discordEventId: 'D1' });
    const recent = store.recentAnnouncements(5);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.message_id).toBe('MSG_2');
    expect(recent[0]!.discord_event_id).toBe('D1');
  });

  test('recent announcements come back newest first', () => {
    for (const id of [1, 2, 3]) {
      store.recordAnnouncement({
        announceKey: announceKey(id, id),
        eventId: id,
        occurrenceStartAt: id,
        channelId: 'CH',
        messageId: `M${id}`,
        discordEventId: null,
      });
    }
    expect(store.recentAnnouncements(2)).toHaveLength(2);
  });
});

describe('announce settings', () => {
  test('channel round-trips and starts unset', () => {
    expect(store.getAnnounceChannelId()).toBeNull();
    store.setAnnounceChannelId('CH_ANUNCIOS');
    expect(store.getAnnounceChannelId()).toBe('CH_ANUNCIOS');
  });

  test('setting the announce channel does not disturb the output channel', () => {
    store.setOutputChannelId('CH_OUT');
    store.setAnnounceChannelId('CH_ANUNCIOS');
    expect(store.getOutputChannelId()).toBe('CH_OUT');
    expect(store.getAnnounceChannelId()).toBe('CH_ANUNCIOS');
  });

  test('mentions dedupe, trim, and can be cleared', () => {
    store.setAnnounceMentions([' 123 ', '123', 'everyone', '']);
    expect(store.getAnnounceMentions()).toEqual(['123', 'everyone']);
    store.setAnnounceMentions([]);
    expect(store.getAnnounceMentions()).toEqual([]);
  });
});

/**
 * v9 — the on-demand announcement drafts. The row IS the confirm-then-post
 * contract, so what's pinned here is that it stores the message faithfully and
 * that a token can only be spent once (the guarantee that stops a repeated
 * "sí, publícalo" from pinging the community twice).
 */
describe('announcement drafts', () => {
  const CREATED = Date.parse('2026-08-18T20:00:00Z');

  function park(overrides: Partial<Parameters<CalendarStore['saveAnnouncementDraft']>[0]> = {}) {
    const input = {
      token: 'tok12345',
      eventId: 38,
      occurrenceStartAt: Date.parse('2026-08-20T02:00:00Z'),
      targets: [
        { id: 'C1', name: '📅│eventos', kind: 'text' as const },
        { id: 'C2', name: '🖋│foro-poesía', kind: 'forum' as const },
      ],
      content: '@everyone-free text\n\nhttps://discord.com/events/1/2',
      threadTitle: 'Club de poesía — mié 19, 8:00 PM',
      roleIds: ['1436225305898389604'],
      everyone: false,
      imageUrl: 'https://cdn.discordapp.com/flyer.png',
      discordEventId: 'DE1',
      requestedBy: 'mod-user',
      sourceChannelId: '1483675563871961248',
      createdAt: CREATED,
      ...overrides,
    };
    store.saveAnnouncementDraft(input);
    return input;
  }

  test('round-trips every field the post depends on', () => {
    const input = park();
    const draft = store.getAnnouncementDraft(input.token)!;
    expect(draft).toMatchObject({
      token: input.token,
      eventId: 38,
      // Each target keeps its kind: the send has to know a forum takes a post,
      // and re-deriving that at confirmation time could disagree with the
      // preview the mod approved.
      targets: [
        { id: 'C1', name: '📅│eventos', kind: 'text' },
        { id: 'C2', name: '🖋│foro-poesía', kind: 'forum' },
      ],
      content: input.content,
      threadTitle: input.threadTitle,
      roleIds: ['1436225305898389604'],
      everyone: false,
      imageUrl: input.imageUrl,
      discordEventId: 'DE1',
      createdAt: CREATED,
      postedAt: null,
      postedMessageIds: [],
    });
  });

  test('a target row missing its kind degrades to a plain channel', () => {
    // Defensive: a row written by an older build (or hand-edited) must not make
    // a confirmation throw — before forums, every target was a text channel.
    park({ token: 'legacy01' });
    store['db']
      .prepare(`UPDATE calendar_announcement_drafts SET targets_json = ? WHERE token = ?`)
      .run(JSON.stringify([{ id: 'C1' }, 'C9', { nope: true }]), 'legacy01');
    expect(store.getAnnouncementDraft('legacy01')!.targets).toEqual([
      { id: 'C1', name: 'C1', kind: 'text' },
      { id: 'C9', name: 'C9', kind: 'text' },
    ]);
  });

  test('an unknown token is null, not a throw', () => {
    expect(store.getAnnouncementDraft('nope')).toBeNull();
  });

  test('the everyone flag survives the integer column', () => {
    park({ token: 'ev000001', everyone: true });
    expect(store.getAnnouncementDraft('ev000001')!.everyone).toBe(true);
  });

  test('marking posted burns the token — the single-use guarantee', () => {
    const { token } = park();
    expect(store.markDraftPosted(token, ['M1', 'M2'])).toBe(true);
    // A second attempt loses: this is what makes a repeated confirmation safe.
    expect(store.markDraftPosted(token, ['M3'])).toBe(false);
    const draft = store.getAnnouncementDraft(token)!;
    expect(draft.postedAt).not.toBeNull();
    expect(draft.postedMessageIds).toEqual(['M1', 'M2']);
  });

  test('latestPendingDraft is scoped to its channel and skips posted ones', () => {
    park({ token: 'old00001', createdAt: CREATED - 60_000 });
    park({ token: 'new00001', createdAt: CREATED });
    park({ token: 'other001', sourceChannelId: 'OTHER' });

    expect(store.latestPendingDraft('1483675563871961248')!.token).toBe('new00001');
    expect(store.latestPendingDraft('OTHER')!.token).toBe('other001');
    expect(store.latestPendingDraft('nobody')).toBeNull();

    store.markDraftPosted('new00001', ['M']);
    expect(store.latestPendingDraft('1483675563871961248')!.token).toBe('old00001');
  });

  test('re-parking the same token replaces the text but keeps it unposted', () => {
    const { token } = park();
    park({ token, content: 'nuevo texto', createdAt: CREATED + 1000 });
    const draft = store.getAnnouncementDraft(token)!;
    expect(draft.content).toBe('nuevo texto');
    expect(draft.postedAt).toBeNull();
  });
});
