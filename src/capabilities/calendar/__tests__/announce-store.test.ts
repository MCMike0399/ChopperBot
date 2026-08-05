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
