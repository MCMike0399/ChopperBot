/**
 * The on-demand announcement tools, end to end over a REAL in-memory SQLite
 * store with a faked broadcaster and writer.
 *
 * This is the regression guard for the live 2026-08-18 exchange in the calendar
 * channel: a mod asked the bot to publish an announcement in three channels and
 * the bot could only answer that the automatic 10:00 AM post covers it. What the
 * tests pin is the contract that makes doing it safe:
 *
 *  1. drafting posts NOTHING,
 *  2. sending posts the EXACT drafted text (not a re-generated one),
 *  3. a token is single-use, so "sí, publícalo" twice can't double-ping,
 *  4. a non-mod bundle can't reach either tool.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { SqliteMemoryStore } from '../../../memory/store.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../store.js';
import { CalendarToolSource } from '../source.js';
import type { CalendarBroadcaster } from '../broadcast-channels.js';
import type { ChannelResolution } from '../broadcast.js';
import type { DiscordScheduledEvent } from '../discord-events.js';

vi.mock('../../../log.js', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));

const NOW = Date.parse('2026-08-18T20:00:00Z'); // Aug 18, 2:00 PM CDMX
const TOMORROW_8PM = Date.parse('2026-08-20T02:00:00Z'); // Aug 19, 8:00 PM CDMX
const ANNOUNCE_ROLE = '1436225305898389604';
const SOURCE_CHANNEL = '1483675563871961248'; // the live calendar channel

const CHANNELS: Record<string, { id: string; name: string; kind: 'text' | 'forum' }> = {
  eventos: { id: '200000000000000001', name: '📅│eventos', kind: 'text' },
  general: { id: '200000000000000002', name: '💬│general-revz', kind: 'text' },
  // A forum, as the live one is — "anúncialo … y foro poesia" must land there
  // as a new post, not be reported as a channel that doesn't exist.
  'foro poesia': { id: '200000000000000003', name: '🖋│foro-poesía', kind: 'forum' },
};

let memory: InstanceType<typeof SqliteMemoryStore>;
let store: InstanceType<typeof CalendarStore>;
let posts: Array<{
  channelId: string;
  kind: 'text' | 'forum';
  content: string;
  imageUrl: string | null;
  threadTitle: string | null;
  token: string;
}>;
let postResult: (channelId: string) => { ok: true; messageId: string } | { ok: false; error: string };

const writeMock = vi.fn<(system: string) => Promise<string>>();

function fakeBroadcaster(): CalendarBroadcaster {
  return {
    async resolve(queries): Promise<ChannelResolution[]> {
      return queries.map((query) => {
        const hit = CHANNELS[query.toLowerCase()];
        if (hit) return { query, reason: 'ok', match: hit, candidates: [] };
        if (query.toLowerCase() === 'foro') {
          return {
            query,
            reason: 'ambiguous',
            match: null,
            candidates: [CHANNELS['foro poesia']!, { id: '9', name: '🎬│foro-cine', kind: 'forum' }],
          };
        }
        if (query.toLowerCase() === 'staff') {
          return {
            query,
            reason: 'not_sendable',
            match: null,
            candidates: [{ id: '7', name: 'staff', kind: 'text' }],
          };
        }
        return { query, reason: 'unknown', match: null, candidates: [] };
      });
    },
    async post({ target, content, imageUrl, threadTitle, token }) {
      posts.push({ channelId: target.id, kind: target.kind, content, imageUrl, threadTitle, token });
      return postResult(target.id);
    },
  };
}

function makeSource(
  opts: {
    mod?: boolean;
    broadcaster?: CalendarBroadcaster | undefined;
    discordEvent?: DiscordScheduledEvent | null;
  } = {},
) {
  const mod = opts.mod !== false;
  const broadcaster = 'broadcaster' in opts ? opts.broadcaster : fakeBroadcaster();
  return new CalendarToolSource(store, 'mod-user', NOW, undefined, {
    ...(mod
      ? {}
      : {
          include: ['calendar_list_upcoming', 'calendar_search_events', 'calendar_get_event'],
          allowWrite: false,
        }),
    ...(broadcaster ? { broadcaster } : {}),
    writeAnnouncement: writeMock,
    allowedMentionTokens: [ANNOUNCE_ROLE],
    allowedMentionRoles: [{ id: ANNOUNCE_ROLE, name: 'Usuarix' }],
    sourceChannelId: SOURCE_CHANNEL,
    getDiscordEvent: async () => opts.discordEvent ?? null,
  });
}

/** The live poetry club: a weekly series whose next session is tomorrow 8pm. */
function createSeries() {
  return store.create({
    created_by: 'mod-user',
    title: 'Poesía propia: Club de poesía abierto',
    start_at: TOMORROW_8PM,
    recurrence_freq: 'weekly',
  });
}

