/**
 * Markup, as HTML reads it: "<" then a letter, "/" and a letter, "!" (a
 * comment) or "?", then anything but "<" up to ">". "<3" and "< 5" stay text.
 */
const TAG = /<(?:\/?[A-Za-z]|[!?])[^<>]*>/g;
const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;

interface Tag {
  readonly start: number;
  readonly end: number;
  readonly closing: boolean;
  /** Lower-cased; empty for a comment. */
  readonly name: string;
  readonly source: string;
}

function tagsIn(text: string): Tag[] {
  return Array.from(text.matchAll(TAG), (match) => {
    const source = match[0];
    const name = TAG_NAME.exec(source)?.[1]?.toLowerCase() ?? '';
    return { start: match.index, end: match.index + source.length, closing: source[1] === '/', name, source };
  });
}

/** Where someone else's words may be: [start, end) in the text it was found in. */
interface Span {
  readonly start: number;
  readonly end: number;
  /**
   * Whether markup closes it, as a quote's closing tag does. A quote mark
   * inside a closed span is part of the words it holds, so it doesn't pair
   * with one outside. A span that runs on to the end of a line or of the text
   * may hold the mark that closes a tapback, so its marks still count.
   */
  readonly closed: boolean;
}

/**
 * An element from its first opening tag to the end of its last closing one,
 * so markup inside it can't end it early, or to the end of the text if an
 * opening tag follows the last closing one.
 */
function elementSpan(tags: readonly Tag[], name: string, length: number): Span | undefined {
  const named = tags.filter((tag) => tag.name === name);
  const start = named.find((tag) => !tag.closing)?.start;
  if (start === undefined) return undefined;
  const last = named.at(-1)!;
  return last.closing ? { start, end: last.end, closed: true } : { start, end: length, closed: false };
}

/** An href to a person: matrix.to (its "@" may be encoded) or a `matrix:u/` URI. */
const PERSON_LINK = /\bhref\s*=\s*["']?(?:https?:\/\/matrix\.to\/#\/(?:@|%40)|matrix:u\/)/i;

/** Each link to a person, its text included, up to its closing tag, or to the end of the text if it has none. */
function personLinks(tags: readonly Tag[], length: number): Span[] {
  const spans: Span[] = [];
  let start: number | undefined;
  for (const tag of tags) {
    if (tag.name !== 'a') continue;
    if (start === undefined) {
      if (!tag.closing && PERSON_LINK.test(tag.source)) start = tag.start;
    } else if (tag.closing) {
      spans.push({ start, end: tag.end, closed: true });
      start = undefined;
    }
  }
  if (start !== undefined) spans.push({ start, end: length, closed: false });
  return spans;
}

/**
 * A line that starts with ">", how plain text quotes. It may start after any
 * line break but runs on to the next "\n": a client quotes a message line by
 * line, split on "\n", so a carriage return or a Unicode line separator
 * inside a quoted line doesn't end the quote.
 */
const QUOTE_LINE = /^[ \t]*>[^\n]*/gm;

function quoteLines(text: string): Span[] {
  return Array.from(text.matchAll(QUOTE_LINE), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    closed: false,
  }));
}

/** Elements that end a line, so a quote after one still starts its own. */
const LINE_ENDING = new Set(['br', 'p', 'div', 'li', 'tr', 'pre', 'hr', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'mx-reply']);

const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;

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

/** The text as it reads, and where in the source each of its characters came from. */
interface Rendering {
  readonly text: string;
  readonly origin: Int32Array;
}

/**
 * Markup becomes a line break or a space, and entities are decoded. Neither
 * is ever longer than what it replaces, so the rendering is never longer
 * than its source.
 */
