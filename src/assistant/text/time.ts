/** Times as the owner reads them, in their own time zone. */

/** Whether `zone` is an IANA time zone this runtime knows, such as "America/Los_Angeles". */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The time zone this host runs in, or UTC when the host's isn't one this runtime knows. */
export function hostTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone as string | undefined;
  return zone !== undefined && isTimeZone(zone) ? zone : 'UTC';
}

/** "Mon 8:15 PM": a time within the last few days. */
export function formatTime(date: Date, timeZone: string): string {
  return format(date, { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** "Mon, Oct 12, 8:15 PM", or with its year, "Mon, Oct 12, 2026, 8:15 PM": a time that needs its date. */
export function formatDateTime(date: Date, timeZone: string, { year = false } = {}): string {
  return format(date, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(year && { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Within six days before now, a weekday names one day; further back, a time needs its date. */
const WEEKDAY_SPAN_MS = 6 * 24 * 3_600_000;

/**
 * How times read to someone reading at `now`: within the six days before
 * it, a weekday and a time ("Mon 8:15 PM"); further back, the date too, and
 * the year when it isn't now's.
 */
export function clockAt(now: Date, timeZone: string): (date: Date) => string {
  return (date) => {
    if (now.getTime() - date.getTime() < WEEKDAY_SPAN_MS) return formatTime(date, timeZone);
    return formatDateTime(date, timeZone, { year: yearOf(date, timeZone) !== yearOf(now, timeZone) });
  };
}

/** The year a time falls in, in a time zone. */
export function yearOf(date: Date, timeZone: string): string {
  return format(date, { timeZone, year: 'numeric' });
}

function format(date: Date, options: Intl.DateTimeFormatOptions): string {
  // Newer ICU puts a narrow no-break space before AM/PM; a plain one reads the same.
  return new Intl.DateTimeFormat('en-US', options).format(date).replace(/[\u202f\u00a0]/g, ' ');
}
