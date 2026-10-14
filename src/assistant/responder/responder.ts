import { ModelError, NotFoundError, PolicyDeniedError, ProviderError } from '../../core/errors.js';
import type { LanguageModel } from '../../core/model.js';
import type { Messenger } from '../../core/messenger.js';
import type { Message } from '../../core/types.js';
import { errorCode } from '../../policy/audit.js';
import { mentionsClaude, writtenByUser } from '../mentions.js';
import { quoted, shows } from '../text/lines.js';
import { safeMarkdown } from '../text/safe-markdown.js';
import { clockAt, isTimeZone } from '../text/time.js';
import type { CheckpointStore, HandledRequest } from './checkpoint.js';
import type { Conversation } from './conversation.js';
import { ANSWER_INSTRUCTIONS } from './instructions.js';
import { renderRequest, type Request } from './request.js';

/**
 * Whether a message asks the assistant something: one the owner wrote that
 * mentions @Claude, in any chat, or any the owner writes in the assistant's
 * chat with them, with words of their own in it.
 */
export function isRequest(message: Message, conversation: Conversation): boolean {
  if (mentionsClaude(message)) return true;
  return message.chatId === conversation.chatId && writtenByUser(message) && message.ownText.trim() !== '';
}

export interface ResponderOptions {
  /** The IANA time zone the owner reads times in, such as "America/Los_Angeles". */
  timeZone: string;
  /** The longest message the assistant may send, as its policy says (`send.maxCharsPerMessage`). */
  maxMessageChars: number;
  /** Told each thing the responder does, by IDs and error codes: never what anyone wrote. */
  journal: (line: string) => void;
  now?: () => Date;
}

/** How many of a chat's messages from before a request the model reads with it. */
const EARLIER_MESSAGES = 30;
/** The most pages of a chat read for them. */
const EARLIER_PAGES = 3;
/** The shortest message an answer can be sent in. */
const MIN_MESSAGE_CHARS = 500;
/** Ends an answer too long for one message: plain dots, which the filter leaves as they are. */
const CUT_MARK = '... (cut short)';

/**
 * How far before the latest of the owner's messages a restart resumes: more
 * than any provider waits for a message that reaches it late (Beeper's
 * poller: 10 minutes), so a restart sees every request the running watch
 * would have.
 */
const RESUME_MARGIN_MS = 15 * 60_000;
/** How far back a restart catches up at most. A request older than that when it comes back goes unanswered. */
const MAX_CATCH_UP_MS = 6 * 3_600_000;

/**
 * Answers the owner from the assistant's own account: each @Claude in the
 * messages the owner sends, in any chat, and each message the owner writes
 * in the assistant's chat with them. Every answer goes to that chat, so
 * nothing reaches anyone but the owner, and nothing is ever sent as them.
 *
 * It reads through the owner's messenger and sends through the
 * assistant's, each a `GuardedMessenger` under its own account's policy,
 * which audits it. It reads each request again first, since it may have
 * been edited or deleted, and skips one that no longer asks anything; then
 * reads the messages before it in its chat, has the model answer from them,
 * and sends the answer made safe to show (`safeMarkdown`), with a line
 * saying where the request was when it wasn't in the assistant's chat. When
 * it can't answer, it says so instead, in words of its own.
 *
 * Each request is handled at most once, across restarts too: it is recorded
 * as handled before its answer is sent, so a restart between the two loses
 * the answer rather than send it twice. A stop before that leaves the
 * request for the next run.
 */
export class Responder {
  private readonly timeZone: string;
  private readonly maxMessageChars: number;
  private readonly journal: (line: string) => void;
  private readonly now: () => Date;

  constructor(
    private readonly owner: Messenger,
    private readonly assistant: Messenger,
    private readonly conversation: Conversation,
    private readonly model: LanguageModel,
    private readonly checkpoints: CheckpointStore,
    { timeZone, maxMessageChars, journal, now = () => new Date() }: ResponderOptions,
  ) {
    if (!isTimeZone(timeZone)) throw new RangeError(`${timeZone} is not an IANA time zone, such as America/Los_Angeles.`);
    if (!(maxMessageChars >= MIN_MESSAGE_CHARS)) {
      throw new RangeError(
        `An answer needs messages of up to ${MIN_MESSAGE_CHARS} characters at least, ` +
          `but the assistant's policy allows ${maxMessageChars} (send.maxCharsPerMessage).`,
      );
    }
    this.timeZone = timeZone;
    this.maxMessageChars = maxMessageChars;
    this.journal = journal;
    this.now = now;
  }

