import { ModelError } from '../../core/errors.js';
import type { LanguageModel } from '../../core/model.js';
import type { Activity, ActivityCollector, DigestWindow } from './activity.js';
import { type Briefing, renderBriefing } from './briefing.js';
import { DIGEST_INSTRUCTIONS } from './instructions.js';
import { safeMarkdown } from './safe-markdown.js';
import { formatDateTime, isTimeZone } from './time.js';

/** A week at most: a digest is for catching up, not for reading history. */
export const MAX_DIGEST_DAYS = 7;

/** The day before `until`: what a digest covers unless told where it starts. */
export function dayBefore(until: Date): DigestWindow {
  return { since: new Date(until.getTime() - 24 * 3_600_000), until };
}

/** Whether a digest can cover `window`: it starts before it ends, and at most a week before. */
export function isDigestWindow({ since, until }: DigestWindow): boolean {
  const span = until.getTime() - since.getTime();
  return span > 0 && span <= MAX_DIGEST_DAYS * 86_400_000;
}

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

  /**
   * The digest of `window`, its times in `timeZone`, an IANA time zone such
   * as "America/Los_Angeles". A window no digest can cover, or a time zone
   * this runtime doesn't know, is refused before anything is read.
   */
  async write(window: DigestWindow, timeZone: string): Promise<string> {
    if (!isDigestWindow(window)) {
      throw new RangeError(`A digest covers at most ${MAX_DIGEST_DAYS} days, and ends after it starts.`);
    }
    if (!isTimeZone(timeZone)) throw new RangeError(`${timeZone} is not an IANA time zone, such as America/Los_Angeles.`);
    const activity = await this.collector.collect(window);
    const since = formatDateTime(window.since, timeZone);
    if (activity.chats.length === 0) return footnote(`No new messages since ${since}.`, gaps(activity));

    const briefing = renderBriefing(activity, timeZone);
    const summary = safeMarkdown(await this.model.write({ instructions: DIGEST_INSTRUCTIONS, input: briefing.text }));
    if (summary.trim() === '') throw new ModelError('The model answered with nothing that can be shown.');
    const coverage = `Covers ${chats(briefing.chats)} and ${count(briefing.messages, 'message')} since ${since}.`;
    return `${summary}\n\n${footnote(coverage, gaps(activity, briefing))}`;
  }
}

/**
 * What a digest couldn't cover, as counted: the reads that failed or
 * stopped short, and chats cut for length. A chat is counted once: one left
 * out for length isn't also one read in part.
 */
function gaps(
  { unreadable, truncatedEmpty, moreChats }: Activity,
  shown: Pick<Briefing, 'partial' | 'leftOut'> = { partial: 0, leftOut: 0 },
): string[] {
  const partial = truncatedEmpty + shown.partial;
  return [
    ...(unreadable > 0 ? [`${chats(unreadable)} couldn't be read`] : []),
    ...(partial > 0 ? [`${chats(partial)} had more messages than a digest reads`] : []),
    ...(shown.leftOut > 0 ? [`${chats(shown.leftOut)} left out for length`] : []),
    ...(moreChats ? ['more chats had activity than a digest reads'] : []),
  ];
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
