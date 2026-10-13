/** [start, end) in the text it was found in. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * A line that starts with ">", how plain text quotes. It may start after any
 * line break but runs on to the next "\n": a client quotes a message line by
 * line, split on "\n", so a carriage return or a Unicode line separator
 * inside a quoted line doesn't end the quote.
 */
const QUOTE_LINE = /^[ \t]*>[^\n]*/gm;

/** Each line of `text` that starts with ">", in order. */
export function quoteLines(text: string): Span[] {
  return Array.from(text.matchAll(QUOTE_LINE), (match) => ({ start: match.index, end: match.index + match[0].length }));
}

/**
 * How Matrix's reply fallback starts the copy of the message a plain-text
 * reply answers: "> <@bob:beeper.com> " before its first line, or
 * "> * <@bob:beeper.com> " for an emote. Every line after that starts with
 * "> " too, a blank one included, and a blank line ends the copy.
 */
const REPLY_COPY = /> (?:\* )?<[^<>\n]+> /y;
const BLANK_LINE = /\n[^\S\n]*\n/y;

/**
 * Where the copy a plain-text reply opens with ends, written as Matrix
 * writes it: quoted lines one after another from the start of the text,
 * but for white space, the first naming the sender, then a blank line. 0 if
 * the text opens with anything else, a quoted line of the sender's own
 * included: a quotation that opens there may go on in the lines after it.
 */
export function replyCopyEnd(text: string, lines: readonly Span[] = quoteLines(text)): number {
  const first = lines[0];
  if (first === undefined || text.slice(0, first.start).trim() !== '') return 0;
  REPLY_COPY.lastIndex = first.start;
  if (!REPLY_COPY.test(text)) return 0;
  let end = first.end;
  for (let i = 1; i < lines.length && lines[i]!.start === end + 1; i++) end = lines[i]!.end;
  BLANK_LINE.lastIndex = end;
  return BLANK_LINE.test(text) ? end : 0;
}