  /**
   * Answers requests as the owner makes them, first catching up on those
   * made since the last run stopped, until `signal` aborts. A failure that
   * is about one request is told to the journal, and the owner, and the
   * responder goes on; any other ends the run with it.
   */
  async run(signal: AbortSignal): Promise<void> {
    const progress = await Progress.resume(this.checkpoints, this.now());
    this.journal(`Answering in ${this.conversation.chatId} as ${this.conversation.assistantUserId}, from ${progress.since}.`);
    for await (const message of this.owner.watchMessages({ sender: 'me', since: progress.since }, signal)) {
      if (isRequest(message, this.conversation)) await this.handle(message, progress, signal);
      // A request a stop cut short is left for the next run.
      if (signal.aborted) break;
      await progress.pass(message, this.now());
    }
  }

  private async handle(delivered: Message, progress: Progress, signal: AbortSignal): Promise<void> {
    const where = `${delivered.chatId} ${delivered.id}`;
    if (progress.has(delivered)) return this.journal(`${where}: skipped, already handled`);
    let text: string;
    let failure: unknown;
    try {
      const request = await this.read(delivered);
      if (request === undefined) return this.journal(`${where}: skipped, withdrawn`);
      text = await this.answer(request);
    } catch (err) {
      if (!concernsOneRequest(err)) throw err;
      failure = err;
      text = this.notice(delivered);
    }
    if (signal.aborted) return;
    await progress.handle(delivered);
    let unsent: unknown;
    try {
      await this.assistant.sendMessage({ chatId: this.conversation.chatId, text });
    } catch (err) {
      if (!concernsOneRequest(err)) throw err;
      unsent = err;
    }
    if (failure === undefined) {
      this.journal(`${where}: ` + (unsent === undefined ? 'answered' : `answered, but sending failed (${kindOf(unsent)})`));
    } else {
      this.journal(
        `${where}: not answered (${kindOf(failure)}); ` +
          (unsent === undefined ? 'told the owner' : `telling the owner failed (${kindOf(unsent)})`),
      );
    }
  }

