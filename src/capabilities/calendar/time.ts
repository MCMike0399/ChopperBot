export const DEFAULT_TIMEZONE = 'America/Mexico_City';

/**
 * Format a unix-ms timestamp in the given IANA timezone for human display.
 * The output is locale-stable ("Sun, May 25, 10:00 AM") so the model can
 * echo it back verbatim without recomputing offsets — Mexico City stopped
 * observing DST in October 2022, and many models still apply CDT (UTC-5)
 * when they shouldn't.
 */
export function formatInTimezone(
  unixMs: number,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(unixMs));
}
