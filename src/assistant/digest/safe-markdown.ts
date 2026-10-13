import { withoutInvisible } from './characters.js';

/**
 * A Markdown link or image, `[text](where)`: only its text stays. Neither
 * part can hold a "[", so a try at one ends by the next "[", and finding
 * every link takes time linear in the text.
 */
const MARKDOWN_LINK = /!?\[([^[\]\n]*)\]\([^[)\n]*\)/g;

/**
 * A URL with a scheme ("https://", "ftp://") or from "//", wrapped in "<>"
 * or not. Like each URL below, it ends before any punctuation that ends its
 * sentence.
 */
const URL = /(?<![\p{L}\p{N}+.-])<?(?:[a-z][a-z\d+.-]*:)?\/\/[^\s<>()[\]{}`]*[^\s<>()[\]{}`.,;:!?'"*_~|]>?/giu;

/** A URL from "www.", after anything but a letter or digit, as GitHub's Markdown reads one. */
const WWW = /(?<![\p{L}\p{N}])<?www\.[^\s<>()[\]{}`]*[^\s<>()[\]{}`.,;:!?'"*_~|]>?/giu;

/** An email address, with "mailto:" and "<>" or not, and its at sign as "%40" or not. */
const EMAIL = /(?<![\p{L}\p{N}._%+-])<?(?:mailto:)?[\p{L}\p{N}._%+-]+(?:@|%40)[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+>?/giu;

/**
 * A domain or an IPv4 address with a port, a path or a query: "bit.ly/3xYz",
 * "evil.example:8080", "evil.xn--p1ai/login", "127.0.0.1/login". A bare
 * domain, as in a business's name ("Amazon.com"), stays, as does the
 * question mark of "Did you see amazon.com?". It starts only at the start
 * of a run of what a domain is made of, so each run is tried once, and
 * finding them all takes time linear in the text.
 */
const HOST_AND_PATH =
  /(?<![\p{L}\p{N}_.-])(?:(?:[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?\.)+(?:\p{L}{2,63}|xn--[\p{L}\p{N}-]{1,59})|(?:\d{1,3}\.){3}\d{1,3})(?:(?::\d{1,5})?(?:\/|[?#](?=[\p{L}\p{N}=&%]))(?:[^\s<>()[\]{}`]*[^\s<>()[\]{}`.,;:!?'"*_~|])?|:\d{1,5}(?![\p{L}\p{N}]))/gu;

/**
 * A phone number (one with its country code, or one shaped like a North
 * American one), its digits grouped by spaces, dots or any dash or not, or
 * six or more digits in a row, as a code is. Dates, times, years and
 * amounts stay.
 */
const NUMBER =
  /(?<![\p{L}\p{N}+])(?:\+\d[\d ().\p{Pd}\u2212]{5,}\d|(?:1[ .\p{Pd}\u2212]?)?(?:\(\d{3}\) ?|\d{3}[ .\p{Pd}\u2212]?)\d{3}[ .\p{Pd}\u2212]?\d{4}|\d{6,})(?![\p{L}\p{N}])/gu;

/** What could still open a link, an autolink, raw HTML or an entity, and the escape that would undo one. */
const MARKUP = /[\\[\]<&]/g;

/** A run of anything but emoji, which keep their own form ("ℹ️", not "i"). */
const NOT_EMOJI = /\P{Extended_Pictographic}+/gu;

/**
 * The model's Markdown as the owner may be shown it: no link, email address,
 * phone number or code in it, nothing a Markdown renderer could make into a
 * link, and nothing a terminal could run.
 *
 * The model is told never to repeat any of these, but a message could still
 * get one past it, and it would reach the owner inside a summary they trust
 * more than the message. So each character but an emoji's takes its plain
 * form (NFKC: a fullwidth "４１５" becomes "415", a no-break space a space),
 * control and invisible characters go, a Markdown link keeps only its text,
 * each URL becomes "(link)", each email address "(email address)" and each
 * phone number or code "(number)", and "\", "[", "]", "<" and "&" are
 * escaped, so nothing left can open a link, raw HTML or an entity. Bold,
 * italics, lists and headings stay as written. Each step takes time linear
 * in the text, whatever the text is.
 */
export function safeMarkdown(markdown: string): string {
  return withoutInvisible(markdown.replace(NOT_EMOJI, (run) => run.normalize('NFKC')))
    .replace(MARKDOWN_LINK, '$1')
    .replace(URL, '(link)')
    .replace(WWW, '(link)')
    .replace(EMAIL, '(email address)')
    .replace(HOST_AND_PATH, '(link)')
    .replace(NUMBER, '(number)')
    .replace(MARKUP, '\\$&');
}
