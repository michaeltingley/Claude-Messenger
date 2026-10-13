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

function nameOf(tag: string): string {
  return TAG_NAME.exec(tag)?.[1]?.toLowerCase() ?? '';
}

function* tagsIn(html: string): Generator<Tag> {
  for (const match of html.matchAll(TAG)) {
    const source = match[0];
    yield { start: match.index, end: match.index + source.length, closing: source[1] === '/', name: nameOf(source), source };
  }
}

/**
 * Drops an element from its first opening tag to the end of its last
 * closing one, or to the end of the text if none closes it.
 */
function withoutElement(html: string, name: string): string {
  let start: number | undefined;
  let end = html.length;
  for (const tag of tagsIn(html)) {
    if (tag.name !== name) continue;
    if (!tag.closing) start ??= tag.start;
    else if (start !== undefined) end = tag.end;
  }
  // A block ends a line, so a ">" after it still starts one.
  return start === undefined ? html : `${html.slice(0, start)}\n${html.slice(end)}`;
}

/** An href to a person: matrix.to (its "@" may be encoded) or a `matrix:u/` URI. */
const PERSON_LINK = /\bhref\s*=\s*["']?(?:https?:\/\/matrix\.to\/#\/(?:@|%40)|matrix:u\/)/i;

/** Drops each link to a person, its text included, up to its closing tag, or to the end if it has none. */
function withoutPersonLinks(html: string): string {
  let kept = '';
  let from = 0;
  let inLink = false;
  for (const tag of tagsIn(html)) {
    if (tag.name !== 'a') continue;
    if (!inLink && !tag.closing && PERSON_LINK.test(tag.source)) {
      kept += `${html.slice(from, tag.start)} `;
      inLink = true;
    } else if (inLink && tag.closing) {
      from = tag.end;
      inLink = false;
    }
  }
  return inLink ? kept : kept + html.slice(from);
}

/** Elements that end a line, so a quote after one still starts its own. */
const LINE_ENDING = new Set(['br', 'p', 'div', 'li', 'tr', 'pre', 'hr', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'mx-reply']);

function separatorFor(tag: string): string {
  return LINE_ENDING.has(nameOf(tag)) ? '\n' : ' ';
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

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, decodeEntity);
}

function withoutQuoteLines(text: string): string {
  return text.replace(/^[ \t]*>.*$/gm, ' ');
}

/** From the first quote mark to the last. A mention between two separate quotes goes with them. */
function withoutQuotedPassage(text: string): string {
  const first = text.search(/["“”]/);
  const last = Math.max(text.lastIndexOf('"'), text.lastIndexOf('“'), text.lastIndexOf('”'));
  return first !== -1 && last > first ? `${text.slice(0, first)} ${text.slice(last + 1)}` : text;
}

/**
 * What a message's sender wrote themselves, from Beeper's `text`: Matrix's
 * HTML formatted body when there is one, else the plain body. Left out:
 *
 * - the copy of the message a reply answers (`<mx-reply>`) and quoted
 *   passages (`<blockquote>`), each from its first opening tag to its last
 *   closing one, so markup inside the copy can't end it early;
 * - lines starting with ">", how plain text quotes, before markup is read
 *   and again after;
 * - everything from the first quote mark to the last, how a bridge shows a
 *   tapback ('Liked “...”'), whatever the quoted message holds;
 * - pills: links to a person in the chat, whose name that person chose.
 *
 * The rest loses its markup and has its entities decoded. Every step takes
 * time linear in the text, so a hostile message can't stall a watch.
 */
export function ownText(text: string): string {
  const html = withoutPersonLinks(withoutElement(withoutElement(withoutQuoteLines(text), 'mx-reply'), 'blockquote'));
  return withoutQuotedPassage(withoutQuoteLines(decodeEntities(html.replace(TAG, separatorFor))));
}
