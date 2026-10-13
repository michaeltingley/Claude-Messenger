/**
 * Control and invisible formatting characters, other than whitespace and the
 * joiners that build emoji and some scripts' letters: they could hide or
 * reorder text, or reach a terminal as its commands.
 */
const INVISIBLE = /(?![\s\u0085\u200c\u200d])[\p{Cc}\p{Cf}]/gu;

/** `text` without the characters that don't show as themselves. */
export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}
