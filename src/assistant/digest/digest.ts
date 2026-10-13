import type { LanguageModel } from '../../core/model.js';
import type { Activity, ActivityCollector, DigestWindow } from './activity.js';
import { renderBriefing } from './briefing.js';
import { DIGEST_INSTRUCTIONS } from './instructions.js';
import { formatDateTime } from './time.js';

/**
 * Writes the owner's digest of a window: what needs them first, then the
 * rest, in Markdown. The language model writes the summary; what the digest
 * covers, and every gap in it, is stated beneath it as counted, never as the
 * model puts it.
 */
export class DigestWriter {
  constructor(
    private readonly collector: ActivityCollector,
    private readonly model: LanguageModel,
  ) {}

  /** The digest of `window`, its times in `timeZone`, an IANA time zone such as "America/Los_Angeles". */
  async write(window: DigestWindow, timeZone: string): Promise<string> {
    const activity = await this.collector.collect(window);
    const since = formatDateTime(window.since, timeZone);
    if (activity.chats.length === 0) return footnote(`No new messages since ${since}.`, gaps(activity, 0));

    const briefing = renderBriefing(activity, timeZone);
    const summary = withoutLinks(await this.model.write({ instructions: DIGEST_INSTRUCTIONS, input: briefing.text }));
    const coverage = `Covers ${chats(briefing.chats)} and ${count(briefing.messages, 'message')} since ${since}.`;
    return `${summary}\n\n${footnote(coverage, gaps(activity, briefing.leftOut))}`;
  }
}

/** What a digest couldn't cover, as counted: the reads that failed or stopped short, and chats cut for length. */
function gaps({ unreadable, partial, moreChats }: Activity, leftOut: number): string[] {
  return [
    ...(unreadable > 0 ? [`${chats(unreadable)} couldn't be read`] : []),
    ...(partial > 0 ? [`${chats(partial)} had more messages than a digest reads`] : []),
    ...(leftOut > 0 ? [`${chats(leftOut)} left out for length`] : []),
    ...(moreChats ? ['more chats had activity than a digest reads'] : []),
  ];
}

/**
 * The model's text with every link and email address taken out. It is told
 * never to repeat one, but a message could still get one past it, and a
 * link reaches the owner inside a summary they trust more than the message.
 * A link ends before any punctuation that ends its sentence.
 */
function withoutLinks(text: string): string {
  return text
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/<?(?:[a-z][a-z\d+.-]*:\/\/|\bwww\.)[^\s<>()]*[^\s<>().,;:!?'"*_~]>?/gi, '(link)')
    .replace(/<?\b(?:mailto:)?[\w.+-]+[@＠][\w-]+(?:\.[\w-]+)+>?/gi, '(email address)');
}

/** One italic line: a sentence, then any gaps in what it covers as one more. */
function footnote(sentence: string, gaps: string[]): string {
  if (gaps.length === 0) return `_${sentence}_`;
  const more = gaps.join('; ');
  return `_${sentence} ${more.charAt(0).toUpperCase()}${more.slice(1)}._`;
}

function chats(n: number): string {
  return count(n, 'chat');
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
