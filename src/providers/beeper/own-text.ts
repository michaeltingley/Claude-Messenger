import { shownAs } from './elements.js';
import { entitiesIn } from './entities.js';
import { quoteLines, replyCopyEnd, type Span } from './plain-quotes.js';

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

/** Where someone else's words may be. */
interface Quoted extends Span {
  /**
   * Whether markup closes it, as a quote's closing tag does, rather than it
   * running on to the end of a line or of the text. A bridge adds the mark
   * that closes a tapback ('Liked “...”') after the message the tapback
   * quotes, so a span that runs on may hold that mark.
   */
  readonly closed: boolean;
}

/**
 * The markup in the text. A tag that starts on a quoted line and runs past
 * it is text: the line holds another message, and nothing that message
 * holds can enclose what follows it.
 */
function tagsIn(text: string, lines: readonly Span[]): Tag[] {
  const tags: Tag[] = [];
  let line = 0;
  for (const match of text.matchAll(TAG)) {
    const source = match[0];
    const start = match.index;
    const end = start + source.length;
    while (line < lines.length && lines[line]!.end <= start) line++;
    if (line < lines.length && lines[line]!.start <= start && end > lines[line]!.end) continue;
    const name = TAG_NAME.exec(source)?.[1]?.toLowerCase() ?? '';
    tags.push({ start, end, closing: source[1] === '/', name, source });
  }
  return tags;
}

/**
 * An element from its first opening tag to the end of its last closing one,
 * so markup inside it can't end it early, or to the end of the text if an
 * opening tag follows the last closing one.
 */
function elementSpan(tags: readonly Tag[], name: string, length: number): Quoted | undefined {
  const named = tags.filter((tag) => tag.name === name);
  const start = named.find((tag) => !tag.closing)?.start;
  if (start === undefined) return undefined;
  const last = named.at(-1)!;
  return last.closing ? { start, end: last.end, closed: true } : { start, end: length, closed: false };
}

/** An href to a person: matrix.to (its "@" may be encoded) or a `matrix:u/` URI. */
const PERSON_LINK = /\bhref\s*=\s*["']?(?:https?:\/\/matrix\.to\/#\/(?:@|%40)|matrix:u\/)/i;

/**
 * Each link to a person, its text included, up to the closing tag that
 * balances its own, so a link inside its text can't end it early, or to the
 * end of the text if no tag does.
 */
function personLinks(tags: readonly Tag[], length: number): Quoted[] {
  const spans: Quoted[] = [];
  let start: number | undefined;
  let depth = 0;
  for (const tag of tags) {
    if (tag.name !== 'a') continue;
    if (start === undefined) {
      if (tag.closing || !PERSON_LINK.test(tag.source)) continue;
      start = tag.start;
      depth = 1;
    } else if (!tag.closing) {
      depth++;
    } else if (--depth === 0) {
      spans.push({ start, end: tag.end, closed: true });
      start = undefined;
    }
  }
  if (start !== undefined) spans.push({ start, end: length, closed: false });
  return spans;
}

/** The text as it reads, and where in the source each of its characters came from. */
interface Rendering {
  readonly text: string;
  readonly origin: Int32Array;
}

/**
 * Markup becomes what it shows as in the chat, so a word partly in bold
 * stays one word and a quote after a line break still starts a line of its
 * own. Anything else shaped like a tag becomes a space, as "<" and ">" keep
 * the words on either side apart in text, and nothing it holds is read.
 * Entities are decoded. Nothing is ever longer than what it replaces, so the
 * rendering is never longer than its source.
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
  const entities = entitiesIn(source);
  let next = 0;
  const decode = (end: number) => {
    for (; next < entities.length && entities[next]!.index < end; next++) {
      const entity = entities[next]!;
      if (entity.index < at) continue;
      copy(entity.index);
      replace(entity.index + entity.length, entity.decoded);
    }
    copy(end);
  };
  for (const tag of tags) {
    decode(tag.start);
    replace(tag.end, shownAs(tag.name) ?? ' ');
  }
  decode(source.length);
  return { text: parts.join(''), origin: origin.subarray(0, length) };
}

/** Per character of the source: may be someone else's words, and if so, whether a closed span holds them. */
const QUOTED = 1;
const CLOSED = 2;

const QUOTE_MARKS = new Set(['"', '“', '”'].map((mark) => mark.charCodeAt(0)));

/** Whether the text ends in a quote mark, but for white space, as a tapback ('Liked “...”') does. */
function endsInQuoteMark(text: string): boolean {
  const end = text.trimEnd();
  return end.length > 0 && QUOTE_MARKS.has(end.charCodeAt(end.length - 1));
}

/**
 * From the first quote mark that `counts` to the last, how a bridge shows a
 * tapback ('Liked “...”'), whatever the quoted message holds.
 */
function quotedPassage(text: string, counts: (at: number) => boolean): Span | undefined {
  let first = -1;
  let last = -1;
  for (let i = 0; i < text.length; i++) {
    if (!QUOTE_MARKS.has(text.charCodeAt(i)) || !counts(i)) continue;
    if (first === -1) first = i;
    last = i;
  }
  return last > first ? { start: first, end: last + 1 } : undefined;
}

/** The text with each quoted stretch as a space, so the words on either side of one stay apart. */
function unquoted(text: string, quoted: Uint8Array): string {
  const kept: string[] = [];
  for (let start = 0, end = 0; start < text.length; start = end) {
    while (end < text.length && quoted[end] === quoted[start]) end++;
    kept.push(quoted[start] ? ' ' : text.slice(start, end));
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
 * of them finds: no rule reads what another left. Every step takes time
 * linear in the text, so a hostile message can't stall a watch.
 */
export function ownText(text: string): string {
  const lines = quoteLines(text);
  const tags = tagsIn(text, lines);
  const flags = new Uint8Array(text.length);
  const spans = [
    elementSpan(tags, 'mx-reply', text.length),
    elementSpan(tags, 'blockquote', text.length),
    ...personLinks(tags, text.length),
    ...lines.map((line): Quoted => ({ ...line, closed: false })),
  ];
  for (const span of spans) {
    if (span === undefined) continue;
    const flag = span.closed ? QUOTED | CLOSED : QUOTED;
    for (let at = span.start; at < span.end; at++) flags[at]! |= flag;
  }

  const { text: rendered, origin } = render(text, tags);
  const quoted = new Uint8Array(rendered.length);
  for (let i = 0; i < quoted.length; i++) quoted[i] = flags[origin[i]!]! & QUOTED;
  for (const line of quoteLines(rendered)) quoted.fill(QUOTED, line.start, line.end);

  // Which quote marks count toward a quoted passage: a tapback's must, and
  // those in someone else's words mustn't pair with the sender's own. So not
  // those in the copy a plain-text reply opens with: a tapback opens with
  // what the person did, so its marks are never there. Nor those a closed
  // span holds, unless the text ends in a quote mark, as a tapback does: then
  // the message it quotes may have closed a span that opened before its
  // opening mark. A tapback after something that opens a quote, reply copy or
  // pill, with words after its closing mark, could still hide its opening
  // mark that way; no bridge is known to send either.
  const copyEnd = replyCopyEnd(text, lines);
  const held = endsInQuoteMark(rendered) ? 0 : CLOSED;
  const passage = quotedPassage(rendered, (i) => origin[i]! >= copyEnd && !(flags[origin[i]!]! & held));
  if (passage !== undefined) quoted.fill(QUOTED, passage.start, passage.end);
  return unquoted(rendered, quoted);
}
