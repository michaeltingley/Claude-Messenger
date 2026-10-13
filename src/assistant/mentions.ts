import type { Messenger } from '../core/messenger.js';
import type { Message, MessageKind } from '../core/types.js';

/**
 * "@claude" as its own word, in any case, with the full-width ＠ that CJK
 * keyboards type too: not inside an address (bob@claude.ai), a longer
 * handle (@claudette, @claude_bot, @claude-code, @claude2), a domain
 * (@claude.ai) or a path (x.com/@claude). Punctuation and text in other
 * scripts around it still count: "@Claude, ...", "@Claude's", "(@claude)",
 * "请@Claude帮我".
 */
const MENTION = /(?<![A-Za-z0-9_@/])[@＠]claude(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/i;

/** Kinds a person writes, captions included. A message whose provider gives no kind counts too. */
const WRITTEN = new Set<MessageKind | undefined>([undefined, 'text', 'image', 'video', 'file', 'audio', 'voice']);

/**
 * Whether the user is addressing Claude: a message they wrote that names
 * @claude in what they wrote themselves (`ownText`, which leaves out what
 * they quote or reply to). Nobody else's words set Claude to work: not
 * another person's message, nor a quote of one, nor a reaction to one. A
 * message whose provider can't tell the user's own words never counts.
 * What the text can't tell apart still counts: a message the user
 * forwards, or one an app sends as them. It sees a message as it first
 * arrives, so whatever acts on a mention should read the message again
 * first: a later edit or deletion is not seen.
 */
export function mentionsClaude(message: Message): boolean {
  return (
    message.isFromMe &&
    !message.isDeleted &&
    !message.isHidden &&
    WRITTEN.has(message.kind) &&
    message.ownText !== undefined &&
    MENTION.test(message.ownText)
  );
}

/**
 * The user's messages that mention Claude, as they arrive after `since`
 * (ISO 8601, exclusive). The watch asks only for the user's own messages, so
 * nobody else's are ever read for it. Ends when `signal` aborts.
 */
export async function* watchMentions(
  messenger: Messenger,
  since: string,
  signal: AbortSignal,
): AsyncGenerator<Message, void, undefined> {
  for await (const message of messenger.watchMessages({ sender: 'me', since }, signal)) {
    if (mentionsClaude(message)) yield message;
  }
}
