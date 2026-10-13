/**
 * Markup, as HTML reads it: "<" then a letter, "/" and a letter, "!" (a
 * comment) or "?", then anything but "<" up to ">". "<3" and "< 5" stay text.
 */
const TAG = /<(?:\/?[A-Za-z]|[!?])[^<>]*>/g;
const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;

/** Elements that end a line. */
const LINE_ENDING = new Set(['br', 'p', 'div', 'li', 'tr', 'pre', 'hr', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);

function nameOf(tag: string): string {
  return TAG_NAME.exec(tag)?.[1]?.toLowerCase() ?? '';
}

/**
 * Drops the copy of the message a reply answers, which Matrix sends ahead of
 * the reply as an <mx-reply> element: from its first opening tag to the end
 * of its last closing one, so markup inside the copy can't end it early, or
 * to the end of the text if none closes it.
 */
function withoutReplyCopy(html: string): string {
  let start: number | undefined;
  let end = html.length;
  for (const match of html.matchAll(TAG)) {
    const tag = match[0];
    if (nameOf(tag) !== 'mx-reply') continue;
    if (tag[1] !== '/') start ??= match.index;
    else if (start !== undefined) end = match.index + tag.length;
  }
  return start === undefined ? html : `${html.slice(0, start)}\n${html.slice(end)}`;
}

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['ldquo', '“'],
  ['rdquo', '”'],
]);

function decodeEntity(entity: string, decimal?: string, hex?: string, name?: string): string {
  if (name !== undefined) return NAMED_ENTITIES.get(name.toLowerCase()) ?? entity;
  const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
}

/**
 * A message's text as plain text, as the chat shows it, from Beeper's
 * `text`: Matrix's HTML formatted body when there is one, else the plain
 * body. The copy of the message a reply answers is left out (the chat has
 * that message already), markup is dropped, with a line break for each
 * element that ends a line, and entities are decoded once. A link keeps its
 * text and loses where it points. Every step takes time linear in the text.
 */
export function plainText(text: string): string {
  const html = withoutReplyCopy(text).replace(TAG, (tag) => (LINE_ENDING.has(nameOf(tag)) ? '\n' : ''));
  return html.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, decodeEntity).trim();
}
