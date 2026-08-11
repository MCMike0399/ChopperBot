import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The announcement must reach the community EXACTLY once.
 *
 * This file exists because of a real incident on the feature's first live run:
 * one `send()` call, one model call — and two identical announcements 23 s apart,
 * each @-pinging the whole member role. Discord has no idempotency key for
 * message creation, so a create whose response is lost gets retried by
 * `@discordjs/rest` and lands twice. The announcer therefore verifies its own
 * send; these tests are what keep that verification honest.
 */
vi.mock('../../../llm/client.js', () => ({
  ask: vi.fn(async () => 'Amixes, hoy a las 8:00 PM tenemos Club de poesía. Lxs tqm.'),
}));

const fetchScheduledEvents = vi.fn();
const fetchScheduledEvent = vi.fn();
vi.mock('../discord-events.js', () => ({
  fetchScheduledEvents: (...args: unknown[]) => fetchScheduledEvents(...args),
  fetchScheduledEvent: (...args: unknown[]) => fetchScheduledEvent(...args),
}));

const { SqliteMemoryStore } = await import('../../../memory/store.js');
const { CALENDAR_MIGRATIONS, CalendarStore } = await import('../store.js');
const { CalendarAnnouncer } = await import('../announcer.js');
const { announceKey, announceNonce, MAX_NONCE_LENGTH } = await import('../announce.js');

const BOT_ID = 'BOT';
const CHANNEL_ID = 'CH_ANUNCIOS';
const GUILD_ID = 'G1';
/** 8:00 PM CDMX on 2026-08-05, and 1:00 PM the same day (past the 10:00 gate). */
const EVENT_START = Date.UTC(2026, 7, 6, 2, 0, 0);
const NOW = Date.UTC(2026, 7, 5, 19, 0, 0);

interface FakeMessage {
  id: string;
  author: { id: string } | null;
  deleted: boolean;
  delete(): Promise<unknown>;
}

interface SendPayload {
  content: string;
  nonce?: string;
  enforceNonce?: boolean;
}

/**
 * A channel that can be told to duplicate a send — i.e. to behave the way
 * Discord did when the bug fired: the message is created N times, and the id of
 * the LAST one is what comes back to the caller.
 *
 * `honourNonce` models real Discord: with `enforce_nonce`, a create whose nonce
 * was already used by the same author in this channel returns the EXISTING
 * message instead of making another. Off by default so the pre-existing sweep
 * tests keep exercising the unprotected path.
 */
class FakeChannel {
  readonly messages_: FakeMessage[] = [];
  guildId = GUILD_ID;
  sends = 0;
  /** Every payload `send()` was called with, for asserting the wire shape. */
  readonly payloads: SendPayload[] = [];
  private seq = 100;
  private readonly byNonce = new Map<string, FakeMessage>();

  constructor(
    /** How many messages each `send()` actually creates server-side. */
    private readonly copiesPerSend = 1,
    /** When true, `send()` rejects even though the copies were created. */
    private readonly rejectAfterCreating = false,
    /** Whether this channel implements Discord's `enforce_nonce` dedup. */
    private readonly honourNonce = false,
  ) {
    // Start non-empty: an empty channel has no "since" mark to sweep from, which
    // is a separate (and deliberately unswept) case.
    this.push('1');
  }

  private push(id: string): FakeMessage {
    const msg: FakeMessage = {
      id,
      author: { id: BOT_ID },
      deleted: false,
      delete: async () => {
        msg.deleted = true;
        const i = this.messages_.indexOf(msg);
        if (i >= 0) this.messages_.splice(i, 1);
        return undefined;
      },
    };
    this.messages_.push(msg);
    return msg;
  }

  isTextBased(): boolean {
    return true;
  }

  async send(payload: SendPayload): Promise<{ id: string }> {
    this.sends += 1;
    this.payloads.push(payload);
    const key = payload.enforceNonce ? payload.nonce : undefined;
    let last = '';
    for (let i = 0; i < this.copiesPerSend; i++) {
      // Each iteration is one HTTP attempt. Discord dedups them by nonce.
      const existing = this.honourNonce && key !== undefined ? this.byNonce.get(key) : undefined;
      if (existing) {
        last = existing.id;
        continue;
      }
      const created = this.push(String(++this.seq));
      if (key !== undefined) this.byNonce.set(key, created);
      last = created.id;
    }
    if (this.rejectAfterCreating) throw new Error('Request timed out');
    return { id: last };
  }

  get messages() {
    const all = this.messages_;
    return {
      fetch: async (options: { limit?: number; after?: string }) => {
        const sorted = [...all].sort((a, b) => Number(b.id) - Number(a.id)); // newest first
        const picked = options.after
          ? sorted.filter((m) => Number(m.id) > Number(options.after))
          : sorted.slice(0, options.limit ?? 50);
        return new Map(picked.map((m) => [m.id, m]));
      },
    };
  }

