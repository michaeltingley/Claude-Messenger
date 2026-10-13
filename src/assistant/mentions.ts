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

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

function decodeEntity(entity: string, decimal?: string, hex?: string, name?: string): string {
  if (name !== undefined) return NAMED_ENTITIES.get(name.toLowerCase()) ?? entity;
  const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
}

/**
 * The words the user wrote themselves, from a message's text (HTML or
 * plain). A reply carries a copy of the message it answers (<mx-reply>);
 * a quote holds someone else's words (<blockquote>, a line starting with
 * ">", or "double quotes", as in a tapback's 'Liked “...”'); and a pill
 * links a person in the chat, who is never this app.
 */
function ownWords(text: string): string {
  let words = text.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, ' ');
  // Innermost first, so a nested quote can't end the one around it early.
  for (let before = ''; before !== words; ) {
    before = words;
    words = words.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/gi, ' ');
  }
  return (
    words
      // One that never closes quotes everything after it.
      .replace(/<(?:mx-reply|blockquote)\b[\s\S]*$/i, ' ')
      .replace(/<a\b[^>]*\bhref\s*=\s*["']https:\/\/matrix\.to\/#\/@[^>]*>[\s\S]*?<\/a>/gi, ' ')
      .replace(/<br\s*\/?>|<\/?p\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, decodeEntity)
      .replace(/^[ \t]*>.*$/gm, ' ')
      .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
  );
}

/**
 * Whether the user is addressing Claude: a message they wrote themselves
 * that names @claude in their own words. Nobody else's words set Claude to
 * work, whatever they say: not another person's message, nor one the user
 * quotes or replies to, nor a reaction to one. What it can't tell apart
 * still counts: a message the user forwards, or one an app sends as them.
 * It sees a message as it first arrives, so whatever acts on a mention
 * should read the message again first: a later edit or deletion is not seen.
 */
export function mentionsClaude(message: Message): boolean {
  return (
    message.isFromMe &&
    !message.isDeleted &&
    !message.isHidden &&
    WRITTEN.has(message.kind) &&
    message.text !== undefined &&
    MENTION.test(ownWords(message.text))
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