function payload(res: { status: string; payload: unknown }): Record<string, unknown> {
  return res.payload as Record<string, unknown>;
}

async function draft(
  src: CalendarToolSource,
  input: Record<string, unknown>,
): Promise<{ status: string; payload: Record<string, unknown> }> {
  const res = await src.handle('calendar_draft_announcement', input);
  return { status: res.status, payload: payload(res) };
}

beforeEach(async () => {
  memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  store = new CalendarStore(memory.db());
  posts = [];
  postResult = (channelId) => ({ ok: true, messageId: `msg-${channelId.slice(-1)}` });
  writeMock.mockReset();
  writeMock.mockResolvedValue(
    'Bandaaaa, este miércoles 19 a las 8:00 PM tenemos Círculo de poemas propios. Desempolven sus libretas, lxs tqm 💚',
  );
});

describe('calendar_draft_announcement', () => {
  test('drafts the text, names the channels, and posts NOTHING', async () => {
    const ev = createSeries();
    const { status, payload: p } = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['eventos', 'general', 'foro poesia'],
      instruction: 'que diga bandaaaa, para q desempolven sus libretas',
    });

    expect(status).toBe('success');
    expect(p.posted).toBe(false);
    expect(p.token).toEqual(expect.any(String));
    expect(String(p.draft)).toContain('Bandaaaa');
    expect((p.channels as Array<{ name: string }>).map((c) => c.name)).toEqual([
      '📅│eventos',
      '💬│general-revz',
      '🖋│foro-poesía',
    ]);
    // The whole point: not a single message went out on the draft call.
    expect(posts).toHaveLength(0);
  });

  test('the confirmation says a forum will get a post, not a message', async () => {
    const ev = createSeries();
    const { payload: p } = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['general', 'foro poesia'],
    });
    const channels = p.channels as Array<Record<string, unknown>>;
    expect(channels[0]!.posts_as).toBeUndefined();
    // Mods scanning for the announcement in a forum look for a thread, so the
    // model has to be able to say where it landed.
    expect(String(channels[1]!.posts_as)).toMatch(/post/i);
    expect(String(channels[1]!.post_title)).toContain('Poesía propia');
  });

  test("passes the mod's instruction into the writer prompt", async () => {
    const ev = createSeries();
    await draft(makeSource(), {
      event_id: ev.id,
      channels: ['general'],
      instruction: 'que diga bandaaaa',
    });
    expect(writeMock.mock.calls[0]![0]).toContain('que diga bandaaaa');
  });

  test('an unresolved channel is reported, and the resolved ones still stand', async () => {
    const ev = createSeries();
    const { status, payload: p } = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['general', 'foro', 'staff'],
    });
    expect(status).toBe('success');
    expect((p.channels as unknown[]).length).toBe(1);
    const problems = p.problems as Array<Record<string, unknown>>;
    expect(problems.map((x) => x.reason)).toEqual(['ambiguous', 'not_sendable']);
    // The model is told what to SAY about each, so it asks instead of guessing.
    expect(problems[0]!.what_to_say).toMatch(/pregunta cuál/i);
    expect(problems[1]!.what_to_say).toMatch(/permiso/i);
  });

  test('when nothing resolves it errors with the per-channel reasons', async () => {
    const ev = createSeries();
    const { status, payload: p } = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['nope', 'tampoco'],
    });
    expect(status).toBe('error');
    expect((p.problems as unknown[]).length).toBe(2);
    expect(posts).toHaveLength(0);
  });

  test('mentions default to nobody, and an unauthorized role is refused', async () => {
    const ev = createSeries();
    const silent = await draft(makeSource(), { event_id: ev.id, channels: ['general'] });
    expect(silent.payload.draft).not.toMatch(/<@&/);

    const asked = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['general'],
      mentions: ['999999999999999999'],
    });
    expect(asked.payload.mentions_refused).toEqual(['<@&999999999999999999>']);
    expect(asked.payload.draft).not.toMatch(/<@&/);
  });

  test('an authorized role ping is prefixed to the stored text', async () => {
    const ev = createSeries();
    const { payload: p } = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['general'],
      mentions: [ANNOUNCE_ROLE],
    });
    expect(String(p.draft).startsWith(`<@&${ANNOUNCE_ROLE}>`)).toBe(true);
  });

  test('the live "usa el rol usuarix" ask — a name, not a snowflake', async () => {
    const ev = createSeries();
    const { status, payload: p } = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['general'],
      mentions: ['usuarix'],
    });
    expect(status).toBe('success');
    expect(p.mentions_refused).toBeUndefined();
    expect(String(p.draft).startsWith(`<@&${ANNOUNCE_ROLE}>`)).toBe(true);
    expect(p.mentions).toEqual([{ id: ANNOUNCE_ROLE, mention: `<@&${ANNOUNCE_ROLE}>`, name: 'Usuarix' }]);
  });

  test('the Discord event link rides along; the flyer is not attached', async () => {
    const ev = createSeries();
    store.setDiscordEventId(ev.id, 'DE1');
    const discordEvent: DiscordScheduledEvent = {
      id: 'DE1',
      name: 'Club de poesía abierto',
      description: null,
      startAtMs: TOMORROW_8PM,
      endAtMs: null,
      channelId: 'VC1',
      location: null,
      recurring: false,
      url: 'https://discord.com/events/1/DE1',
      imageUrl: 'https://cdn.discordapp.com/flyer.png',
    };
    const { payload: p } = await draft(makeSource({ discordEvent }), {
      event_id: ev.id,
      channels: ['general'],
    });
    expect(p.has_event_link).toBe(true);
    expect(p.attaches_flyer).toBe(false);
    expect(String(p.draft)).toContain('https://discord.com/events/1/DE1');

    await makeSource({ discordEvent }).handle('calendar_send_announcement', { token: String(p.token) });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.imageUrl).toBeNull();
  });

  test('refuses an event that already started well before now', async () => {
    const past = store.create({
      created_by: 'mod-user',
      title: 'Asamblea de ayer',
      start_at: NOW - 6 * 3_600_000,
    });
    const { status, payload: p } = await draft(makeSource(), {
      event_id: past.id,
      channels: ['general'],
    });
    expect(status).toBe('error');
    expect(String(p.error)).toMatch(/ya empezó/i);
  });

  test('refuses to draft an empty/stub text rather than posting a bad announcement', async () => {
    writeMock.mockResolvedValue('ok');
    const ev = createSeries();
    const { status } = await draft(makeSource(), { event_id: ev.id, channels: ['general'] });
    expect(status).toBe('error');
    expect(store.latestPendingDraft(SOURCE_CHANNEL)).toBeNull();
  });

  test('a writer failure never posts and never parks a draft', async () => {
    writeMock.mockRejectedValue(new Error('llm down'));
    const ev = createSeries();
    const { status } = await draft(makeSource(), { event_id: ev.id, channels: ['general'] });
    expect(status).toBe('error');
    expect(posts).toHaveLength(0);
    expect(store.latestPendingDraft(SOURCE_CHANNEL)).toBeNull();
  });

  test('caps the fan-out instead of blasting every channel named', async () => {
    const ev = createSeries();
    const { status, payload: p } = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(status).toBe('error');
    expect(String(p.error)).toMatch(/Máximo/);
  });

  test('a specific session of a series can be named', async () => {
    const ev = createSeries();
    const nextWeek = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['general'],
      occurrence_date_iso: '2026-08-26',
    });
    expect(nextWeek.status).toBe('success');
    const parked = store.getAnnouncementDraft(String(nextWeek.payload.token))!;
    expect(parked.occurrenceStartAt).toBe(TOMORROW_8PM + 7 * 86_400_000);
  });

  test('a session date the series has no occurrence on is refused', async () => {
    const ev = createSeries();
    const { status } = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['general'],
      occurrence_date_iso: '2026-08-21',
    });
    expect(status).toBe('error');
  });

  test('without a broadcaster (no guild) it says so instead of half-working', async () => {
    const ev = createSeries();
    const { status, payload: p } = await draft(makeSource({ broadcaster: undefined }), {
      event_id: ev.id,
      channels: ['general'],
    });
    expect(status).toBe('error');
    expect(String(p.error)).toMatch(/no tengo el contexto del servidor/i);
  });
});