  /** The request as it stands, with its chat and what came before it; undefined when it no longer asks anything. */
  private async read(delivered: Message): Promise<Request | undefined> {
    let message: Message;
    try {
      message = await this.owner.getMessage(delivered.chatId, delivered.id);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
    if (!isRequest(message, this.conversation)) return undefined;
    const chat = await this.owner.getChat(message.chatId);
    return { message, chat, earlier: await this.earlier(message) };
  }

  /** The newest messages that show in the request's chat from before it, oldest first. */
  private async earlier(request: Message): Promise<Message[]> {
    const before = Date.parse(request.timestamp);
    const found: Message[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < EARLIER_PAGES && found.length < EARLIER_MESSAGES; page++) {
      const { items, hasMore, nextCursor } = await this.owner.listMessages(
        request.chatId,
        cursor === undefined ? undefined : { cursor },
      );
      // Newest first, as the port promises.
      for (const message of items) {
        if (found.length === EARLIER_MESSAGES) break;
        if (message.id === request.id || !(Date.parse(message.timestamp) <= before) || !shows(message)) continue;
        found.push(message);
      }
      if (!hasMore || nextCursor === undefined) break;
      cursor = nextCursor;
    }
    return found.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  private async answer(request: Request): Promise<string> {
    const input = renderRequest(request, this.conversation, this.now(), this.timeZone);
    const answer = await this.model.write({ instructions: ANSWER_INSTRUCTIONS, input });
    const header = request.chat.id === this.conversation.chatId ? undefined : this.header(request);
    const shown = fit(answer, this.maxMessageChars - (header === undefined ? 0 : header.length + 2));
    if (shown.trim() === '') throw new ModelError('The model answered with nothing that can be shown.');
    return header === undefined ? shown : `${header}\n\n${shown}`;
  }

  /** Which request an answer is to, when it wasn't made in the assistant's chat: its chat and its time. */
  private header({ message, chat }: Request): string {
    return safeMarkdown(`In ${quoted(chat.title) ?? 'a chat with no name'}, ${this.timeOf(message)}:`);
  }

  /** What the owner is told of a request that couldn't be answered: fixed words, and its time. */
  private notice(request: Message): string {
    return `Sorry, I couldn't answer your message from ${this.timeOf(request)}. Please ask me again later.`;
  }

  private timeOf(message: Message): string {
    return clockAt(this.now(), this.timeZone)(new Date(message.timestamp));
  }
}

/**
 * Failures that are about one request (its chat is gone, the provider failed
 * on it, a policy refused it, the model gave no answer), so the responder
 * goes on to the next. Anything else (a lost connection, a rejected token,
 * an audit log or a checkpoint that can't be written) ends the run.
 */
function concernsOneRequest(err: unknown): boolean {
  return (
    err instanceof NotFoundError ||
    err instanceof ProviderError ||
    err instanceof PolicyDeniedError ||
    err instanceof ModelError
  );
}

/** A failure as the journal gives it: its kind, and a denial's rule, never its text. */
function kindOf(err: unknown): string {
  return err instanceof PolicyDeniedError ? `${err.code} by ${err.rule}` : errorCode(err);
}

/**
 * `answer`, made safe to show, in at most `room` characters. One too long
 * is cut before it is made safe, never after, so that the filter sees
 * exactly what is shown, and cut further while what the filter makes of it
 * is still too long.
 */
function fit(answer: string, room: number): string {
  for (let budget = room; ; ) {
    const shown = safeMarkdown(cut(answer, budget));
    if (shown.length <= room) return shown;
    budget -= shown.length - room;
  }
}

/**
 * `text` in at most `max` characters, ending in `CUT_MARK` when it is cut:
 * at the last space or line break, when there is one in the second half of
 * what fits, or else where it stops fitting, never through a character.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const fits = Math.max(0, max - CUT_MARK.length);
  const space = text.slice(0, fits + 1).search(/\s\S*$/);
  let end = space >= fits / 2 ? space : fits;
  if (/[\ud800-\udbff]/.test(text[end - 1] ?? '')) end--;
  return `${text.slice(0, end).trimEnd()}${CUT_MARK}`;
}

/**
 * Where the responder has got, kept in the checkpoint after every step:
 * the time a restart resumes from, and the requests after it already
 * handled.
 */
class Progress {
  private constructor(
    private readonly store: CheckpointStore,
    private sinceMs: number,
    private readonly handled: Map<string, HandledRequest>,
  ) {}

  /**
   * Where the last run got to, but no further back than a restart catches
   * up, nor later than now; on the first run, now. Saved at once, so that a
   * first run's start holds.
   */
  static async resume(store: CheckpointStore, now: Date): Promise<Progress> {
    const saved = await store.load();
    const sinceMs =
      saved === undefined
        ? now.getTime()
        : Math.min(Math.max(Date.parse(saved.since), now.getTime() - MAX_CATCH_UP_MS), now.getTime());
    const handled = new Map((saved?.handled ?? []).map((h) => [key(h.chatId, h.messageId), h]));
    const progress = new Progress(store, sinceMs, handled);
    await progress.save();
    return progress;
  }

  get since(): string {
    return new Date(this.sinceMs).toISOString();
  }

  has(message: Message): boolean {
    return this.handled.has(key(message.chatId, message.id));
  }

  /** Records a request as handled, before anything is sent for it. */
  async handle(message: Message): Promise<void> {
    this.handled.set(key(message.chatId, message.id), {
      chatId: message.chatId,
      messageId: message.id,
      timestamp: message.timestamp,
    });
    await this.save();
  }

  /**
   * Moves past a message the responder is done with: a restart resumes a
   * margin before the latest one's time, or before now, for one dated in
   * the future.
   */
  async pass(message: Message, now: Date): Promise<void> {
    const resumeAt = Math.min(Date.parse(message.timestamp), now.getTime()) - RESUME_MARGIN_MS;
    if (!(resumeAt > this.sinceMs)) return;
    this.sinceMs = resumeAt;
    await this.save();
  }

  /** Saves where it has got, keeping only the requests a restart could deliver again. */
  private async save(): Promise<void> {
    for (const [k, request] of this.handled) {
      if (!(Date.parse(request.timestamp) > this.sinceMs)) this.handled.delete(k);
    }
    await this.store.save({ since: this.since, handled: [...this.handled.values()] });
  }
}

/** Message IDs are unique within a chat, which is all every provider promises. */
function key(chatId: string, messageId: string): string {
  return `${chatId}\u0000${messageId}`;
}
