import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpointStore, type Checkpoint } from '../src/assistant/responder/checkpoint.js';

const CHECKPOINT: Checkpoint = {
  since: '2026-10-14T20:00:00.000Z',
  handled: [{ chatId: '!family', messageId: 'ask', timestamp: '2026-10-14T20:01:00.000Z' }],
};

describe('FileCheckpointStore', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-messenger-checkpoint-'));
    path = join(dir, 'state', 'responder.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has nothing before the first save', async () => {
    await expect(new FileCheckpointStore(path).load()).resolves.toBeUndefined();
  });

  it('gives back what was saved last, to another store on the same file too, readable by its owner alone', async () => {
    await new FileCheckpointStore(path).save({ since: '2026-10-14T19:00:00.000Z', handled: [] });
    await new FileCheckpointStore(path).save(CHECKPOINT);

    await expect(new FileCheckpointStore(path).load()).resolves.toEqual(CHECKPOINT);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'state'))).mode & 0o777).toBe(0o700);
    // Each save renames a whole file into place, leaving nothing else behind.
    expect(await readdir(join(dir, 'state'))).toEqual(['responder.json']);
  });

  it.each([
    ['not JSON', '{"since": "2026-10-14T20:00:00.000Z",'],
    ['another version', JSON.stringify({ ...CHECKPOINT, version: 2 })],
    ['no version', JSON.stringify(CHECKPOINT)],
    ['a time that is not one', JSON.stringify({ version: 1, ...CHECKPOINT, since: 'yesterday' })],
    ['a handled request missing its time', JSON.stringify({ version: 1, since: CHECKPOINT.since, handled: [{ chatId: 'c', messageId: 'm' }] })],
  ])('refuses a file that holds %s, saying how to start over, rather than guess where to resume', async (_, text) => {
    await writeFile(join(dir, 'responder.json'), text);
    await expect(new FileCheckpointStore(join(dir, 'responder.json')).load()).rejects.toThrow(
      /responder\.json is not a checkpoint this version can read\. Delete it to start answering from now/,
    );
  });

  it('fails a save it cannot finish, leaving no half-made file behind', async () => {
    // Something that isn't a file is in the way of the rename.
    await mkdir(join(path, 'in-the-way'), { recursive: true });
    await expect(new FileCheckpointStore(path).save(CHECKPOINT)).rejects.toThrow();
    expect(await readdir(join(dir, 'state'))).toEqual(['responder.json']);
  });
});
