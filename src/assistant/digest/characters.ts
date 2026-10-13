/**
 * Every way of ending a line but a line feed: a carriage return, alone or
 * before a line feed, could let a terminal write a line over itself, and
 * the others are line breaks only some programs break on.
 */
const LINE_BREAK = /\r\n?|[\v\f\u0085\u2028\u2029]/g;

/**
 * Control and invisible formatting characters, other than a tab, a line
 * feed and the joiners that build emoji and some scripts' letters: they
 * could hide or reorder text, or reach a terminal as its commands. Half of
 * a surrogate pair on its own is no character at all, and two halves could
 * become one once what keeps them apart is dropped.
 */
const INVISIBLE = /(?![\t\n\u200c\u200d])[\p{Cc}\p{Cf}\p{Cs}]/gu;

/** What shows as nothing and is not yet assigned to anything: no text needs it. */
const UNASSIGNED_IGNORABLE = /(?=\p{Cn})\p{DI}/gu;

/**
 * A variation selector that chooses no emoji's look: one after anything but
 * an emoji or a keycap's digit, "#" or "*", and those no emoji uses. On
 * text they change little or nothing, and a run of them can carry hidden
 * data.
 */
const STRAY_VARIATION = /(?<![\p{Extended_Pictographic}\d#*])[\ufe0e\ufe0f]|[\ufe00-\ufe0d\u{e0100}-\u{e01ef}]/gu;

/**
 * Three or more in a row of what shows as nothing: no emoji or script uses
 * more than two together ("❤️‍🔥" has a variation selector and a joiner), so
 * a longer run could only carry hidden data. Each run is matched whole,
 * once, so this takes time linear in the text.
 */
const IGNORABLE_RUN = /\p{DI}{3,}/gu;

/**
 * What else shows as nothing (a joiner, a variation selector, a filler),
 * between two ASCII characters. Emoji and the scripts that need these use
 * them on characters of their own; between ASCII ones, they could only
 * split a number, an address or a link, so that it reads as one and doesn't
 * match as one. A run of them is tried from its start only, so this takes
 * time linear in the text.
 */
const IGNORABLE_IN_ASCII = /(?<=\p{ASCII})\p{DI}+(?=\p{ASCII})/gu;

/**
 * `text` without the characters that don't show as themselves, and with
 * each line ending in a line feed.
 */
export function withoutInvisible(text: string): string {
  return text
    .replace(LINE_BREAK, '\n')
    .replace(INVISIBLE, '')
    .replace(UNASSIGNED_IGNORABLE, '')
    .replace(STRAY_VARIATION, '')
    .replace(IGNORABLE_RUN, '')
    .replace(IGNORABLE_IN_ASCII, '');
}
