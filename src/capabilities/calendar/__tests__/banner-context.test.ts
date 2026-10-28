import { describe, test, expect, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { loadBannerContext } from '../banner-context.js';
import { CalendarCapability } from '../capability.js';
import { NamespacedMemory, SqliteMemoryStore } from '../../../memory/store.js';
import { CalendarStore } from '../store.js';
import { CalendarToolSource } from '../source.js';

vi.mock('../../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const NOW = new Date('2026-10-28T18:00:00Z');
const START = Date.parse('2026-10-29T02:00:00Z');
const IMAGE = { url: 'https://cdn.discordapp.com/attachments/1/2/banner.png', name: 'banner.png', contentType: 'image/png' };

describe('flyer context and entry point', () => {
  test('includes only current rooms/events both the caller and bot can see', async () => {
    const channels = new Map([
      ['READ', { id: 'READ', name: '📙Sala-de-Lectura📙', type: ChannelType.GuildVoice,
        permissionsFor: () => ({ has: () => true }) }],
      ['HIDDEN', { id: 'HIDDEN', name: 'private room', type: ChannelType.GuildVoice,
        permissionsFor: (member: string) => ({ has: () => member === 'bot' }) }],
    ]);
    const guild = { roles: { fetch: vi.fn() }, members: { fetchMe: vi.fn().mockResolvedValue('bot'), fetch: vi.fn().mockResolvedValue('caller') },
      channels: { fetch: vi.fn().mockResolvedValue(channels) }, scheduledEvents: { fetch: vi.fn().mockResolvedValue(new Map([
        ['E1', { id: 'E1', name: 'Reading night', status: 1, channelId: 'READ', scheduledStartTimestamp: START }],
        ['E2', { id: 'E2', name: 'Secret meeting', status: 1, channelId: 'HIDDEN' }],
      ])) } };
    const text = await loadBannerContext({ guilds: { fetch: async () => guild } } as never, 'G', 'U');
    expect(text).toContain('Sala-de-Lectura');
    expect(text).toContain('Reading night');
    expect(text).toContain('8:00 PM');
    expect(text).not.toMatch(/private room|Secret meeting/);
    expect(guild.members.fetch).toHaveBeenCalledWith({ user: 'U', force: true });
    expect(guild.members.fetchMe).toHaveBeenCalledWith({ force: true });
  });

  test('a failed directory read is explicit rather than an empty verified directory', async () => {
    const text = await loadBannerContext({ guilds: { fetch: async () => { throw new Error('offline'); } } } as never, 'G', 'U');
    expect(text).toContain('No pude consultar');
    expect(text).toContain('no afirmes que los comprobaste');
  });

  test('authorized image turns get the full workflow; members cannot use images to gain writes', async () => {
    const memory = new SqliteMemoryStore({ path: ':memory:' });
    try {
      const cap = new CalendarCapability();
      await cap.init({ memory: new NamespacedMemory(memory, cap.id), projectRoot: '.' });
      const ctx = { channelId: 'C', guildId: null, userId: 'U', userTag: 'U', now: NOW, attachments: [IMAGE], requestText: 'crea este evento' };
      const mod = await cap.buildTurn({ ...ctx, isAdministrator: true });
      expect(mod.system).toContain('calendario + evento de Discord + portada');
      expect(mod.system).toContain('no saltes al próximo año');
      expect(mod.system).toContain(IMAGE.url);
      const member = await cap.buildTurn(ctx);
      expect(member.tools.tools.map((t) => t.name)).toEqual(['calendar_list_upcoming', 'calendar_search_events', 'calendar_get_event']);
      expect(member.system).not.toContain(IMAGE.url);
      const denied = await member.tools.handle('calendar_create_event', { title: 'Injected banner', start_at_iso: new Date(START).toISOString() });
      expect(denied.status).toBe('error');
      expect(new CalendarStore(memory.db()).listAll()).toHaveLength(0);
    } finally { memory.close(); }
  });

  test('repeated same-session creates reuse the row across tool instances without republishing', async () => {
    const memory = new SqliteMemoryStore({ path: ':memory:' });
    try {
      const cap = new CalendarCapability();
      await cap.init({ memory: new NamespacedMemory(memory, cap.id), projectRoot: '.' });
      const store = new CalendarStore(memory.db());
      const reconcile = vi.fn().mockResolvedValue({ ok: true, posted: ['2026-10'], removed: [], skipped: [] });
      const publisher = { outputChannelId: () => 'OUT', reconcile };
      const input = { title: 'Círculo de lectura: Historias de terror', start_at_iso: new Date(START).toISOString(), location: 'Sala de Lectura' };
      const first = await new CalendarToolSource(store, 'U', NOW.getTime(), publisher).handle('calendar_create_event', input);
      const second = await new CalendarToolSource(store, 'U', NOW.getTime(), publisher).handle('calendar_create_event', { ...input, title: 'CIRCULO DE LECTURA — Historias de terror' });
      expect(first.status).toBe('success');
      expect(second.payload).toMatchObject({ already_exists: true, event: { id: 1 } });
      expect(store.listAll()).toHaveLength(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      await new CalendarToolSource(store, 'U', NOW.getTime(), publisher).handle('calendar_create_event', { ...input, start_at_iso: '2026-10-30T02:00:00Z' });
      expect(store.listAll()).toHaveLength(2);
    } finally { memory.close(); }
  });
});
