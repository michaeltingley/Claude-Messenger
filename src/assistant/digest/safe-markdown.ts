import { withoutInvisible } from './characters.js';
import { withoutNumbers } from './numbers.js';

/**
 * More than this many marks on one character: no script stacks so many, and
 * past it, putting them in their plain form would take time that grows with
 * the square of the run.
 */
const MARK_RUN = /(\p{M}{16})\p{M}+/gu;

/**
 * A run of characters to put in their plain form: all but an emoji, which
 * keeps its own look ("ℹ️", not "i"), and Korean's letters written on their
 * own ("ㅋㅋ"), which would turn into the parts syllables are built from. An
 * emoji is a character shown as one by default, or one with the selector
 * that asks for its emoji look; "™" or "Ⓜ" alone reads as "TM" or "M", as a
 * browser reads one in a domain.
 */
const FOLDABLE = /(?:(?!\p{Emoji_Presentation}|\p{Extended_Pictographic}\ufe0f)[^\u3131-\u318e])+/gu;

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

/** An email address, with "mailto:" and "<>" or not, and its at sign as "%40" or not. */
const EMAIL = /(?<![\p{L}\p{N}._%+-])<?(?:mailto:)?[\p{L}\p{N}._%+-]+(?:@|%40)[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+>?/giu;

/** What a domain's labels are made of; one may also hold "-" and "_", but neither at either end. */
const LABEL_CHAR = String.raw`[\p{L}\p{N}\p{M}]`;
const LABEL = String.raw`${LABEL_CHAR}(?:[\p{L}\p{N}\p{M}_-]*${LABEL_CHAR})?`;
/**
 * What ends a label: a dot, or an ideographic full stop, as a browser reads
 * one, between two Latin letters or digits. Between others it ends a
 * sentence in Chinese or Japanese.
 */
const DOT = String.raw`(?:\.|(?<=[a-z\d])\u3002(?=[a-z\d]))`;
/**
 * The last label of a domain: letters, or one in its ASCII form
 * ("xn--p1ai"). A hyphen after it ends the domain, as a linkifier finds
 * "Amazon.com" in "Amazon.com-branded"; an underscore before a letter or a
 * digit makes it part of a word ("user.first_name"), which linkifiers leave
 * alone.
 */
const TLD = String.raw`(?<tld>xn--[a-z\d-]{1,59}|\p{L}[\p{L}\p{M}]{1,62})(?!${LABEL_CHAR}|_${LABEL_CHAR})`;
/** Four numbers and no more: "1.2.3.4.5" is no address. */
const IPV4 = String.raw`(?:\d{1,3}\.){3}\d{1,3}(?!\.?\p{N})`;
/** A path, a query or a fragment, ending before the punctuation that ends its sentence. */
const PATH = String.raw`[/?#][^\s<>()[\]{}\x60]*[^\s<>()[\]{}\x60.,;:!?'"*_~|]`;
/** Not inside a run of what a domain is made of, so that each run is tried once, from its start. */
const RUN_START = String.raw`(?<!${LABEL_CHAR})(?<!${LABEL_CHAR}\.|${LABEL_CHAR}[_-]+)(?<![a-z\d]\u3002)`;

/**
 * A domain or an IPv4 address, with a port, a path, a query or none:
 * "amazon.com", "bit.ly/3xYz", "evil.example.:8080", "127.0.0.1/login", but
 * not the question mark of "Did you see amazon.com?". It starts only at the
 * start of a run of what a domain is made of, so each run is tried once,
 * and finding them all takes time linear in the text.
 */
const HOST = new RegExp(
  String.raw`${RUN_START}(?:(?:${LABEL}${DOT})+${TLD}|${IPV4})(?<rest>(?:\.(?=[:/?#]))?(?::\d{1,5})?(?:${PATH})?)`,
  'giu',
);

/**
 * File types a name like "notes.txt" or "Node.js" ends in that no domain
 * does: none is a top-level domain (IANA's list, checked 2026-10-13). Alone,
 * such a name stays; with a port or a path, it is a link like any other.
 */
const FILE_TYPES = new Set([
  'apk', 'css', 'csv', 'dmg', 'doc', 'docx', 'exe', 'gif', 'gz', 'heic', 'htm', 'html', 'jpeg', 'jpg', 'js', 'json',
  'log', 'pdf', 'png', 'ppt', 'pptx', 'rtf', 'svg', 'tar', 'ts', 'txt', 'wav', 'webm', 'webp', 'xls', 'xlsx', 'xml',
  'yaml', 'yml',
]);

/**
 * A run of twenty or more Latin letters and digits, both in it, as a key, a
 * wallet's address or an account number written without spaces is.
 */
const CODE = /(?<![A-Za-z\d])(?=[A-Za-z\d]*\d)(?=[A-Za-z\d]*[A-Za-z])[A-Za-z\d]{20,}(?![A-Za-z\d])/g;

/** What could still open a link, an autolink, raw HTML, an entity or a code span, and the escape that would undo one. */
const MARKUP = /[\\[\]<&`]/g;

/**
 * Emphasis markers a renderer could drop from inside an address, so that it
 * shows whole: between two letters or digits ("evi*l.c*om"; an underscore
 * there emphasizes nothing), or between one and the dot or at sign that
 * joins it to the next ("_evil_.com", "evil.**com**"). Each run is tried
 * from its start only.
 */
const SPLITTING_MARKERS =
  /(?<=[\p{L}\p{N}\p{M}])(?:[*~]+(?=[\p{L}\p{N}\p{M}])|[*_~]+(?=[.@][\p{L}\p{N}\p{M}]))|(?<=[\p{L}\p{N}\p{M}][.@])[*_~]+(?=[\p{L}\p{N}\p{M}])/gu;

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
 * each URL or domain but a file's name becomes "(link)", each email address
 * "(email address)", each code of letters and digits "(code)" and each
 * phone, account or card number or code of digits "(number)", and "\",
 * "[", "]", "<", "&" and "`" are escaped, as are emphasis markers inside an
 * address, so nothing left can open a link, raw HTML, an entity or a code
 * span. Bold, italics, lists and headings stay as written. Each step takes
 * time linear in the text, whatever the text is.
 *
 * Words can't be told from words: a number spelled out, or written in
 * letters that look like digits, still gets through, so the instructions
 * are the first guard and this is the second.
 */
export function safeMarkdown(markdown: string): string {
  const plain = markdown.replace(MARK_RUN, '$1').replace(FOLDABLE, (run) => run.normalize('NFKC'));
  const hidden = withoutNumbers(
    withoutInvisible(plain)
      .replace(MARKDOWN_LINK, '$1')
      .replace(URL, '(link)')
      .replace(EMAIL, '(email address)')
      .replace(HOST, linkOrFileName)
      .replace(CODE, '(code)'),
  );
  return hidden.replace(MARKUP, '\\$&').replace(SPLITTING_MARKERS, (markers) => markers.replace(/./g, '\\$&'));
}

/** "(link)" for a match of `HOST`, unless it is a file's name. */
function linkOrFileName(host: string, ...args: unknown[]): string {
  const { tld, rest } = args.at(-1) as { tld?: string; rest: string };
  return rest === '' && tld !== undefined && FILE_TYPES.has(tld.toLowerCase()) ? host : '(link)';
}
