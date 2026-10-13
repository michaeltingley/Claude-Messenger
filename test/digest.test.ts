import { describe, expect, it } from 'vitest';
import { ModelError, ProviderError } from '../src/core/errors.js';
import type { LanguageModel, WriteRequest } from '../src/core/model.js';
import type { Message, MessageListQuery, Page } from '../src/core/types.js';
import { ActivityCollector, DEFAULT_ACTIVITY_LIMITS, type ActivityLimits } from '../src/assistant/digest/activity.js';
import { DigestWriter } from '../src/assistant/digest/digest.js';
import { DIGEST_INSTRUCTIONS } from '../src/assistant/digest/instructions.js';
import { MemoryAuditLogger } from '../src/policy/audit.js';
import { GuardedMessenger } from '../src/policy/guarded.js';
import { parsePolicy, PolicyEngine } from '../src/policy/policy.js';
import { FakeMessenger, makeChat, makeMessage } from './fake-messenger.js';
import type { Messenger } from '../src/core/messenger.js';

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

/** A messenger whose chat `broken` can't be read. */
class Failing extends FakeMessenger {
  override listMessages(chatId: string, query?: MessageListQuery): Promise<Page<Message>> {
    return chatId === 'broken' ? Promise.reject(new ProviderError('bridge down')) : super.listMessages(chatId, query);
  }
}

const writer = (source: Messenger, model: LanguageModel, limits: Partial<ActivityLimits> = {}) =>
  new DigestWriter(new ActivityCollector(source, { ...DEFAULT_ACTIVITY_LIMITS, ...limits }), model);

const footer = (digest: string) => digest.split('\n').at(-1);

