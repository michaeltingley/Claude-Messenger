import { describe, expect, it } from 'vitest';
import type { AccessGrant, AccessRequest, AccessRequester } from '../src/core/access.js';
import { AccessMismatchError } from '../src/core/errors.js';
import { GuardedAccessRequester } from '../src/policy/access.js';

/**
 * GuardedAccessRequester decides which credentials this app keeps, above any
 * provider: what the owner may have approved arrives from a fake provider,
 * and what matters is what reaches the caller and what gets revoked.
 */

const TOKEN = 'fake-token-3f9a';

/** A provider whose owner approves on the given terms. */
class FakeProvider implements AccessRequester {
  readonly revokeByHand = 'in the fake provider, under Connections';
  revocations = 0;
  revokeFails = false;

  constructor(private readonly approved: { write: boolean; expiresAt?: Date }) {}

  instructions(request: AccessRequest): readonly string[] {
    return [`Approve ${request.clientName} in the fake window.`];
  }

  async requestAccess(): Promise<AccessGrant> {
    return {
      token: TOKEN,
      ...this.approved,
      revoke: async () => {
        if (this.revokeFails) throw new Error('fake provider unreachable');
        this.revocations++;
      },
    };
  }
}

const ask = (write = false): AccessRequest => ({ clientName: 'Claude Messenger', write, timeoutMs: 1_000 });
const refusal = async (guard: AccessRequester, request: AccessRequest) => {
  const error = await guard.requestAccess(request).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AccessMismatchError);
  return (error as Error).message;
};

describe('GuardedAccessRequester', () => {
  describe('credentials it keeps', () => {
    it('hands back a read-only credential that never expires, as asked', async () => {
      const provider = new FakeProvider({ write: false });

      const grant = await new GuardedAccessRequester(provider).requestAccess(ask());

      expect(grant).toMatchObject({ token: TOKEN, write: false });
      expect(provider.revocations).toBe(0);
    });

    it('keeps write access that was asked for', async () => {
      const grant = await new GuardedAccessRequester(new FakeProvider({ write: true })).requestAccess(ask(true));

      expect(grant.write).toBe(true);
    });

    it('keeps a credential narrower than asked, and lets the caller say sending will not work', async () => {
      const provider = new FakeProvider({ write: false });

      const grant = await new GuardedAccessRequester(provider).requestAccess(ask(true));

      expect(grant.write).toBe(false);
      expect(provider.revocations).toBe(0);
    });
  });

  describe('credentials it refuses', () => {
    it('revokes write access nobody asked for, and says how to approve next time', async () => {
      const provider = new FakeProvider({ write: true });

      const message = await refusal(new GuardedAccessRequester(provider), ask());

      expect(provider.revocations).toBe(1);
      expect(message).toBe(
        'It was approved with write access, which was not asked for. It was revoked, and nothing was saved. ' +
          'Run this again, and approve it without write access.',
      );
    });

    it('revokes a credential with a lifetime, since nothing here renews it', async () => {
      const provider = new FakeProvider({ write: false, expiresAt: new Date('2026-11-12T00:00:00.000Z') });

      const message = await refusal(new GuardedAccessRequester(provider), ask());

      expect(provider.revocations).toBe(1);
      expect(message).toContain('It was approved to expire 2026-11-12T00:00:00.000Z, and nothing here renews it.');
      expect(message).toContain('approve it to never expire.');
    });

    it('names every term it refuses, and every fix, in one error', async () => {
      const provider = new FakeProvider({ write: true, expiresAt: new Date(Date.now() + 3_600_000) });

      const message = await refusal(new GuardedAccessRequester(provider), ask());

      expect(message).toMatch(/write access, which was not asked for\. It was approved to expire /);
      expect(message).toContain('approve it without write access and to never expire.');
      expect(provider.revocations).toBe(1);
    });

    it('says where to revoke it by hand when revoking fails', async () => {
      const provider = new FakeProvider({ write: true });
      provider.revokeFails = true;

      const message = await refusal(new GuardedAccessRequester(provider), ask());

      expect(message).toContain(
        'Nothing was saved, but it works until you revoke it in the fake provider, under Connections.',
      );
    });

    it('never puts the credential in its error', async () => {
      const provider = new FakeProvider({ write: true, expiresAt: new Date(Date.now() + 60_000) });
      provider.revokeFails = true;

      expect(await refusal(new GuardedAccessRequester(provider), ask())).not.toContain(TOKEN);
    });
  });

  it("passes the provider's own steps and revoke wording through", () => {
    const provider = new FakeProvider({ write: false });
    const guard = new GuardedAccessRequester(provider);

    expect(guard.instructions(ask())).toEqual(['Approve Claude Messenger in the fake window.']);
    expect(guard.revokeByHand).toBe(provider.revokeByHand);
  });
});
