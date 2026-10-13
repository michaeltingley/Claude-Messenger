/**
 * Elements that start or end a line of their own: a paragraph, a quote, a
 * list or an item in one, a table, a row or caption of one, a heading, a
 * rule, preformatted text, a collapsible section or its summary, and the
 * copy of the message a reply answers.
 */
const LINE_ENDING = [
  'blockquote', 'br', 'caption', 'details', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'mx-reply', 'ol', 'p', 'pre', 'summary', 'table', 'tr', 'ul',
];

/** Elements that sit in a line beside what is next to them, apart from it: a table cell, an image. */
const SPACED = ['img', 'td', 'th'];

/**
 * Elements that run on with the words around them: those that only change
 * how the words they hold look, where they point or what reading is shown
 * over them, so a word partly in bold is one word ("bob<b>@claude</b>.ai"
 * reads "bob@claude.ai"), and the groups a table's rows sit in, whose rows
 * end lines of their own.
 */
const INLINE = [
  'a', 'b', 'code', 'del', 'em', 'font', 'i', 'rp', 'rt', 'ruby',
  's', 'span', 'strike', 'strong', 'sub', 'sup', 'tbody', 'thead', 'u',
];

/**
 * The elements a Matrix message's HTML may hold, by what one of their tags
 * shows as in the chat between the words around it: the spec's list, the
 * deprecated elements clients still send, and <mx-reply>.
 */
const SHOWN_AS = new Map<string, '\n' | ' ' | ''>([
  ...LINE_ENDING.map((name) => [name, '\n'] as const),
  ...SPACED.map((name) => [name, ' '] as const),
  ...INLINE.map((name) => [name, ''] as const),
]);

/**
 * What a tag of the named element, in any case, shows as in the chat
 * between the words around it: a line break, a space, or nothing. Undefined
 * for an element a message's HTML can't hold, which a reader of Beeper's
 * `text` can't take for markup: `text` doesn't say whether it is HTML or a
 * plain body, and "Press <Enter>", "List<String>" or "<hugs>" may be text.
 */
export function shownAs(name: string): '\n' | ' ' | '' | undefined {
  return SHOWN_AS.get(name.toLowerCase());
}
