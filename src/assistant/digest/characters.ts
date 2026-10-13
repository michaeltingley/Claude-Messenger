/**
 * Control and invisible formatting characters, other than whitespace and the
 * joiners that build emoji and some scripts' letters: they could hide or
 * reorder text, or reach a terminal as its commands.
 */
const INVISIBLE = /(?![\s\u0085\u200c\u200d])[\p{Cc}\p{Cf}]/gu;

/**
 * What else shows as nothing (a joiner, a variation selector, a filler),
 * between two ASCII characters. Emoji and the scripts that need these use
 * them on characters of their own; between ASCII ones, they could only
 * split a number, an address or a link, so that it reads as one and doesn't
 * match as one. A run of them is tried from its start only, so this takes
 * time linear in the text.
 */
const IGNORABLE_IN_ASCII = /(?<=\p{ASCII})\p{DI}+(?=\p{ASCII})/gu;

/** `text` without the characters that don't show as themselves. */
export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE, '').replace(IGNORABLE_IN_ASCII, '');
}