function render(source: string, tags: readonly Tag[]): Rendering {
  const parts: string[] = [];
  const origin = new Int32Array(source.length);
  let length = 0;
  let at = 0;
  const copy = (end: number) => {
    parts.push(source.slice(at, end));
    for (; at < end; at++) origin[length++] = at;
  };
  const replace = (end: number, chars: string) => {
    parts.push(chars);
    for (let i = 0; i < chars.length; i++) origin[length++] = at;
    at = end;
  };
  // An entity holds no "<" or ">", so it never spans the edge of a tag, and one inside a tag goes with it.
  const entities = Array.from(source.matchAll(ENTITY));
  let next = 0;
  const decode = (end: number) => {
    for (; next < entities.length && entities[next]!.index < end; next++) {
      const entity = entities[next]!;
      if (entity.index < at) continue;
      copy(entity.index);
      replace(entity.index + entity[0].length, decodeEntity(entity[0], entity[1], entity[2], entity[3]));
    }
    copy(end);
  };
  for (const tag of tags) {
    decode(tag.start);
    replace(tag.end, LINE_ENDING.has(tag.name) ? '\n' : ' ');
  }
  decode(source.length);
  return { text: parts.join(''), origin: origin.subarray(0, length) };
}

/** Per character of the source: may be someone else's words, and if so, whether a closed span holds them. */
const QUOTED = 1;
const CLOSED = 2;

const QUOTE_MARKS = new Set(['"', '“', '”'].map((mark) => mark.charCodeAt(0)));

/**
 * From the first quote mark to the last, how a bridge shows a tapback
 * ('Liked “...”'), whatever the quoted message holds. A mark a closed span
 * holds doesn't count; see `Span.closed`.
 */
function quotedPassage({ text, origin }: Rendering, flags: Uint8Array): Span | undefined {
  let first = -1;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    if (!QUOTE_MARKS.has(text.charCodeAt(i)) || flags[origin[i]!]! & CLOSED) continue;
    if (first === -1) first = i;
    last = i;
  }
  return last > first ? { start: first, end: last + 1, closed: false } : undefined;
}

/** The text without its quoted stretches, each of which leaves a line break if it held one, else a space. */
function unquoted(text: string, quoted: Uint8Array): string {
  const kept: string[] = [];
  for (let start = 0, end = 0; start < text.length; start = end) {
    while (end < text.length && quoted[end] === quoted[start]) end++;
    const run = text.slice(start, end);
    kept.push(!quoted[start] ? run : run.includes('\n') ? '\n' : ' ');
  }
  return kept.join('');
}

/**
 * What a message's sender wrote themselves, read cautiously from Beeper's
 * `text`: Matrix's HTML formatted body when there is one, else the plain
 * body, which may hold "<" too, so both are read as HTML. Left out:
 *
 * - the copy of the message a reply answers (`<mx-reply>`) and quoted
 *   passages (`<blockquote>`); see `elementSpan`;
 * - lines starting with ">", how plain text quotes, as written and as they
 *   read once markup is gone;
 * - everything from the first quote mark to the last, how a bridge shows a
 *   tapback ('Liked “...”'), whatever the quoted message holds;
 * - pills: links to a person in the chat, whose name that person chose.
 *
 * Each rule looks at the whole text, and what is left out is everything any
 * of them finds. No rule reads what another left, so the words one quotes
 * can't hide from another what it looks for, such as the mark that closes a
 * tapback. Every step takes time linear in the text, so a hostile message
 * can't stall a watch.
 */
export function ownText(text: string): string {
  const tags = tagsIn(text);
  const flags = new Uint8Array(text.length);
  const spans = [
    elementSpan(tags, 'mx-reply', text.length),
    elementSpan(tags, 'blockquote', text.length),
    ...personLinks(tags, text.length),
    ...quoteLines(text),
  ];
  for (const span of spans) {
    if (span === undefined) continue;
    const flag = span.closed ? QUOTED | CLOSED : QUOTED;
    for (let at = span.start; at < span.end; at++) flags[at]! |= flag;
  }

  const rendering = render(text, tags);
  const quoted = new Uint8Array(rendering.text.length);
  for (let i = 0; i < quoted.length; i++) quoted[i] = flags[rendering.origin[i]!]! & QUOTED;
  for (const span of [...quoteLines(rendering.text), quotedPassage(rendering, flags)]) {
    if (span !== undefined) quoted.fill(QUOTED, span.start, span.end);
  }
  return unquoted(rendering.text, quoted);
}
