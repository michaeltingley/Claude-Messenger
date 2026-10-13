import { decodeEntities } from './entities.js';
import { replyCopyEnd } from './plain-quotes.js';

/**
 * A tag, as HTML reads one: "<", an optional "/", a name that ends at a
 * space, "/" or ">", then attributes up to ">", where a quoted value may hold
 * ">". A comment or a declaration ("<!...>", "<?...>") counts too. Nothing
 * in a tag can run past the next "<", and a name ends in one place only, so
 * finding every tag takes time linear in the text.
 */
const TAG = /<(?:(\/?)([A-Za-z][A-Za-z\d-]*)(?=[\s/>])((?:[^<>"']|"[^<"]*"|'[^<']*')*)|[!?][^<>]*)>/g;

/**
 * The elements a Matrix message's HTML may hold: the spec's list, the
 * deprecated ones clients still send, and <mx-reply>. Beeper's `text`
 * doesn't say whether it is HTML or a plain body, so nothing else counts as
 * markup: "Press <Enter>", "List<String>" or "<hugs>" stays as written.
 */
const ELEMENTS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'del',
  'details',
  'div',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'mx-reply',
  'ol',
  'p',
  'pre',
  'rp',
  'rt',
  'ruby',
  's',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

/** Elements that end a line. */
const LINE_ENDING = new Set(['br', 'p', 'div', 'li', 'tr', 'pre', 'hr', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);

/** An image's alt attribute, its value quoted either way or bare. */
const ALT = /(?:^|\s)alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/** A tag's element, lower-cased, when it is one a message's HTML may hold. */
function elementOf(name: string | undefined): string | undefined {
  const element = name?.toLowerCase();
  return element !== undefined && ELEMENTS.has(element) ? element : undefined;
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
    if (elementOf(match[2]) !== 'mx-reply') continue;
    if (match[1] !== '/') start ??= match.index;
    else if (start !== undefined) end = match.index + match[0].length;
  }
  return start === undefined ? html : `${html.slice(0, start)}\n${html.slice(end)}`;
}

/** What a tag shows in the chat: an image its alt text (a custom emoji's name), a line break, or nothing. */
function shown(tag: string, slash: string | undefined, name: string | undefined, attributes: string | undefined): string {
  if (name === undefined) return ''; // a comment or a declaration
  const element = elementOf(name);
  if (element === undefined) return tag; // text that only looks like a tag
  if (element === 'img' && slash === '') {
    const alt = ALT.exec(attributes!);
    return alt === null ? '' : (alt[1] ?? alt[2] ?? alt[3]!);
  }
  return LINE_ENDING.has(element) ? '\n' : '';
}

/**
 * A message's text as plain text, as the chat shows it, from Beeper's
 * `text`: Matrix's HTML formatted body when there is one, else the plain
 * body. The copy of the message a reply answers is left out (the chat has
 * that message already), whether HTML holds it or a plain body opens with
 * it, as Matrix's reply fallback writes it. Markup is dropped, with a line
 * break for each element that ends a line, and entities are decoded once. A
 * link keeps its text and loses where it points; an image keeps its alt
 * text. Every step takes time linear in the text.
 */
export function plainText(text: string): string {
  const html = withoutReplyCopy(text.slice(replyCopyEnd(text))).replace(TAG, shown);
  return decodeEntities(html).trim();
}