describe('DigestWriter', () => {
  it('has the model write it from the fixed instructions and a briefing of the window, and says what it covers', async () => {
    const model = new FakeModel();
    const digest = await writer(messenger(), model).write(window, timeZone);
    expect(model.requests).toHaveLength(1);
    const [request] = model.requests;
    expect(request!.instructions).toBe(DIGEST_INSTRUCTIONS);
    expect(request!.input).toContain('## "Alice"');
    expect(request!.input).toContain('"Alice": Dinner Friday at 7?');
    expect(request!.input).toContain('"Mom": Cabin is booked');
    expect(digest).toBe(
      '**Needs you**\n- **Alice** asked about dinner.\n\n_Covers 2 chats and 3 messages since Mon, Oct 12, 7:46 AM._',
    );
  });

  it('says there was nothing new, without asking the model, when no chat had messages', async () => {
    const model = new FakeModel();
    const quiet = new FakeMessenger();
    quiet.chats = [makeChat({ lastActivity: '2026-10-10T00:00:00Z' })];
    expect(await writer(quiet, model).write(window, timeZone)).toBe('_No new messages since Mon, Oct 12, 7:46 AM._');
    expect(model.requests).toHaveLength(0);
  });

  it("doesn't claim there was nothing new when a chat with activity couldn't be read", async () => {
    const fake = new Failing();
    fake.chats = [
      makeChat({ id: 'broken', lastActivity: '2026-10-13T06:00:00Z' }),
      makeChat({ id: 'quiet', lastActivity: '2026-10-13T05:00:00Z' }),
    ];
    // The quiet chat's only message in the window is one that doesn't show.
    fake.messages = [makeMessage({ chatId: 'quiet', timestamp: '2026-10-13T05:00:00Z', isHidden: true })];
    const model = new FakeModel();
    expect(await writer(fake, model).write(window, timeZone)).toBe(
      "_No new messages since Mon, Oct 12, 7:46 AM. 1 chat couldn't be read._",
    );
    expect(model.requests).toHaveLength(0);
  });

  it("says, under the model's words, every gap it has: chats it couldn't read, chats it read only in part, and more chats than it reads", async () => {
    const fake = new Failing();
    const base = messenger();
    fake.chats = [
      ...base.chats,
      makeChat({ id: 'broken', title: 'Broken', lastActivity: '2026-10-13T06:00:00Z' }),
      makeChat({ id: 'unseen', title: 'Unseen', lastActivity: '2026-10-13T02:00:00Z' }),
    ];
    fake.messages = base.messages;
    // Family has two messages in the window; the digest reads one per chat.
    const digest = await writer(fake, new FakeModel(), { chats: 3, messagesPerChat: 1 }).write(window, timeZone);
    expect(footer(digest)).toBe(
      '_Covers 2 chats and 2 messages since Mon, Oct 12, 7:46 AM. ' +
        "1 chat couldn't be read; 1 chat had more messages than a digest reads; more chats had activity than a digest reads._",
    );
  });

  it('counts only what the model was given, and says how many chats were left out for length', async () => {
    const fake = new FakeMessenger();
    for (let c = 0; c < 10; c++) {
      fake.chats.push(makeChat({ id: `c${c}`, title: `Chat ${c}`, lastActivity: '2026-10-13T06:00:00Z' }));
      for (let m = 0; m < 40; m++) {
        fake.messages.push(
          makeMessage({
            id: `c${c}-${m}`,
            chatId: `c${c}`,
            timestamp: `2026-10-13T0${c}:${String(m).padStart(2, '0')}:00Z`,
            text: 'z'.repeat(1_000),
          }),
        );
      }
    }
    const model = new FakeModel();
    const digest = await writer(fake, model).write(window, timeZone);
    const given = model.requests[0]!.input.split('\n').filter((line) => line.startsWith('## ')).length;
    expect(given).toBeGreaterThan(0);
    expect(given).toBeLessThan(10);
    expect(footer(digest)).toBe(
      `_Covers ${given} chats and ${given * 40} messages since Mon, Oct 12, 7:46 AM. ${10 - given} chats left out for length._`,
    );
  });

  it('counts each chat once among the gaps: one read in part, then left out for length, is only left out', async () => {
    const fake = new FakeMessenger();
    for (let c = 0; c < 10; c++) {
      fake.chats.push(makeChat({ id: `c${c}`, title: `Chat ${c}`, lastActivity: '2026-10-13T06:00:00Z' }));
      // One more message in the window than a digest reads of a chat.
      for (let m = 0; m < 41; m++) {
        fake.messages.push(
          makeMessage({
            id: `c${c}-${m}`,
            chatId: `c${c}`,
            timestamp: `2026-10-13T0${c}:${String(m).padStart(2, '0')}:00Z`,
            text: 'z'.repeat(1_000),
          }),
        );
      }
    }
    const model = new FakeModel();
    const digest = await writer(fake, model).write(window, timeZone);
    const given = model.requests[0]!.input.split('\n').filter((line) => line.startsWith('## ')).length;
    expect(given).toBeGreaterThan(1);
    expect(given).toBeLessThan(9);
    expect(footer(digest)).toBe(
      `_Covers ${given} chats and ${given * 40} messages since Mon, Oct 12, 7:46 AM. ` +
        `${given} chats had more messages than a digest reads; ${10 - given} chats left out for length._`,
    );
  });

  it('says a chat had more than it reads when what it read of it held nothing that shows, though nothing else was new', async () => {
    const fake = new FakeMessenger();
    fake.pageSize = 2;
    fake.chats = [makeChat({ id: 'busy', lastActivity: '2026-10-13T06:00:00Z' })];
    // More hidden messages in the window than the pages a digest reads of a chat hold.
    fake.messages = Array.from({ length: 6 }, (_, n) =>
      makeMessage({ id: `h${n}`, chatId: 'busy', timestamp: `2026-10-13T06:0${n}:00Z`, isHidden: true }),
    );
    const model = new FakeModel();
    expect(await writer(fake, model, { pagesPerChat: 2 }).write(window, timeZone)).toBe(
      '_No new messages since Mon, Oct 12, 7:46 AM. 1 chat had more messages than a digest reads._',
    );
    expect(model.requests).toHaveLength(0);
  });

  it("shows the owner the model's words with no link, address or number in them, so none reaches them looking vouched for", async () => {
    const model = new FakeModel(async () =>
      '- **Bank** says to [verify your account](https://evil.example/login), write to help@evil.example or call 415-555-0199.',
    );
    const digest = await writer(messenger(), model).write(window, timeZone);
    expect(digest.split('\n')[0]).toBe('- **Bank** says to verify your account, write to (email address) or call (number).');
  });

  it('fails when nothing of the answer can be shown, rather than writing a digest without it', async () => {
    const model = new FakeModel(async () => '\u200b\u202e\u0007');
    await expect(writer(messenger(), model).write(window, timeZone)).rejects.toThrow(ModelError);
  });

  it('refuses a window no digest covers, or a time zone it does not know, before reading anything', async () => {
    const unread = new (class extends FakeMessenger {
      override searchChats(): never {
        throw new Error('read');
      }
    })();
    const model = new FakeModel();
    const week = 7 * 86_400_000;
    for (const [w, zone] of [
      [{ since: until, until }, timeZone],
      [{ since: new Date(until.getTime() + 1), until }, timeZone],
      [{ since: new Date(until.getTime() - week - 1), until }, timeZone],
      [window, 'Mars/Olympus_Mons'],
    ] as const) {
      await expect(writer(unread, model).write(w, zone)).rejects.toThrow(RangeError);
    }
    await expect(writer(unread, model).write({ since: new Date(until.getTime() - week), until }, timeZone)).rejects.toThrow('read');
    expect(model.requests).toHaveLength(0);
  });

  it('fails when the model gives no answer, rather than writing a digest without it', async () => {
    const model = new FakeModel(() => Promise.reject(new ModelError('Claude Code failed (exit 1): usage limit reached')));
    await expect(writer(messenger(), model).write(window, timeZone)).rejects.toThrow('usage limit reached');
  });

  it('fails when no chat at all could be read, rather than writing a digest of nothing', async () => {
    const fake = new Failing();
    fake.chats = [makeChat({ id: 'broken', lastActivity: '2026-10-13T06:00:00Z' })];
    const model = new FakeModel();
    await expect(writer(fake, model).write(window, timeZone)).rejects.toThrow('bridge down');
    expect(model.requests).toHaveLength(0);
  });

  it("reads only what the policy lets it: a denylisted chat is never read, and the audit log holds no message's words", async () => {
    const fake = messenger();
    fake.chats.push(makeChat({ id: 'secret', title: 'Secret', lastActivity: '2026-10-13T06:00:00Z' }));
    fake.messages.push(makeMessage({ id: 's1', chatId: 'secret', timestamp: '2026-10-13T06:00:00Z', text: 'the vault code' }));
    const audit = new MemoryAuditLogger();
    const policy = parsePolicy({ version: 1, read: { chatDenylist: ['secret'] } });
    const model = new FakeModel();

    const digest = await writer(new GuardedMessenger(fake, new PolicyEngine(policy), audit), model).write(window, timeZone);

    expect(model.requests[0]!.input).not.toContain('Secret');
    expect(model.requests[0]!.input).not.toContain('vault');
    expect(footer(digest)).toBe('_Covers 2 chats and 3 messages since Mon, Oct 12, 7:46 AM._');
    const read = audit.entries.filter((e) => e.action === 'listMessages').map((e) => e.context?.chatId);
    expect(read.sort()).toEqual(['alice', 'family']);
    const recorded = JSON.stringify(audit.entries);
    for (const words of ['Dinner', 'Cabin', 'Great', 'vault']) expect(recorded).not.toContain(words);
  });
});
