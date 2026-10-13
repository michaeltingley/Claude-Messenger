import { describe, expect, it } from 'vitest';
import { ModelError, ProviderError } from '../src/core/errors.js';
import type { LanguageModel, WriteRequest } from '../src/core/model.js';
import type { Message, MessageListQuery, Page } from '../src/core/types.js';
import { DigestWriter } from '../src/digest/digest.js';
import { DIGEST_INSTRUCTIONS } from '../src/digest/instructions.js';
import { MemoryAuditLogger } from '../src/policy/audit.js';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { parsePolicy, PolicyEngine } from '../src/policy/policy.js';
import { DEFAULT_ACTIVITY_LIMITS } from '../src/digest/activity.js';
import { FakeMessenger, makeChat, makeMessage } from './fake-messenger.js';

const since = new Date('2026-10-12T14:46:00Z');
const until = new Date('2026-10-13T14:46:00Z');
const window = { since, until };
const timeZone = 'America/Los_Angeles';

/** A language model that answers as told and remembers what it was asked. */
class FakeModel implements LanguageModel {
  requests: WriteRequest[] = [];
  constructor(private readonly answer: () => Promise<string> = async () => '**Needs you**\n- **Alice** asked about dinner.') {}
  write(request: WriteRequest): Promise<string> {
    this.requests.push(request);
    return this.answer();
  }
}

function messenger() {
  const fake = new FakeMessenger();
  fake.chats = [
    makeChat({ id: 'alice', title: 'Alice', lastActivity: '2026-10-13T04:00:00Z', unreadCount: 1 }),
    makeChat({ id: 'family', title: 'Family', type: 'group', lastActivity: '2026-10-13T05:00:00Z' }),
  ];
  fake.messages = [
    makeMessage({ id: 'a1', chatId: 'alice', timestamp: '2026-10-13T04:00:00Z', text: 'Dinner Friday at 7?' }),
    makeMessage({ id: 'f1', chatId: 'family', timestamp: '2026-10-13T03:00:00Z', senderName: 'Mom', text: 'Cabin is booked' }),
    makeMessage({ id: 'f2', chatId: 'family', timestamp: '2026-10-13T05:00:00Z', isFromMe: true, text: 'Great!' }),
  ];
  return fake;
}

describe('DigestWriter', () => {
  it("has the model write it from the fixed instructions and a briefing of the window, and says what it covers", async () => {
    const model = new FakeModel();
    const digest = await new DigestWriter(messenger(), model).write(window, { timeZone });
    expect(model.requests).toHaveLength(1);
    const [request] = model.requests;
    expect(request!.instructions).toBe(DIGEST_INSTRUCTIONS);
    expect(request!.input).toContain('## Alice');
    expect(request!.input).toContain('Alice: Dinner Friday at 7?');
    expect(request!.input).toContain('Mom: Cabin is booked');
    expect(digest).toEqual({
      text:
        '**Needs you**\n- **Alice** asked about dinner.\n\n' +
        '_Covers 2 chats and 3 messages since Mon, Oct 12, 7:46 AM._',
      chats: 2,
      messages: 3,
    });
  });

  it('keeps message content out of the instructions: it travels only as the input', async () => {
    const model = new FakeModel();
    await new DigestWriter(messenger(), model).write(window, { timeZone });
    expect(model.requests[0]!.instructions).not.toContain('Dinner');
  });

  it('says there was nothing new, without asking the model, when no chat had messages', async () => {
    const model = new FakeModel();
    const quiet = new FakeMessenger();
    quiet.chats = [makeChat({ lastActivity: '2026-10-10T00:00:00Z' })];
    const digest = await new DigestWriter(quiet, model).write(window, { timeZone });
    expect(model.requests).toHaveLength(0);
    expect(digest).toEqual({ text: '_No new messages since Mon, Oct 12, 7:46 AM._', chats: 0, messages: 0 });
  });

  it("says, under the model's words, which gaps it has: chats it couldn't read, and more chats than it reads", async () => {
    class Failing extends FakeMessenger {
      override listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
        return chatId === 'broken' ? Promise.reject(new ProviderError('bridge down')) : super.listMessages(chatId, query);
      }
    }
    const fake = new Failing();
    const base = messenger();
    fake.chats = [...base.chats, makeChat({ id: 'broken', title: 'Broken', lastActivity: '2026-10-13T06:00:00Z' })];
    fake.messages = base.messages;
    const digest = await new DigestWriter(fake, new FakeModel(), { ...DEFAULT_ACTIVITY_LIMITS, chats: 3 }).write(window, {
      timeZone,
    });
    expect(digest.text.split('\n').at(-1)).toBe(
      "_Covers 2 chats and 3 messages since Mon, Oct 12, 7:46 AM. 1 chat couldn't be read._",
    );

    const crowded = messenger();
    crowded.chats.push(makeChat({ id: 'more', lastActivity: '2026-10-13T06:00:00Z' }));
    const capped = await new DigestWriter(crowded, new FakeModel(), { ...DEFAULT_ACTIVITY_LIMITS, chats: 2 }).write(window, {
      timeZone,
    });
    expect(capped.text.split('\n').at(-1)).toMatch(/\. More chats had activity than a digest reads\._$/);
  });

  it('fails when the model gives no answer, rather than writing a digest without it', async () => {
    const model = new FakeModel(() => Promise.reject(new ModelError('Claude Code failed (exit 1): usage limit reached')));
    await expect(new DigestWriter(messenger(), model).write(window, { timeZone })).rejects.toThrow('usage limit reached');
  });

  it("reads only what the policy lets it: a denylisted chat never reaches the model, and the audit log holds no message's words", async () => {
    const fake = messenger();
    fake.chats.push(makeChat({ id: 'secret', title: 'Secret', lastActivity: '2026-10-13T06:00:00Z' }));
    fake.messages.push(makeMessage({ id: 's1', chatId: 'secret', timestamp: '2026-10-13T06:00:00Z', text: 'the vault code' }));
    const audit = new MemoryAuditLogger();
    const policy = parsePolicy({ version: 1, read: { chatDenylist: ['secret'] } });
    const guarded = new GuardedMessenger(fake, new PolicyEngine(policy), audit);
    const model = new FakeModel();

    const digest = await new DigestWriter(guarded, model).write(window, { timeZone });

    expect(model.requests[0]!.input).not.toContain('Secret');
    expect(model.requests[0]!.input).not.toContain('vault');
    expect(digest.chats).toBe(2);
    const recorded = JSON.stringify(audit.entries);
    expect(audit.entries.map((e) => e.action)).toEqual(['searchChats', 'listMessages', 'listMessages']);
    for (const words of ['Dinner', 'Cabin', 'Great', 'vault']) expect(recorded).not.toContain(words);
  });
});
