import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

/**
 * What /proc says of a process the tests started or a service runs, as this
 * process sees it: parents are given in this PID namespace's numbers, even
 * for a process in a namespace of its own.
 */

/** A process's state (R, S, Z for a zombie...) and parent, or nothing once it is gone. */
export const processStat = (id: number): { state: string; parent: number } | undefined => {
  try {
    const line = readFileSync(`/proc/${id}/stat`, 'utf8');
    // The name, in parentheses, may itself hold spaces and parentheses.
    const [state, parent] = line.slice(line.lastIndexOf(')') + 2).split(' ');
    return { state: state!, parent: Number(parent) };
  } catch {
    return undefined;
  }
};

/** The processes `parent` started, or took on when theirs ended. */
export const childrenOf = (parent: number): number[] =>
  readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((id) => processStat(id)?.parent === parent);

/** The executable a process runs, or nothing once it is gone. */
export const executableOf = (id: number): string | undefined => {
  try {
    return readlinkSync(`/proc/${id}/exe`);
  } catch {
    return undefined;
  }
};