  /** Announcements currently visible to the community. */
  liveBotMessages(): FakeMessage[] {
    return this.messages_.filter((m) => m.author?.id === BOT_ID && m.id !== '1');
  }
}

let memory: InstanceType<typeof SqliteMemoryStore>;
let store: InstanceType<typeof CalendarStore>;

function makeAnnouncer(channel: FakeChannel) {
  const client = {
    user: { id: BOT_ID },
    channels: { fetch: async () => channel },
    guilds: { fetch: async () => ({ roles: { cache: new Map(), fetch: async () => new Map() }, members: {} }) },
  };
  return new CalendarAnnouncer({
    client: client as never,
    store,
    getAnnounceChannelId: () => CHANNEL_ID,
    getAnnounceMentions: () => ['ROLE_1'],
    getModRoles: () => [],
    getManagementChannelId: () => null,
    getAnnounceHour: () => 10,
    now: () => NOW,
  });
}

beforeEach(async () => {
  memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  store = new CalendarStore(memory.db());
  store.setAnnounceChannelId(CHANNEL_ID);
  const created = store.create({
    created_by: 'mod',
    title: 'Rosario Castellanos | Club de poesía',
    start_at: EVENT_START,
  });
  // Already linked, so the run needs no matching and produces no mod nudge.
  store.setDiscordEventId(created.id, 'DISCORD_EVENT_1');
  fetchScheduledEvents.mockResolvedValue([
    {
      id: 'DISCORD_EVENT_1',
      name: 'Club de Poesía: Rosario Castellanos',
      description: null,
      startAtMs: EVENT_START,
      endAtMs: null,
      channelId: null,
      location: null,
      recurring: false,
      url: 'https://discord.com/events/G1/DISCORD_EVENT_1',
    },
  ]);
  fetchScheduledEvent.mockResolvedValue(null);
});

afterEach(() => {
  memory.close();
  vi.clearAllMocks();
});

describe('the happy path', () => {
  test('posts once and records the message it posted', async () => {
    const channel = new FakeChannel();
    const report = await makeAnnouncer(channel).run();

    expect(report.announced).toHaveLength(1);
    expect(report.announced[0]!.posted).toBe(true);
    expect(channel.liveBotMessages()).toHaveLength(1);
    expect(store.isAnnounced(announceKey(1, EVENT_START))).toBe(true);
    expect(report.announced[0]!.messageId).toBe(channel.liveBotMessages()[0]!.id);
  });

  test('includes the Discord event link so members can RSVP', async () => {
    const channel = new FakeChannel();
    const report = await makeAnnouncer(channel).run();
    expect(report.announced[0]!.text).toContain('https://discord.com/events/G1/DISCORD_EVENT_1');
    expect(report.announced[0]!.link).toBe('stored');
  });
});

describe('a retried create (the live incident)', () => {
  test('leaves exactly one announcement in the channel', async () => {
    // Discord created the message twice and returned the second id.
    const channel = new FakeChannel(2);
    const report = await makeAnnouncer(channel).run();

    expect(channel.liveBotMessages()).toHaveLength(1);
    expect(report.announced[0]!.posted).toBe(true);
  });

  test('keeps the one members already saw — the earliest — and deletes the retry', async () => {
    const channel = new FakeChannel(2);
    const report = await makeAnnouncer(channel).run();

    const survivor = channel.liveBotMessages()[0]!;
    expect(survivor.id).toBe('101'); // first copy, not the '102' the send returned
    expect(report.announced[0]!.messageId).toBe('101');
  });

  test('records the surviving message, not the deleted duplicate', async () => {
    const channel = new FakeChannel(2);
    await makeAnnouncer(channel).run();
    expect(store.recentAnnouncements(1)[0]!.message_id).toBe('101');
  });

  test('cleans up however many copies landed', async () => {
    const channel = new FakeChannel(3);
    await makeAnnouncer(channel).run();
    expect(channel.liveBotMessages()).toHaveLength(1);
  });
});

/**
 * The sweep above is a *repair*: it runs after the copies exist, so the
 * community has already been @-pinged once per copy — deleting a message does
 * not retract its notification. On 2026-08-11 three copies landed at 10:05 and
 * an admin deleted two by hand nine seconds before the sweep could, which is
 * why the journal recorded `duplicatesRemoved: 0` for a triple-posted morning.
 *
 * So the create itself has to be idempotent. These tests pin the prevention.
 */
