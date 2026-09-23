/**
 * Two announcer additions from 2026-09-23:
 *  - the invented-name guard (live 2026-09-21, #40: brief said "Yeti", the
 *    10:00 post to the whole server said "Andrés");
 *  - the day-before "no cover image" reminder for mods.
 */
import { describe, test, expect } from 'vitest';
import {
  bannerKey,
  bannerRemindersDue,
  inventedNames,
  renderAnnouncementPrompt,
  renderBannerReminder,
  type AnnounceTarget,
} from '../announce.js';

const L = (date: string, hour = 20) => Date.parse(`${date}T00:00:00Z`) + (hour + 6) * 3_600_000;

const event40 = {
  id: 40,
  title: '¿Quién manda cuando no hay patrón?',
  description:
    '¿Alguna vez te ha interesado abrir una cooperativa? ¿Te interesan formas no opresivas de generar riqueza?\n\n' +
    'Este lunes se llevará a cabo el conversatorio, donde Yeti nos explicará distintas mecánicas sobre sociocracia para la cooperativización de la riqueza.\n\n' +
    '8:00 PM (hora CDMX), en la Sala de Eventos.',
  location: 'Sala de Eventos',
  startAtMs: L('2026-09-21'),
};

describe('inventedNames', () => {
  const system = renderAnnouncementPrompt(
    { occurrence: event40, discordEvent: null, discordEventUrl: null },
    L('2026-09-21', 10),
  );

  test('the live 2026-09-21 post is caught', () => {
    const posted =
      '¡Gente linda de RevZ! Hoy a las 8:00 PM (hora CDMX) tenemos el conversatorio *¿Quién manda cuando no hay patrón?* en la Sala de Eventos. ' +
      'Andrés nos va a explicar distintas mecánicas de sociocracia para cooperativizar la riqueza, así que si te interesa abrir una cooperativa o generar riqueza sin opresiones, caiganle. Ahí nos vemos, lxs tqm 🫶';
    expect(inventedNames(posted, [system])).toEqual(['Andrés']);
  });

  test('the same post with the real speaker passes', () => {
    const ok =
      '¡Gente linda de RevZ! Hoy a las 8:00 PM tenemos el conversatorio en la Sala de Eventos. Yeti nos va a explicar sociocracia. ' +
      'Pónganse cómodxs, Acompáñennos y Caiganle. Nos vemos, lxs tqm';
    expect(inventedNames(ok, [system])).toEqual([]);
  });

  test('shouting, links and mentions are not names', () => {
    // "Muchachooooos" is in the prompt's own voice examples, so it is vocabulary.
    expect(inventedNames('HOY ASAMBLEA <@&123> https://discord.com/events/1/Maria Muchachooooos', [system])).toEqual([]);
    expect(inventedNames('Vengan todxs, Traigan su libreta', [system])).toEqual([]);
  });
});

describe('bannerRemindersDue', () => {
  const NOW = L('2026-09-22', 10); // Tuesday 10:00 CDMX
  const target = (over: Partial<AnnounceTarget> & { start: number; imageUrl?: string | null }): AnnounceTarget => ({
    occurrence: { id: 26, title: 'Idea Vilariño Parte 1 | Club de poesía', description: null, location: null, startAtMs: over.start },
    discordEvent: { id: 'd1', name: 'x', description: null, startAtMs: over.start, imageUrl: over.imageUrl },
    discordEventUrl: 'https://discord.com/events/g/d1',
  });
  const none = () => false;

  test("tomorrow's coverless Discord event is due", () => {
    const due = bannerRemindersDue({ targets: [target({ start: L('2026-09-23'), imageUrl: null })], nowMs: NOW, isAnnounced: none });
    expect(due).toHaveLength(1);
  });

  test('not today, not with a cover, not when the cover is unknown, not before the hour, not twice', () => {
    const t = target({ start: L('2026-09-23'), imageUrl: null });
    expect(bannerRemindersDue({ targets: [target({ start: L('2026-09-22', 21), imageUrl: null })], nowMs: NOW, isAnnounced: none })).toEqual([]);
    expect(bannerRemindersDue({ targets: [target({ start: L('2026-09-23'), imageUrl: 'https://cdn/x.png' })], nowMs: NOW, isAnnounced: none })).toEqual([]);
    expect(bannerRemindersDue({ targets: [target({ start: L('2026-09-23'), imageUrl: undefined })], nowMs: NOW, isAnnounced: none })).toEqual([]);
    expect(bannerRemindersDue({ targets: [t], nowMs: L('2026-09-22', 9), isAnnounced: none })).toEqual([]);
    const key = bannerKey(26, L('2026-09-23'));
    expect(bannerRemindersDue({ targets: [t], nowMs: NOW, isAnnounced: (k) => k === key })).toEqual([]);
  });

  test('no Discord event at all is the missing-event nudge, not this', () => {
    const t = { ...target({ start: L('2026-09-23') }), discordEvent: null };
    expect(bannerRemindersDue({ targets: [t], nowMs: NOW, isAnnounced: none })).toEqual([]);
  });

  test('the message names the id and the one-reply fix', () => {
    const text = renderBannerReminder([target({ start: L('2026-09-23'), imageUrl: null })]);
    expect(text).toMatch(/Recordatorio amable/);
    expect(text).toMatch(/#26 Idea Vilariño/);
    expect(text).toMatch(/ponle esta portada al #26/);
    expect(text).toMatch(/8:00 PM/);
    expect(text).not.toMatch(/<@/);
  });
});
