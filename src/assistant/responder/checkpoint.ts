import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { MessengerError } from '../../core/errors.js';

/** A request the responder answered, or told the owner it couldn't. */
export interface HandledRequest {
  chatId: string;
  messageId: string;
  /** The message's own time (ISO 8601): once the watch resumes after it, the entry can go. */
  timestamp: string;
}

/**
 * How far the responder has got, kept across restarts: the watch resumes
 * after `since`, and a request among `handled` isn't handled again. It
 * holds IDs and times, never what anyone wrote.
 */
export interface Checkpoint {
  /** ISO 8601: the owner's messages timestamped after this may still hold requests. */
  since: string;
  /** Requests timestamped after `since` that were already handled. */
  handled: HandledRequest[];
}

/** Where the responder keeps its checkpoint. */
export interface CheckpointStore {
  /** The checkpoint saved last, or undefined before the first. Rejects when there is one it can't read. */
  load(): Promise<Checkpoint | undefined>;
  /** Replaces the checkpoint; resolves once it is saved. */
  save(checkpoint: Checkpoint): Promise<void>;
}

/** A checkpoint is there, but isn't one this version can read. The message says how to start over. */
export class CheckpointError extends MessengerError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'checkpoint_unreadable', options);
  }
}

const Time = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'not an ISO 8601 time');

const CheckpointFile = z
  .object({
    version: z.literal(1),
    since: Time,
    handled: z.array(z.object({ chatId: z.string(), messageId: z.string(), timestamp: Time }).strict()),
  })
  .strict();

/**
 * A checkpoint in a JSON file, readable by its owner alone. Each save
 * writes a new file and renames it over the last, so a reader never sees
 * half of one. A file that is there but isn't a checkpoint is refused, not
 * replaced: guessing where to resume could answer a request twice, or skip
 * one.
 */
export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Checkpoint | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    let parsed: z.infer<typeof CheckpointFile>;
    try {
      parsed = CheckpointFile.parse(JSON.parse(text));
    } catch (err) {
      throw new CheckpointError(
        `${this.path} is not a checkpoint this version can read. Delete it to start answering from now, ` +
          'leaving any request made while it was stopped unanswered.',
        { cause: err },
      );
    }
    return { since: parsed.since, handled: parsed.handled };
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify({ version: 1, ...checkpoint })}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, this.path);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }
}

/** A checkpoint kept in memory, for tests and dry runs. */
export class MemoryCheckpointStore implements CheckpointStore {
  /** Every checkpoint saved, oldest first. */
  readonly saved: Checkpoint[] = [];

  constructor(private readonly initial?: Checkpoint) {}

  async load(): Promise<Checkpoint | undefined> {
    const last = this.saved.at(-1) ?? this.initial;
    return last === undefined ? undefined : structuredClone(last);
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    this.saved.push(structuredClone(checkpoint));
  }
}
