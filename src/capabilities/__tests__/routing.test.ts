import { describe, test, expect } from 'vitest';
import { buildRouter } from '../routing.js';

describe('buildRouter (thin wrapper over a precomputed channel→capability map)', () => {
  test('resolves known channels and returns null for unknown', () => {
    const r = buildRouter(
      new Map([
        ['22222222222222222222', 'instagram_monitor'],
        ['33333333333333333333', 'calendar'],
      ]),
    );
    expect(r.resolve('22222222222222222222')).toBe('instagram_monitor');
    expect(r.resolve('33333333333333333333')).toBe('calendar');
    expect(r.resolve('99999999999999999999')).toBeNull();
  });

  test('allChannelIds() reflects the configured channels', () => {
    const r = buildRouter(
      new Map([
        ['11111111111111111111', 'instagram_monitor'],
        ['22222222222222222222', 'instagram_monitor'],
      ]),
    );
    expect(r.allChannelIds()).toEqual(new Set(['11111111111111111111', '22222222222222222222']));
  });

  test('empty map yields a router that refuses everything', () => {
    const r = buildRouter(new Map());
    expect(r.resolve('22222222222222222222')).toBeNull();
    expect(r.allChannelIds().size).toBe(0);
  });

  test('the router is a snapshot — mutating the source map after construction does not affect it', () => {
    const src = new Map([['22222222222222222222', 'instagram_monitor']]);
    const r = buildRouter(src);
    src.set('33333333333333333333', 'calendar');
    expect(r.resolve('33333333333333333333')).toBeNull();
  });

  test('setBinding adds a new channel→capability mapping that resolve() and allChannelIds() see immediately', () => {
    const r = buildRouter(new Map());
    expect(r.resolve('44444444444444444444')).toBeNull();
    r.setBinding('44444444444444444444', 'calendar');
    expect(r.resolve('44444444444444444444')).toBe('calendar');
    expect(r.allChannelIds().has('44444444444444444444')).toBe(true);
  });

  test('setBinding overwrites an existing mapping', () => {
    const r = buildRouter(new Map([['55555555555555555555', 'instagram_monitor']]));
    r.setBinding('55555555555555555555', 'calendar');
    expect(r.resolve('55555555555555555555')).toBe('calendar');
  });

  test('removeBinding deletes a mapping and reports whether it existed', () => {
    const r = buildRouter(new Map([['66666666666666666666', 'instagram_monitor']]));
    expect(r.removeBinding('66666666666666666666')).toBe(true);
    expect(r.resolve('66666666666666666666')).toBeNull();
    expect(r.removeBinding('66666666666666666666')).toBe(false);
  });

  test('getAllBindings returns a snapshot copy (mutating it does not affect the router)', () => {
    const r = buildRouter(new Map([['77777777777777777777', 'instagram_monitor']]));
    const snap = r.getAllBindings();
    snap.set('88888888888888888888', 'calendar');
    expect(r.resolve('88888888888888888888')).toBeNull();
  });
});
