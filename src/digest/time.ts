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

/** The time zone this host runs in. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Mon 8:15 PM": a time within the last few days. */
export function formatTime(date: Date, timeZone: string): string {
  return format(date, { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** "Mon, Oct 12, 8:15 PM": a time that also needs its date. */
export function formatDateTime(date: Date, timeZone: string): string {
  return format(date, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function format(date: Date, options: Intl.DateTimeFormatOptions): string {
  // Newer ICU puts a narrow no-break space before AM/PM; a plain one reads the same.
  return new Intl.DateTimeFormat('en-US', options).format(date).replace(/[  ]/g, ' ');
}
