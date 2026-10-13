import { withoutInvisible } from './characters.js';

/** A Markdown link or image, `[text](where)`: only its text stays. */
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\n]*\)/g;

/**
 * A URL with a scheme ("https://", "ftp://") or from "//", wrapped in "<>"
 * or not. Like each URL below, it ends before any punctuation that ends its
 * sentence.
 */
const URL = /(?<![\p{L}\p{N}+.-])<?(?:[a-z][a-z\d+.-]*:)?\/\/[^\s<>()[\]{}`]*[^\s<>()[\]{}`.,;:!?'"*_~|]>?/giu;

/** A URL from "www.", after anything but a letter or digit, as GitHub's Markdown reads one. */
const WWW = /(?<![\p{L}\p{N}])<?www\.[^\s<>()[\]{}`]*[^\s<>()[\]{}`.,;:!?'"*_~|]>?/giu;

/** An email address, however its at sign is written, with "mailto:" and "<>" or not. */
const EMAIL = /(?<![\p{L}\p{N}._%+-])<?(?:mailto:)?[\p{L}\p{N}._%+-]+(?:[@＠﹫]|%40)[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+>?/giu;

/**
 * A domain with a path or a query ("bit.ly/3xYz"). A bare domain, as in a
 * business's name ("Amazon.com"), stays, as does the question mark of
 * "Did you see amazon.com?".
 */
const DOMAIN_AND_PATH =
  /(?<![\p{L}\p{N}.@/-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,63}(?:\/|[?#](?=[\p{L}\p{N}=&%]))(?:[^\s<>()[\]{}`]*[^\s<>()[\]{}`.,;:!?'"*_~|])?/gu;

/**
 * A phone number (one with its country code, or one shaped like a North
 * American one), or six or more digits in a row, as a code is. Dates,
 * times, years and amounts stay.
 */
const NUMBER = /(?<![\p{L}\p{N}+])(?:\+\d[\d ().-]{5,}\d|(?:1[ .-]?)?(?:\(\d{3}\) ?|\d{3}[ .-]?)\d{3}[ .-]?\d{4}|\d{6,})(?![\p{L}\p{N}])/gu;

/** What could still open a link, an autolink, raw HTML or an entity, and the escape that would undo one. */
const MARKUP = /[\\[\]<&]/g;

/**
 * The model's Markdown as the owner may be shown it: no link, email address,
 * phone number or code in it, nothing a Markdown renderer could make into a
 * link, and nothing a terminal could run.
 *
 * The model is told never to repeat any of these, but a message could still
 * get one past it, and it would reach the owner inside a summary they trust
 * more than the message. So control and invisible characters go, a Markdown
 * link keeps only its text, each URL becomes "(link)", each email address
 * "(email address)" and each phone number or code "(number)", and "\", "[",
 * "]", "<" and "&" are escaped, so nothing left can open a link, raw HTML or
 * an entity. Bold, italics, lists and headings stay as written.
 */
export function safeMarkdown(markdown: string): string {
  return withoutInvisible(markdown)
    .replace(MARKDOWN_LINK, '$1')
    .replace(URL, '(link)')
    .replace(WWW, '(link)')
    .replace(EMAIL, '(email address)')
    .replace(DOMAIN_AND_PATH, '(link)')
    .replace(NUMBER, '(number)')
    .replace(MARKUP, '\\$&');
}
