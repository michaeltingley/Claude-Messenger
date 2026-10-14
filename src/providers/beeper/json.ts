import type { z } from 'zod';
import { ProviderError } from '../../core/errors.js';

/** A body parsed as JSON, or undefined if it isn't JSON. */
export function parseOrUndefined(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Parses a response body, naming only the fields that didn't fit: never the
 * values, since a token response's values include the token.
 */
export function parseJson<S extends z.ZodTypeAny>(schema: S, body: string, what: string): z.output<S> {
  const parsed = schema.safeParse(parseOrUndefined(body));
  if (parsed.success) return parsed.data;
  const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'body'))].join(', ');
  throw new ProviderError(`Beeper sent an unexpected ${what} (${fields}).`);
}
