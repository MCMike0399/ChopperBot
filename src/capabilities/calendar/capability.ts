import { log } from '../../log.js';
import { composeToolSources } from '../../tools/source.js';
import type {
  Capability,
  CapabilityInitDeps,
  CapabilityTurnBundle,
  CapabilityTurnContext,
} from '../capability.js';
import {
  CalendarStore,
  CALENDAR_MIGRATIONS,
  type CalendarOccurrence,
} from './store.js';
import { CalendarToolSource } from './source.js';
import { formatInTimezone, DEFAULT_TIMEZONE } from './time.js';

const SNAPSHOT_LIMIT = 5;

/**
 * Calendar capability: a per-USER calendar backed by SQLite. A user sees the
 * same calendar from any channel bound to this capability — events are not
 * channel-scoped. The tools (create/list/search/update/delete events) are
 * exposed to the model; the system prompt is rebuilt every turn so it
 * includes the current time and a snapshot of the user's next few events.
 */
export class CalendarCapability implements Capability {
  readonly id = 'calendar';
  readonly description =
    'Per-user calendar. Each Discord user has their own events, visible from any channel bound to this capability. Create, list, search, update, and delete.';

  private store: CalendarStore | null = null;

  async init({ memory }: CapabilityInitDeps): Promise<void> {
    await memory.migrate(this.id, CALENDAR_MIGRATIONS);
    this.store = new CalendarStore(memory.db());
    log.info({ capability: this.id }, 'CalendarCapability initialized');
  }

  async buildTurn(ctx: CapabilityTurnContext): Promise<CapabilityTurnBundle> {
    if (!this.store) throw new Error('CalendarCapability.buildTurn called before init');

    const upcoming = this.store.listUpcoming(ctx.userId, ctx.now.getTime(), SNAPSHOT_LIMIT);
    const system = renderSystemPrompt(ctx.now, upcoming);

    const source = new CalendarToolSource(this.store, ctx.userId, ctx.now.getTime());
    const tools = composeToolSources([source]);

    return { system, tools };
  }
}

function renderSystemPrompt(now: Date, upcoming: CalendarOccurrence[]): string {
  const upcomingSection = upcoming.length === 0
    ? 'No upcoming events.'
    : upcoming
        .map((e) => {
          const startLocal = formatInTimezone(e.start_at);
          const endLocal = e.end_at !== null ? ` → ${formatInTimezone(e.end_at)}` : '';
          const loc = e.location ? ` @ ${e.location}` : '';
          const recur = e.recurrence_freq !== null
            ? ` (recurring ${e.recurrence_freq}${e.is_recurring_instance ? `, instance #${e.occurrence_index}` : ', master'})`
            : '';
          return `- #${e.id} **${e.title}** — ${startLocal}${endLocal}${loc}${recur}  [UTC: ${new Date(e.start_at).toISOString()}]`;
        })
        .join('\n');

  return `You are ChopperBot in **Calendar mode**. You manage a per-user calendar for the Discord user talking to you.

# Time awareness
- Current UTC time: ${now.toISOString()}
- Current local time: ${formatInTimezone(now.getTime())} (${DEFAULT_TIMEZONE})
- ${DEFAULT_TIMEZONE} is **UTC-6 year-round** (no DST since October 2022). Do not use "CDT" or assume daylight-saving — the offset is fixed at −06:00.
- When the user gives a relative time ("tomorrow", "next Friday", "in 2 hours"), resolve it against the **local** time above (not UTC), then convert to ISO 8601 UTC for the tool.
  - Example: user is in ${DEFAULT_TIMEZONE} and says "tomorrow at 10am" while the current local time is May 24 at 8:52 PM. Tomorrow at 10am local = 2026-05-25T10:00:00−06:00 = **2026-05-25T16:00:00Z** — pass that as \`start_at_iso\`.

# Language
Mirror the user's language. If they write in Spanish, respond in Spanish. If in English, respond in English.

# Tool defaults
- If the user doesn't give a duration, treat the event as point-in-time (omit \`end_at_iso\`).
- \`title\` is required. If the user is vague ("set up something"), ask one clarifying question before creating.
- Before creating an event that resembles an existing one (same day, similar title), call \`calendar_search_events\` first and warn the user about the potential duplicate.
- For "what's on my calendar / what's coming up", call \`calendar_list_upcoming\`.

# Recurring events
- Supported via the \`recurrence_freq\` field on \`calendar_create_event\` / \`calendar_update_event\`. Allowed values: \`daily\`, \`weekly\`, \`monthly\`. Pass an optional \`recurrence_until_iso\` to bound the series; omit it for open-ended series.
- **Triggers:** any phrasing that describes a repeating pattern → set \`recurrence_freq\`. Examples:
  - "every Wednesday at 8pm", "cada miércoles a las 8pm" → \`recurrence_freq: "weekly"\`, \`start_at_iso\` of the NEXT Wednesday at 8pm local.
  - "todos los días a las 9am", "every day at 9am" → \`recurrence_freq: "daily"\`.
  - "el primero de cada mes", "monthly on the 15th" → \`recurrence_freq: "monthly"\` anchored to the chosen day.
- **Do NOT** create separate events for each occurrence. One row, one \`recurrence_freq\`. The listing tool expands occurrences for you.
- If the user gives a frequency that isn't daily/weekly/monthly (e.g. "every other Wednesday", "every weekday"), say it isn't supported yet and ask if a weekly series works as a substitute.
- The listing snapshot below already shows each *occurrence* with a "(recurring weekly, instance #N)" marker. Multiple lines with the same \`#id\` are the same series — when summarizing for the user, collapse them ("Book club every Wednesday at 8pm; next: …") instead of repeating.
- **Updates and deletes affect the WHOLE series in v1.** There is no per-occurrence override. Warn the user before changing the time of a recurring event or deleting it.

# Output style
- Keep replies short — 1–3 sentences for confirmations, a bullet list for multi-event responses.
- When you display an event time to the user, **use the \`start_at_local\` field from the tool result verbatim** (or the local string in the snapshot below). Do NOT recompute the timezone yourself.
- For recurring events, mention the cadence and the next occurrence in the user's words ("every Wednesday at 8pm, next May 27"), not the list of all upcoming instances.
- Do not invent events. If asked about something not in the database, say so plainly.
- Never end with an invitation to keep talking ("anything else?", "let me know"). Close the topic.

# Per-user scoping (important)
- Every event belongs to a Discord user — the user talking to you right now. You can ONLY see and modify their events. The capability is per-user globally: the same user sees the same events from any channel bound to this calendar.
- There is no team / channel / shared calendar mode. If a user asks to see "the team calendar" or another user's events, explain that calendars are per-user and that an admin can inspect cross-user data from the configuration channel.

# Upcoming events for this user
${upcomingSection}
`;
}