describe('calendar_send_announcement', () => {
  async function drafted(): Promise<string> {
    const ev = createSeries();
    const { payload: p } = await draft(makeSource(), {
      event_id: ev.id,
      channels: ['eventos', 'general', 'foro poesia'],
      instruction: 'que diga bandaaaa',
    });
    return String(p.token);
  }

  test('posts the EXACT drafted text to the exact drafted channels', async () => {
    const token = await drafted();
    const stored = store.getAnnouncementDraft(token)!;

    const res = await makeSource().handle('calendar_send_announcement', { token });
    expect(res.status).toBe('success');
    expect(posts).toHaveLength(3);
    // Byte-identical to what the mod approved — the whole reason the draft is
    // stored instead of re-generated on confirmation.
    for (const p of posts) expect(p.content).toBe(stored.content);
    expect(posts.map((p) => p.channelId)).toEqual(stored.targets.map((t) => t.id));
  });

  test('the forum target becomes a post with a deterministic title', async () => {
    const token = await drafted();
    await makeSource().handle('calendar_send_announcement', { token });

    const forum = posts.find((p) => p.kind === 'forum')!;
    expect(forum.channelId).toBe(CHANNELS['foro poesia']!.id);
    // A forum lists titles, so the title has to carry the event by itself.
    expect(forum.threadTitle).toContain('Poesía propia');
    expect(forum.threadTitle!.length).toBeLessThanOrEqual(100);
    // Same body everywhere; only the container differs.
    expect(forum.content).toBe(posts.find((p) => p.kind === 'text')!.content);
  });

  test('no forum among the targets means no thread title is invented', async () => {
    const ev = createSeries();
    const { payload: p } = await draft(makeSource(), { event_id: ev.id, channels: ['general'] });
    await makeSource().handle('calendar_send_announcement', { token: String(p.token) });
    expect(posts.map((x) => x.threadTitle)).toEqual([null]);
  });

  test('the token is single-use — a second "sí, publícalo" cannot double-post', async () => {
    const token = await drafted();
    expect((await makeSource().handle('calendar_send_announcement', { token })).status).toBe('success');
    const again = await makeSource().handle('calendar_send_announcement', { token });
    expect(again.status).toBe('error');
    expect(payload(again).already_posted).toBe(true);
    expect(posts).toHaveLength(3); // not 6
  });

  test('each channel gets its own idempotency nonce', async () => {
    const token = await drafted();
    await makeSource().handle('calendar_send_announcement', { token });
    expect(new Set(posts.map((p) => p.token)).size).toBe(1); // same draft token…
    expect(new Set(posts.map((p) => p.channelId)).size).toBe(3); // …distinct channels
  });

  test('an unknown token is refused rather than guessed at', async () => {
    await drafted();
    const res = await makeSource().handle('calendar_send_announcement', { token: 'zzzzzzzz' });
    expect(res.status).toBe('error');
    expect(posts).toHaveLength(0);
  });

  test('a missing token falls back to the newest pending draft of THIS channel', async () => {
    await drafted();
    const res = await makeSource().handle('calendar_send_announcement', {});
    expect(res.status).toBe('success');
    expect(posts).toHaveLength(3);
  });

  test('the fallback cannot reach a draft from another channel', async () => {
    await drafted(); // parked under SOURCE_CHANNEL
    const elsewhere = new CalendarToolSource(store, 'mod-user', NOW, undefined, {
      broadcaster: fakeBroadcaster(),
      writeAnnouncement: writeMock,
      sourceChannelId: 'some-other-channel',
    });
    const res = await elsewhere.handle('calendar_send_announcement', {});
    expect(res.status).toBe('error');
    expect(posts).toHaveLength(0);
  });

  test('an expired draft is re-drafted, not sent with stale wording', async () => {
    const token = await drafted();
    const late = new CalendarToolSource(store, 'mod-user', NOW + 60 * 60_000, undefined, {
      broadcaster: fakeBroadcaster(),
      writeAnnouncement: writeMock,
      sourceChannelId: SOURCE_CHANNEL,
    });
    const res = await late.handle('calendar_send_announcement', { token });
    expect(res.status).toBe('error');
    expect(payload(res).expired).toBe(true);
    expect(posts).toHaveLength(0);
  });

  test('a partial fan-out reports which channels failed', async () => {
    const token = await drafted();
    postResult = (channelId) =>
      channelId === CHANNELS.general!.id
        ? { ok: false, error: 'Missing Permissions' }
        : { ok: true, messageId: 'ok' };
    const res = await makeSource().handle('calendar_send_announcement', { token });
    expect(res.status).toBe('success');
    expect((payload(res).channels as unknown[]).length).toBe(2);
    expect((payload(res).failed as unknown[]).length).toBe(1);
  });

  test('when every channel fails it is an error, not a false confirmation', async () => {
    const token = await drafted();
    postResult = () => ({ ok: false, error: 'Missing Permissions' });
    const res = await makeSource().handle('calendar_send_announcement', { token });
    expect(res.status).toBe('error');
  });
});

describe('authority', () => {
  test('a non-mod bundle is not even offered the announcement tools', () => {
    const names = makeSource({ mod: false })
      .tools()
      .map((t) => t.name);
    expect(names).not.toContain('calendar_draft_announcement');
    expect(names).not.toContain('calendar_send_announcement');
  });

  test('and is hard-refused server-side if it calls them anyway', async () => {
    const ev = createSeries();
    const src = makeSource({ mod: false });
    for (const tool of ['calendar_draft_announcement', 'calendar_send_announcement']) {
      const res = await src.handle(tool, { event_id: ev.id, channels: ['general'], token: 'x' });
      expect(res.status).toBe('error');
      expect(String(payload(res).error)).toMatch(/moderador/i);
    }
    expect(posts).toHaveLength(0);
  });

  test('a mod bundle DOES advertise both tools', () => {
    const names = makeSource()
      .tools()
      .map((t) => t.name);
    expect(names).toContain('calendar_draft_announcement');
    expect(names).toContain('calendar_send_announcement');
  });
});
