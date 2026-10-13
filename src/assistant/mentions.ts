import type { Messenger } from '../core/messenger.js';
import type { Message } from '../core/types.js';

/**
 * "@claude" as its own word, in any case: not inside an address
 * (bob@claude.ai), a longer handle (@claudette, @claude_bot, @claude-code),
 * a domain (@claude.ai) or a path (x.com/@claude). Punctuation after it
 * still counts: "@Claude, ...", "@Claude's", "(@claude)".
 */
const MENTION = /(?<![\p{L}\p{N}_@/])@claude(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])/iu;

/**
 * Whether the user is addressing Claude: a message they sent themselves that
 * names @claude. Nobody else's message triggers Claude, whatever it says,
 * so text written by other people can't set it to work.
 */
export function mentionsClaude(message: Message): boolean {
  return message.isFromMe && !message.isDeleted && message.text !== undefined && MENTION.test(message.text);
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
