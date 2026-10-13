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
/**
 * Not inside a run of what a domain is made of, so that each run is tried
 * once, from its start. No label starts with "_" or "-", so a run that does,
 * even right after a dot ("e.g.-evil.com"), takes them in as `lead`, which
 * is kept.
 */
const RUN_START = String.raw`(?<![\p{L}\p{N}\p{M}_-])(?:(?<!${LABEL_CHAR}\.)(?<![a-z\d]\u3002)|(?=[_-]))(?<lead>[_-]*)`;

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

/** What joins a code's groups: a dash, a run of spaces or tabs, or a line break inside a paragraph. */
const GROUP_JOINT = String.raw`(?:[\p{Pd}\u2212]|[^\S\n]*\n[^\S\n]*|[^\S\n]+)`;

/** A letter or digit of base58, the alphabet Matrix writes its recovery keys in: no 0, O, I or l. */
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

/**
 * A Matrix recovery key, as Element and other Matrix apps show one: "Es"
 * and 46 more of base58's letters and digits, in groups of four or not.
 * Some of its groups read as words ("Seir") and some stretches hold no
 * digit, so it is found by its shape as a whole.
 */
const MATRIX_KEY = new RegExp(
  String.raw`(?<![A-Za-z\d])Es${BASE58}{2}(?:${GROUP_JOINT}?${BASE58}{4}){11}(?![A-Za-z\d])`,
  'gu',
);

/**
 * One group of a code written in groups: four or more Latin letters and
 * digits that aren't a word, so it holds a digit or a capital after its
 * first letter ("3yST", "VK7JG", "TKBj", not "Bank" or "ports").
 */
const CODE_GROUP = String.raw`(?![A-Za-z][a-z]+(?![A-Za-z\d]))[A-Za-z\d]{4,}(?![A-Za-z\d])`;

/**
 * Two or more such groups in a row, each joined to the next as a code's
 * are. A try at a run ends where its groups do, so this takes time linear
 * in the text.
 */
const GROUP_RUN = new RegExp(String.raw`(?<![A-Za-z\d])${CODE_GROUP}(?:${GROUP_JOINT}${CODE_GROUP})+`, 'gu');

/** Fewer groups than this, joined by dashes or by spaces, are more likely names than a code ("DDR5-6000", "H100 A100 V100"). */
const MIN_GROUPS = { dash: 3, space: 4 } as const;

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
 * phone number or code in it that can be told from words, nothing a
 * Markdown renderer could make into a link, and nothing a terminal could
 * run.
 *
 * The model is told never to repeat any of these, but a message could still
 * get one past it, and it would reach the owner inside a summary they trust
 * more than the message. So each character but an emoji's takes its plain
 * form (NFKC: a fullwidth "４１５" becomes "415", a no-break space a space),
 * control and invisible characters go, a Markdown link keeps only its text,
 * each URL or domain but a file's name becomes "(link)", each email address
 * "(email address)", each long code of letters and digits, Matrix recovery
 * key or code written in groups of one length "(code)", and each phone,
 * account or card number or code of digits "(number)", and "\", "[", "]",
 * "<", "&" and "`" are escaped, as are emphasis markers inside an address,
 * so nothing left can open a link, raw HTML, an entity or a code span. Bold,
 * italics, lists and headings stay as written. Each step takes time linear
 * in the text, whatever the text is.
 *
 * What can't be told from words or a list still gets through: a number
 * spelled out or written in letters that look like digits, a short code of
 * letters and digits ("A1B2C3"), a code in groups that holds no digit, has
 * a group that reads as a word, or has fewer groups than `MIN_GROUPS`, and
 * digits split by a comma and a space or by more signs than group a number.
 * So the instructions are the first guard and this is the second.
 */
export function safeMarkdown(markdown: string): string {
  const plain = markdown.replace(MARK_RUN, '$1').replace(FOLDABLE, (run) => run.normalize('NFKC'));
  const hidden = withoutNumbers(
    withoutInvisible(plain)
      .replace(MARKDOWN_LINK, '$1')
      .replace(URL, '(link)')
      .replace(EMAIL, '(email address)')
      .replace(HOST, linkOrFileName)
      .replace(MATRIX_KEY, '(code)')
      .replace(CODE, '(code)')
      .replace(GROUP_RUN, withoutGroupedCodes),
  );
  return hidden.replace(MARKUP, '\\$&').replace(SPLITTING_MARKERS, (markers) => markers.replace(/./g, '\\$&'));
}

/**
 * A run of `GROUP_RUN` with each code in it written in groups made
 * "(code)": groups of one length, as a product key's or a gift card's are,
 * all joined by dashes or all by spaces (a line break may stand for
 * either), at least `MIN_GROUPS` of them, holding letters and digits. Groups
 * of other lengths, or joined another way, start another code. A code with
 * no digit is left alone ("HTTP SMTP IMAP LDAP"), and one with no letter is
 * left for what finds numbers.
 */
function withoutGroupedCodes(run: string): string {
  // The groups, at even places, and what joins each to the next, at odd ones.
  const parts = run.split(/([^A-Za-z\d]+)/);
  let shown = '';
  let first = 0;
  let joint: keyof typeof MIN_GROUPS | undefined;
  const end = (last: number) => {
    const code = parts.slice(first, last + 1).join('');
    const groups = (last - first) / 2 + 1;
    const isCode = groups >= MIN_GROUPS[joint ?? 'space'] && /\d/.test(code) && /[A-Za-z]/.test(code);
    shown += isCode ? '(code)' : code;
  };
  for (let i = 2; i < parts.length; i += 2) {
    const between = parts[i - 1]!;
    const kind = between.includes('\n') ? undefined : /\s/.test(between) ? 'space' : 'dash';
    if (parts[i]!.length === parts[first]!.length && (kind === undefined || joint === undefined || kind === joint)) {
      joint ??= kind;
      continue;
    }
    end(i - 2);
    shown += between;
    first = i;
    joint = undefined;
  }
  end(parts.length - 1);
  return shown;
}

/** "(link)" for a match of `HOST`, after what it starts with that is no domain's, unless it is a file's name. */
function linkOrFileName(host: string, ...args: unknown[]): string {
  const { lead, tld, rest } = args.at(-1) as { lead: string; tld?: string; rest: string };
  return rest === '' && tld !== undefined && FILE_TYPES.has(tld.toLowerCase()) ? host : `${lead}(link)`;
}
