import { NotFoundError } from '../../core/errors.js';
import type { Messenger } from '../../core/messenger.js';
import type { Chat } from '../../core/types.js';

/** Where the assistant answers the owner. */
export interface Conversation {
  /** The direct chat between the assistant's account and the owner's: one chat, the same ID on both. */
  chatId: string;
  /** The assistant's user ID, as the owner's messenger names the sender of the assistant's messages. */
  assistantUserId: string;
}

/** The most pages of the assistant's chats to look through for its chat with the owner. */
const MAX_CHAT_PAGES = 5;

/**
 * Finds the assistant's chat with the owner, from both sides: on the
 * assistant's one account, its direct chat with one of the owner's own
 * users, which the owner's messenger shows too. Each messenger reads as its
 * own policy lets it. Refuses, saying what to do, when the assistant's
 * messenger is signed in as the owner or to more than one account, when it
 * has no such chat or more than one, and when the owner's doesn't show it.
 */
export async function findConversation(owner: Messenger, assistant: Messenger): Promise<Conversation> {
  const accounts = await assistant.listAccounts();
  if (accounts.length !== 1) {
    throw new Error(`The assistant's Beeper should have one account, its own, but shows ${accounts.length}.`);
  }
  const account = accounts[0]!;
  const ownerUsers = new Set((await owner.listAccounts()).map((a) => a.user.id));
  if (ownerUsers.has(account.user.id)) {
    throw new Error(
      `The assistant's configuration signs in as the owner (${account.user.id}). It answers from an account of its own: ` +
        'see claude-messenger signup.',
    );
  }

  const chats = (await directChats(assistant, account.id)).filter((chat) =>
    chat.participants.some((p) => ownerUsers.has(p.id)),
  );
  if (chats.length === 0) {
    throw new Error(
      "The assistant has no direct chat with the owner yet. Open one, from the assistant's directory, with: " +
        "claude-messenger start-chat --with <the owner's Beeper user ID>",
    );
  }
  if (chats.length > 1) {
    throw new Error(
      `The assistant has ${chats.length} direct chats with the owner (${chats.map((c) => c.id).join(', ')}). ` +
        'Leave all but one, in Beeper, so it is clear where it answers.',
    );
  }
  const chat = chats[0]!;
  try {
    await owner.getChat(chat.id);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    throw new Error(`The owner's Beeper doesn't show the chat ${chat.id} yet: accept the assistant's invite to it in Beeper.`, {
      cause: err,
    });
  }
  return { chatId: chat.id, assistantUserId: account.user.id };
}

/** The assistant's direct chats on its account, as far as its first pages of chats go. */
async function directChats(assistant: Messenger, accountId: string): Promise<Chat[]> {
  const found: Chat[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHAT_PAGES; page++) {
    const { items, hasMore, nextCursor } = await assistant.searchChats(cursor === undefined ? {} : { cursor });
    found.push(...items.filter((chat) => chat.accountId === accountId && chat.type === 'single'));
    if (!hasMore || nextCursor === undefined) break;
    cursor = nextCursor;
  }
  return found;
}
