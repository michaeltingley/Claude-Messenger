import type { Messenger } from '../core/messenger.js';
import type { LanguageModel } from '../core/model.js';
import { ActivityCollector, type ActivityLimits, type DigestWindow } from './activity.js';
import { renderBriefing } from './briefing.js';
import { DIGEST_INSTRUCTIONS } from './instructions.js';
import { formatDateTime } from './time.js';

export interface DigestOptions {
  /** The IANA time zone the owner reads times in, such as "America/Los_Angeles". */
  timeZone: string;
}

export interface Digest {
  /** The digest in Markdown, ready to show the owner. */
  text: string;
  /** Chats it was written from. */
  chats: number;
  /** Messages it was written from. */
  messages: number;
}

/**
 * Writes the owner's digest of a window: what needs them first, then the
 * rest. The language model writes the summary; what the digest covers, and
 * what it couldn't, is stated beneath it as counted, never as the model
 * puts it.
 */
export class DigestWriter {
  private readonly collector: ActivityCollector;

  constructor(
    messenger: Messenger,
    private readonly model: LanguageModel,
    limits?: ActivityLimits,
  ) {
    this.collector = new ActivityCollector(messenger, limits);
  }

  async write(window: DigestWindow, { timeZone }: DigestOptions): Promise<Digest> {
    const activity = await this.collector.collect(window);
    const since = formatDateTime(window.since, timeZone);
    const gaps: string[] = [];
    if (activity.unreadable.length > 0) gaps.push(`${chats(activity.unreadable.length)} couldn't be read`);
    if (activity.moreChats) gaps.push('more chats had activity than a digest reads');
    if (activity.chats.length === 0) {
      return { text: footnote(`No new messages since ${since}.`, gaps), chats: 0, messages: 0 };
    }

    const briefing = renderBriefing(activity, { timeZone });
    const summary = await this.model.write({ instructions: DIGEST_INSTRUCTIONS, input: briefing.text });
    if (briefing.leftOut > 0) gaps.unshift(`${chats(briefing.leftOut)} left out for length`);
    const coverage = `Covers ${chats(briefing.chats)} and ${count(briefing.messages, 'message')} since ${since}.`;
    return { text: `${summary}\n\n${footnote(coverage, gaps)}`, chats: briefing.chats, messages: briefing.messages };
  }
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
