import { shownAs } from './elements.js';
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

/** An image's alt attribute, its value quoted either way or bare. */
const ALT = /(?:^|\s)alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

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
    if (match[2]?.toLowerCase() !== 'mx-reply') continue;
    if (match[1] !== '/') start ??= match.index;
    else if (start !== undefined) end = match.index + match[0].length;
  }
  return start === undefined ? html : `${html.slice(0, start)}\n${html.slice(end)}`;
}

/**
 * What a tag shows in the chat: an image its alt text if it has some (a
 * custom emoji's name), any other tag what its element shows as, and a
 * comment nothing.
 */
function shown(tag: string, slash: string | undefined, name: string | undefined, attributes: string | undefined): string {
  if (name === undefined) return ''; // a comment or a declaration
  const shows = shownAs(name);
  if (shows === undefined) return tag; // text that only looks like a tag
  const alt = slash === '' && name.toLowerCase() === 'img' ? ALT.exec(attributes!) : null;
  return alt === null ? shows : (alt[1] ?? alt[2] ?? alt[3]!);
}

/**
 * A message's text as plain text, as the chat shows it, from Beeper's
 * `text`: Matrix's HTML formatted body when there is one, else the plain
 * body. The copy of the message a reply answers is left out (the chat has
 * that message already), whether HTML holds it or a plain body opens with
 * it, as Matrix's reply fallback writes it. Markup shows as the chat lays it
 * out, as a line break, a space or nothing, and entities are decoded once.
 * A link keeps its text and loses where it points; an image keeps its alt
 * text. Every step takes time linear in the text.
 */
export function plainText(text: string): string {
  const html = withoutReplyCopy(text.slice(replyCopyEnd(text))).replace(TAG, shown);
  return decodeEntities(html).trim();
}
