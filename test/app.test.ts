import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadPolicyFile, PolicyFileError } from '../src/app.js';

describe('loadPolicyFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'policy-load-'));
  });

  it('returns undefined when the file does not exist (default-policy fallback)', async () => {
    await expect(loadPolicyFile(join(dir, 'nope.json'))).resolves.toBeUndefined();
  });

  it('parses a valid policy file', async () => {
    const path = join(dir, 'policy.json');
    await writeFile(path, JSON.stringify({ version: 1, capabilities: { send: true } }));
    const policy = await loadPolicyFile(path);
    expect(policy?.capabilities.send).toBe(true);
    expect(policy?.capabilities.read).toBe(true); // schema default
  });

  it('malformed JSON fails hard with the file path in the message, never falls back', async () => {
    const path = join(dir, 'policy.json');
    await writeFile(path, '{ "version": 1, }');
    const err = await loadPolicyFile(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyFileError);
    expect((err as Error).message).toContain(path);
    expect((err as Error).message).toContain('not valid JSON');
  });

  it('schema violations report the offending field, not raw zod JSON', async () => {
    const path = join(dir, 'policy.json');
    await writeFile(path, JSON.stringify({ version: 1, send: { maxMessagesPerHour: 0 } }));
    const err = await loadPolicyFile(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyFileError);
    expect((err as Error).message).toContain('send.maxMessagesPerHour');
  });

  it('a policy file missing the required version field is rejected (the documented example must include it)', async () => {
    const path = join(dir, 'policy.json');
    await writeFile(path, JSON.stringify({ capabilities: { send: true } }));
    await expect(loadPolicyFile(path)).rejects.toThrow(PolicyFileError);
  });
});
