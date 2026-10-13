import type { AccessGrant, AccessRequest, AccessRequester } from '../core/access.js';
import { AccessMismatchError } from '../core/errors.js';

/**
 * The only AccessRequester `connect` is ever handed.
 *
 * Invariant this class owns: it resolves only with a credential this app can
 * keep. A provider's approval prompt can let the owner grant other terms than
 * were asked, and two make a credential one this app won't keep:
 * - write access nobody asked for. Read-only is the second lock behind the
 *   policy, so nothing may widen it silently.
 * - a lifetime. Nothing here renews a credential, so it would stop working
 *   with nobody watching.
 * Such a credential is revoked before the error is thrown, so it can't keep
 * working either. If revoking fails, the error says how to do it by hand.
 */
export class GuardedAccessRequester implements AccessRequester {
  constructor(private readonly inner: AccessRequester) {}

  get revokeByHand(): string {
    return this.inner.revokeByHand;
  }

  instructions(request: AccessRequest): readonly string[] {
    return this.inner.instructions(request);
  }

  async requestAccess(request: AccessRequest): Promise<AccessGrant> {
    const grant = await this.inner.requestAccess(request);
    const terms = unkeepableTerms(request, grant);
    if (terms.length === 0) return grant;

    const revoked = await grant.revoke().then(
      () => true,
      () => false,
    );
    throw new AccessMismatchError(
      `${terms.map((term) => describe(term, grant)).join(' ')} ` +
        (revoked
          ? 'It was revoked, and nothing was saved. '
          : `Nothing was saved, but it works until you revoke it ${this.inner.revokeByHand}. `) +
        `Run this again, and approve it ${terms.map(remedy).join(' and ')}.`,
    );
  }
}

/** A term of a granted credential that this app does not keep it on. */
type UnkeepableTerm = 'unasked-write' | 'expiry';

/** The terms that make a granted credential one this app won't keep; empty if it will. */
function unkeepableTerms(
  request: Pick<AccessRequest, 'write'>,
  grant: Pick<AccessGrant, 'write' | 'expiresAt'>,
): UnkeepableTerm[] {
  const terms: UnkeepableTerm[] = [];
  if (grant.write && !request.write) terms.push('unasked-write');
  if (grant.expiresAt !== undefined) terms.push('expiry');
  return terms;
}

function remedy(term: UnkeepableTerm): string {
  switch (term) {
    case 'unasked-write':
      return 'without write access';
    case 'expiry':
      return 'to never expire';
  }
}

function describe(term: UnkeepableTerm, grant: AccessGrant): string {
  switch (term) {
    case 'unasked-write':
      return 'It was approved with write access, which was not asked for.';
    case 'expiry': {
      const at = grant.expiresAt && !Number.isNaN(grant.expiresAt.getTime()) ? grant.expiresAt.toISOString() : 'later';
      return `It was approved to expire ${at}, and nothing here renews it.`;
    }
  }
}
