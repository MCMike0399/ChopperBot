/**
 * Direct ToolSource tests for the new multiplexed admin surfaces: Instagram
 * account admin, cross-user calendar admin, the read-only SQL window, the
 * grouped-bindings view, and the channel push-permission preflight. These call
 * `handle()` directly (no agent loop) for fast, focused coverage.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { PermissionsBitField } from 'discord.js';
import type { Client } from 'discord.js';

import { SqliteMemoryStore } from '../../../memory/store.js';
import {
  FRAMEWORK_CAPABILITY_ID,
  USERS_MIGRATIONS,
  UserDirectory,
} from '../../../users/store.js';
import { CapabilityRegistry } from '../../registry.js';
import { buildRouter } from '../../routing.js';
import type { Capability } from '../../capability.js';
import type { ToolHandlerResult } from '../../../tools/source.js';

import { CONFIGURATION_CHANNEL_ID } from '../constants.js';
import { ConfigurationStore, CONFIGURATION_MIGRATIONS } from '../store.js';
import { ConfigurationToolSource } from '../source.js';
import { ConfigInstagramAdminSource } from '../instagram-admin-source.js';
import { ConfigCalendarAdminSource } from '../calendar-admin-source.js';
import { ConfigDbSource } from '../db-source.js';
import { CalendarStore, CALENDAR_MIGRATIONS } from '../../calendar/store.js';
import { InstagramMonitorStore, INSTAGRAM_MONITOR_MIGRATIONS } from '../../instagram_monitor/store.js';

const OPERATOR = '70000000000000000001';

interface Payload {
  [k: string]: unknown;
}
function ok(r: ToolHandlerResult): Payload {
  expect(r.status).toBe('success');
  return r.payload as Payload;
}
function err(r: ToolHandlerResult): string {
  expect(r.status).toBe('error');
  return (r.payload as { error: string }).error;
}

async function makeMemory() {
  const memory = new SqliteMemoryStore({ path: ':memory:' });
  await memory.migrate(FRAMEWORK_CAPABILITY_ID, USERS_MIGRATIONS);
  await memory.migrate('configuration', CONFIGURATION_MIGRATIONS);
  await memory.migrate('calendar', CALENDAR_MIGRATIONS);
  await memory.migrate('instagram_monitor', INSTAGRAM_MONITOR_MIGRATIONS);
  return memory;
}

// ── Instagram admin ──────────────────────────────────────────────────────────

describe('ConfigInstagramAdminSource', () => {
  let memory: SqliteMemoryStore;
  let src: ConfigInstagramAdminSource;

  beforeEach(async () => {
    memory = await makeMemory();
    src = new ConfigInstagramAdminSource({ db: memory.db(), callerUserId: OPERATOR });
  });
  afterEach(() => memory.close());

  test('add then list surfaces the account', async () => {
    const added = ok(await src.handle('config_instagram', { action: 'add', username: 'NASA' }));
    expect(added.created).toBe(true);
    expect((added.account as Payload).username).toBe('nasa'); // normalized lowercase
    expect((added.account as Payload).added_by).toBe(OPERATOR);

    const again = ok(await src.handle('config_instagram', { action: 'add', username: 'nasa' }));
    expect(again.created).toBe(false);

    const list = ok(await src.handle('config_instagram', { action: 'list' }));
    expect((list.accounts as Payload[]).map((a) => a.username)).toEqual(['nasa']);
  });

  test('pause and resume toggle the paused flag', async () => {
    await src.handle('config_instagram', { action: 'add', username: 'nasa' });
    const paused = ok(await src.handle('config_instagram', { action: 'pause', username: 'nasa' }));
    expect((paused.account as Payload).paused).toBe(true);
    const resumed = ok(await src.handle('config_instagram', { action: 'resume', username: 'nasa' }));
    expect((resumed.account as Payload).paused).toBe(false);
  });

  test('remove requires confirm and then deletes', async () => {
    await src.handle('config_instagram', { action: 'add', username: 'nasa' });
    expect(err(await src.handle('config_instagram', { action: 'remove', username: 'nasa' }))).toMatch(/confirm/);
    ok(await src.handle('config_instagram', { action: 'remove', username: 'nasa', confirm: true }));
    const list = ok(await src.handle('config_instagram', { action: 'list' }));
    expect(list.accounts).toEqual([]);
  });

  test('reset_anchor requires confirm and nulls the dedup anchor + last_polled_at', async () => {
    const store = new InstagramMonitorStore(memory.db());
    store.upsertAccount({ username: 'nasa', added_by: OPERATOR });
    store.markPollSuccess(store.getAccount('nasa')!.id, Date.now(), 'POST_123');
    expect(store.getAccount('nasa')!.last_post_id).toBe('POST_123');

    expect(err(await src.handle('config_instagram', { action: 'reset_anchor', username: 'nasa' }))).toMatch(/confirm/);
    ok(await src.handle('config_instagram', { action: 'reset_anchor', username: 'nasa', confirm: true }));

    const after = store.getAccount('nasa')!;
    expect(after.last_post_id).toBeNull();
    expect(after.last_polled_at).toBeNull();
  });

  test('unknown action and missing username produce clear errors', async () => {
    expect(err(await src.handle('config_instagram', { action: 'frobnicate' }))).toMatch(/must be one of/);
    expect(err(await src.handle('config_instagram', { action: 'add' }))).toMatch(/username/);
  });

  test('resume_monitor requires confirm and clears the persistent kill-switch', async () => {
    const store = new InstagramMonitorStore(memory.db());
    store.tripGlobalStop('IG flagged the account', Date.now());
    expect(store.isGlobalStopped()).toBe(true);

    expect(err(await src.handle('config_instagram', { action: 'resume_monitor' }))).toMatch(/confirm/);
    const resumed = ok(await src.handle('config_instagram', { action: 'resume_monitor', confirm: true }));
    expect(resumed.resumed).toBe(true);
    expect(resumed.was_stopped).toBe(true);
    expect(store.isGlobalStopped()).toBe(false);
  });

  test('status reports the kill-switch state and account aggregates', async () => {
    const store = new InstagramMonitorStore(memory.db());
    store.upsertAccount({ username: 'nasa', added_by: OPERATOR });
    store.setPaused('nasa', true);
    store.tripGlobalStop('repeated throttles', 1_700_000_000_000);

    const status = ok(await src.handle('config_instagram', { action: 'status' }));
    const killSwitch = status.kill_switch as Payload;
    expect(killSwitch.engaged).toBe(true);
    expect(killSwitch.reason).toBe('repeated throttles');
    expect(killSwitch.resume_with).toMatch(/resume_monitor/);
    expect((status.accounts as Payload).total).toBe(1);
    expect((status.accounts as Payload).paused).toBe(1);
  });
});

// ── Calendar admin ───────────────────────────────────────────────────────────

describe('ConfigCalendarAdminSource', () => {
  let memory: SqliteMemoryStore;
  let src: ConfigCalendarAdminSource;
  let userDir: UserDirectory;
  const ALICE = '50000000000000000001';

  beforeEach(async () => {
    memory = await makeMemory();
    userDir = new UserDirectory(memory.db());
    userDir.upsert(ALICE, 'alice#0001', Date.now());
    src = new ConfigCalendarAdminSource({ db: memory.db(), userDirectory: userDir });
  });
  afterEach(() => memory.close());

  test('create on behalf of a user then peek shows it with owner tag', async () => {
    const created = ok(
      await src.handle('config_calendar', {
        action: 'create',
        discord_user_id: ALICE,
        title: 'Standup',
        start_at_iso: '2026-06-01T15:00:00Z',
      }),
    );
    const id = (created.event as Payload).id as number;
    expect(id).toBeGreaterThan(0);

    const peek = ok(await src.handle('config_calendar', { action: 'peek' }));
    const events = peek.events as Payload[];
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Standup');
    expect(events[0].discord_user_id).toBe(ALICE);
    expect(events[0].discord_tag).toBe('alice#0001');
  });

  test('update edits any user event but requires confirm', async () => {
    const cal = new CalendarStore(memory.db());
    const ev = cal.create({ discord_user_id: ALICE, title: 'Old', start_at: Date.parse('2026-06-01T15:00:00Z') });
    expect(err(await src.handle('config_calendar', { action: 'update', event_id: ev.id, title: 'New' }))).toMatch(/confirm/);
    ok(await src.handle('config_calendar', { action: 'update', event_id: ev.id, title: 'New', confirm: true }));
    expect(cal.adminGet(ev.id)!.title).toBe('New');
  });

  test('create rejects a bad snowflake', async () => {
    expect(
      err(
        await src.handle('config_calendar', {
          action: 'create',
          discord_user_id: 'not-a-snowflake',
          title: 'X',
          start_at_iso: '2026-06-01T15:00:00Z',
        }),
      ),
    ).toMatch(/snowflake/);
  });

  test('delete requires confirm', async () => {
    const cal = new CalendarStore(memory.db());
    const ev = cal.create({ discord_user_id: ALICE, title: 'Doomed', start_at: Date.now() + 60_000 });
    expect(err(await src.handle('config_calendar', { action: 'delete', event_id: ev.id }))).toMatch(/confirm/);
    ok(await src.handle('config_calendar', { action: 'delete', event_id: ev.id, confirm: true }));
    expect(cal.adminGet(ev.id)).toBeNull();
  });
});

// ── Read-only SQL window ─────────────────────────────────────────────────────

describe('ConfigDbSource — read-only safety', () => {
  let memory: SqliteMemoryStore;
  let src: ConfigDbSource;

  beforeEach(async () => {
    memory = await makeMemory();
    const store = new ConfigurationStore(memory.db());
    new InstagramMonitorStore(memory.db()).upsertAccount({ username: 'nasa', added_by: OPERATOR });
    src = new ConfigDbSource({ db: memory.db(), store });
  });
  afterEach(() => memory.close());

  test('SELECT with params returns rows', async () => {
    const r = ok(
      await src.handle('config_db', {
        action: 'query',
        sql: 'SELECT username FROM instagram_monitor_accounts WHERE username = ?',
        params: ['nasa'],
      }),
    );
    expect(r.row_count).toBe(1);
    expect((r.rows as Payload[])[0].username).toBe('nasa');
    expect(r.truncated).toBe(false);
  });

  test('writes are rejected and leave data intact', async () => {
    for (const sql of [
      'DELETE FROM instagram_monitor_accounts',
      "UPDATE instagram_monitor_accounts SET username = 'x'",
      "INSERT INTO instagram_monitor_accounts (username, added_by, added_at) VALUES ('y','z',1)",
      'DROP TABLE instagram_monitor_accounts',
      'PRAGMA journal_mode = DELETE',
    ]) {
      expect(err(await src.handle('config_db', { action: 'query', sql }))).toBeTruthy();
    }
    // Data still present and table still there.
    const r = ok(await src.handle('config_db', { action: 'query', sql: 'SELECT COUNT(*) AS n FROM instagram_monitor_accounts' }));
    expect((r.rows as Payload[])[0].n).toBe(1);
  });

  test('multi-statement queries are rejected', async () => {
    expect(
      err(await src.handle('config_db', { action: 'query', sql: 'SELECT 1; DROP TABLE instagram_monitor_accounts' })),
    ).toBeTruthy();
  });

  test('row cap truncates and flags', async () => {
    // 250 rows via a recursive CTE.
    const r = ok(
      await src.handle('config_db', {
        action: 'query',
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 250) SELECT x FROM c',
      }),
    );
    expect(r.truncated).toBe(true);
    expect(r.row_count).toBe(200);
  });

  test('describe_schema returns columns for a known table', async () => {
    const r = ok(await src.handle('config_db', { action: 'describe_schema', table: 'instagram_monitor_accounts' }));
    const cols = (r.columns as Payload[]).map((c) => c.name);
    expect(cols).toContain('username');
    expect(r.sql as string).toMatch(/CREATE TABLE/i);
  });
});

// ── Configuration core: grouped bindings + permission preflight ──────────────

function stubCapability(id: string, description: string): Capability {
  return { id, description } as unknown as Capability;
}

function makeClientWithChannel(channelId: string, perms: bigint[] | null): Client {
  const guild = { id: '40000000000000000001', name: 'TestGuild', members: { me: { id: 'BOT' } } };
  const permObj = perms === null ? null : {
    has: (flag: bigint) => perms.includes(flag),
  };
  const channel = {
    id: channelId,
    name: 'monitor-feed',
    guild,
    permissionsFor: () => permObj,
  };
  return {
    channels: { cache: new Map<string, unknown>([[channelId, channel]]) },
    guilds: { cache: new Map() },
  } as unknown as Client;
}

describe('ConfigurationToolSource — grouped bindings + permissions', () => {
  let memory: SqliteMemoryStore;
  const CH_A = '30000000000000000001';
  const CH_B = '30000000000000000002';

  beforeEach(async () => {
    memory = await makeMemory();
  });
  afterEach(() => memory.close());

  function makeSource(client: Client, bindings: Array<[string, string]>) {
    const store = new ConfigurationStore(memory.db());
    const registry = new CapabilityRegistry();
    registry.register(stubCapability('configuration', 'Admin console'));
    registry.register(stubCapability('instagram_monitor', 'IG monitor'));
    registry.register(stubCapability('calendar', 'Calendar'));
    const router = buildRouter(new Map(bindings));
    return new ConfigurationToolSource({
      store,
      db: memory.db(),
      registry,
      router,
      client,
      userDirectory: new UserDirectory(memory.db()),
      callerUserId: OPERATOR,
      startedAtMs: Date.now(),
      dbPath: ':memory:',
    });
  }

  test('by_capability groups channels under each capability', async () => {
    const client = makeClientWithChannel(CH_A, null);
    const src = makeSource(client, [
      [CH_A, 'instagram_monitor'],
      [CH_B, 'instagram_monitor'],
    ]);
    const r = ok(await src.handle('config_bindings', { action: 'by_capability' }));
    const caps = r.capabilities as Payload[];
    const ig = caps.find((c) => c.capability_id === 'instagram_monitor')!;
    expect(ig.channel_count).toBe(2);
    expect((ig.channels as Payload[]).map((c) => c.channel_id).sort()).toEqual([CH_A, CH_B].sort());
    const cal = caps.find((c) => c.capability_id === 'calendar')!;
    expect(cal.channel_count).toBe(0);
  });

  test('check_permissions reports flags and can_push verdict', async () => {
    const client = makeClientWithChannel(CH_A, [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.AttachFiles,
    ]);
    const src = makeSource(client, []);
    const r = ok(await src.handle('config_discovery', { action: 'check_permissions', channel_id: CH_A }));
    expect(r.resolved).toBe(true);
    expect(r.can_push).toBe(true);
    expect((r.permissions as Payload).attach_files).toBe(true);
  });

  test('binding to instagram_monitor warns when Attach Files is missing', async () => {
    const client = makeClientWithChannel(CH_A, [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      // no AttachFiles
    ]);
    const src = makeSource(client, []);
    const r = ok(await src.handle('config_bindings', { action: 'bind', channel_id: CH_A, capability: 'instagram_monitor' }));
    expect(r.capability).toBe('instagram_monitor');
    expect(r.permission_warning as string).toMatch(/Attach Files/);
  });
});