describe('the create is idempotent (nonce + enforceNonce)', () => {
  test('carries a nonce and asks Discord to enforce it', async () => {
    const channel = new FakeChannel();
    await makeAnnouncer(channel).run();

    const [payload] = channel.payloads;
    expect(payload!.enforceNonce).toBe(true);
    expect(payload!.nonce).toBe(announceNonce(1, EVENT_START));
    expect(payload!.nonce!.length).toBeLessThanOrEqual(MAX_NONCE_LENGTH);
  });

  test('a retried create never becomes a second message — so it never pings twice', async () => {
    // Three HTTP attempts, Discord honouring the nonce: one message, and the
    // sweep has nothing to clean up because nothing extra was ever created.
    const channel = new FakeChannel(3, false, true);
    const report = await makeAnnouncer(channel).run();

    expect(channel.liveBotMessages()).toHaveLength(1);
    expect(report.announced[0]!.posted).toBe(true);
    expect(report.announced[0]!.messageId).toBe('101');
    expect(channel.liveBotMessages().some((m) => m.deleted)).toBe(false);
  });

  test('two overlapping passes for the same occurrence collapse to one post', async () => {
    // What an announce tick that outlives the 5-minute interval looks like: both
    // passes read a ledger that says "not announced" and both send.
    const channel = new FakeChannel(1, false, true);
    await Promise.all([makeAnnouncer(channel).run(), makeAnnouncer(channel).run()]);

    expect(channel.sends).toBe(2);
    expect(channel.liveBotMessages()).toHaveLength(1);
  });

  test('a deliberate repost is NOT swallowed as a duplicate', async () => {
    const channel = new FakeChannel(1, false, true);
    await makeAnnouncer(channel).run();
    await makeAnnouncer(channel).run({ ignoreLedger: true });

    expect(channel.liveBotMessages()).toHaveLength(2);
    expect(channel.payloads[1]!.nonce).not.toBe(channel.payloads[0]!.nonce);
  });
});

describe('a send that fails after the message landed', () => {
  test('adopts the orphan instead of reporting failure', async () => {
    const channel = new FakeChannel(1, true);
    const report = await makeAnnouncer(channel).run();

    expect(report.announced[0]!.posted).toBe(true);
    expect(report.announced[0]!.error).toBeUndefined();
    expect(channel.liveBotMessages()).toHaveLength(1);
  });

  test('and therefore does not announce again on the next tick', async () => {
    const channel = new FakeChannel(1, true);
    await makeAnnouncer(channel).run();
    const second = await makeAnnouncer(channel).run();

    expect(second.announced).toHaveLength(0);
    expect(channel.liveBotMessages()).toHaveLength(1);
  });
});

describe('model spend', () => {
  test('an ambiguous match costs no model call when nothing is due', async () => {
    const { ask } = await import('../../../llm/client.js');
    // Unlink the row and offer only a weak same-hour candidate → ambiguous.
    store.setDiscordEventId(1, null);
    fetchScheduledEvents.mockResolvedValue([
      {
        id: 'OTHER',
        name: 'CineClub: I, Daniel Blake',
        description: null,
        startAtMs: EVENT_START,
        endAtMs: null,
        channelId: null,
        location: null,
        recurring: false,
        url: 'https://discord.com/events/G1/OTHER',
      },
    ]);
    const channel = new FakeChannel();
    const announcer = makeAnnouncer(channel);

    await announcer.run(); // announces → the model may arbitrate this once
    vi.mocked(ask).mockClear();

    // Every later tick has nothing due, so it must not re-ask forever. This was a
    // live regression: an unmatched weekly series cost ~288 calls/day.
    await announcer.run();
    await announcer.run();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('repeated ticks', () => {
  test('a second run posts nothing (the ledger, not the clock, decides)', async () => {
    const channel = new FakeChannel();
    await makeAnnouncer(channel).run();
    const second = await makeAnnouncer(channel).run();

    expect(second.announced).toHaveLength(0);
    expect(second.reason).toBe('nothing_today');
    expect(channel.sends).toBe(1);
    expect(channel.liveBotMessages()).toHaveLength(1);
  });

  test('a fresh process (new announcer, same DB) also stays quiet', async () => {
    const channel = new FakeChannel();
    await makeAnnouncer(channel).run();
    // Simulates a restart: the ledger lives in SQLite, not in memory.
    const afterRestart = await makeAnnouncer(channel).run();
    expect(afterRestart.announced).toHaveLength(0);
  });

  test('an explicit repost is still possible for an operator', async () => {
    const channel = new FakeChannel();
    await makeAnnouncer(channel).run();
    const forced = await makeAnnouncer(channel).run({ ignoreLedger: true });
    expect(forced.announced).toHaveLength(1);
    expect(channel.sends).toBe(2);
  });
});
