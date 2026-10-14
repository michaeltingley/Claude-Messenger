import { describe, expect, it } from 'vitest';
import { PolicyDeniedError } from '../src/core/errors.js';
import type { Account, Chat } from '../src/core/types.js';
import { findConversation } from '../src/assistant/responder/conversation.js';
import { FakeMessenger, makeChat } from './fake-messenger.js';

const OWNER = '@owner:beeper.com';
const CLAUDE = '@claude:beeper.com';

const account = (id: string, network: string, userId: string): Account => ({ id, network, user: { id: userId, isSelf: true } });

/** A direct chat on the assistant's account with `userId`. */
const directChat = (id: string, userId: string, overrides: Partial<Chat> = {}): Chat =>
  makeChat({
    id,
    accountId: 'matrix',
    network: 'Beeper',
    title: userId,
    participants: [{ id: CLAUDE, isSelf: true }, { id: userId }],
    ...overrides,
  });

/** The owner's messenger and the assistant's, the assistant with a chat with the owner that both show. */
function setUp() {
  const owner = new FakeMessenger();
  owner.accounts = [account('matrix', 'Beeper', OWNER), account('whatsapp', 'WhatsApp', '+15550100')];
  owner.chats = [makeChat({ id: '!dm', accountId: 'matrix', participants: [{ id: OWNER, isSelf: true }, { id: CLAUDE }] })];
  const assistant = new FakeMessenger();
  assistant.accounts = [account('matrix', 'Beeper', CLAUDE)];
  assistant.chats = [
    directChat('!stranger', '@someone:beeper.com'),
    directChat('!group', OWNER, { type: 'group', participants: [{ id: CLAUDE, isSelf: true }, { id: OWNER }, { id: '@x:beeper.com' }] }),
    directChat('!dm', OWNER),
  ];
  return { owner, assistant };
}

describe('findConversation', () => {
  it("finds the assistant's direct chat with one of the owner's users, and the assistant's user", async () => {
    const { owner, assistant } = setUp();
    await expect(findConversation(owner, assistant)).resolves.toEqual({ chatId: '!dm', assistantUserId: CLAUDE });
  });

  it("looks through the assistant's chats page by page", async () => {
    const { owner, assistant } = setUp();
    assistant.pageSize = 1;
    await expect(findConversation(owner, assistant)).resolves.toEqual({ chatId: '!dm', assistantUserId: CLAUDE });
  });

  it('finds it by any of the owner\'s users, on another network too', async () => {
    const { owner, assistant } = setUp();
    assistant.chats = [directChat('!dm', '+15550100')];
    await expect(findConversation(owner, assistant)).resolves.toMatchObject({ chatId: '!dm' });
  });

  it('refuses an assistant signed in to more than one account, or as the owner', async () => {
    const { owner, assistant } = setUp();
    assistant.accounts = [account('matrix', 'Beeper', CLAUDE), account('signal', 'Signal', '+15550199')];
    await expect(findConversation(owner, assistant)).rejects.toThrow(/one account, its own, but shows 2/);
    assistant.accounts = [account('matrix', 'Beeper', OWNER)];
    await expect(findConversation(owner, assistant)).rejects.toThrow(/signs in as the owner/);
  });

  it('says how to open the chat when there is none, and refuses to pick one of several', async () => {
    const { owner, assistant } = setUp();
    assistant.chats = assistant.chats.filter((c) => c.id !== '!dm');
    await expect(findConversation(owner, assistant)).rejects.toThrow(/claude-messenger start-chat --with/);
    assistant.chats = [directChat('!dm', OWNER), directChat('!dm2', OWNER)];
    await expect(findConversation(owner, assistant)).rejects.toThrow(/2 direct chats with the owner \(!dm, !dm2\)/);
  });

  it("says the owner hasn't joined the chat when their Beeper doesn't show it, and passes on other failures", async () => {
    const { owner, assistant } = setUp();
    owner.chats = [];
    await expect(findConversation(owner, assistant)).rejects.toThrow(/accept the assistant's invite/);
    owner.getChat = async () => {
      throw new PolicyDeniedError('Chat !dm is denylisted.', 'read.chatDenylist');
    };
    await expect(findConversation(owner, assistant)).rejects.toThrow(PolicyDeniedError);
  });
});
