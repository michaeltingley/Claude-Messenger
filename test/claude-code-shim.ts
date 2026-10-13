import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What one run of the stand-in `claude` saw. */
export interface ShimCall {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** What was in its working directory when it started. */
  cwdEntries: string[];
  stdin: string;
  pid: number;
  /** The process it left behind, when told to leave one. */
  lingeringPid?: number;
}

/** How the stand-in answers. */
export interface ShimBehavior {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Wait this long before answering. */
  delayMs?: number;
  /** Ignore SIGTERM, as a hung process might. */
  ignoreTerm?: boolean;
  /** Write this many characters to stdout, as a runaway answer would. */
  floodChars?: number;
  /** Leave a process behind that holds stdout open after exiting, as a helper Claude Code started might. */
  lingeringChild?: boolean;
}

export interface Shim {
  /** The stand-in's directory, to put first on PATH: it holds an executable named `claude`. */
  dir: string;
  /** The stand-in's absolute path. */
  command: string;
  /** Every run so far, in order. */
  calls(): Promise<ShimCall[]>;
}

/**
 * A stand-in for the Claude Code CLI: a real executable, started the way the
 * real one is, that records what it was given (arguments, environment,
 * working directory, stdin) and answers as told. Its behavior is fixed when
 * it is written, because the environment it runs in is exactly what is
 * under test.
 *
 * Like the fake host's shims, it refuses any invocation it doesn't model
 * (exit 64), so the model can't drift to an untested command line:
 * `--print --output-format text --tools "" --strict-mcp-config --safe-mode
 * --no-session-persistence [--model <name>] --system-prompt <text>`.
 */
export async function writeClaudeShim(behavior: ShimBehavior = {}): Promise<Shim> {
  const root = await mkdtemp(join(tmpdir(), 'claude-shim-'));
  const dir = join(root, 'bin');
  await mkdir(dir);
  const log = join(root, 'calls.jsonl');
  const command = join(dir, 'claude');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
const FIXED = ['--print', '--output-format', 'text', '--tools', '', '--strict-mcp-config', '--safe-mode', '--no-session-persistence'];
let rest = args.slice(FIXED.length);
if (rest[0] === '--model' && rest.length > 1) rest = rest.slice(2);
if (!FIXED.every((arg, i) => args[i] === arg) || rest.length !== 2 || rest[0] !== '--system-prompt') {
  process.stderr.write('fake claude: unmodeled invocation: ' + JSON.stringify(args) + '\\n');
  process.exit(64);
}
if (behavior.ignoreTerm) process.on('SIGTERM', () => {});
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', () => {
  const call = {
    argv: args,
    env: { ...process.env },
    cwd: process.cwd(),
    cwdEntries: fs.readdirSync(process.cwd()),
    stdin,
    pid: process.pid,
  };
  if (behavior.lingeringChild) {
    const child = require('node:child_process').spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    child.unref();
    call.lingeringPid = child.pid;
  }
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + '\\n');
  setTimeout(() => {
    if (behavior.floodChars) {
      process.stdout.write('x'.repeat(behavior.floodChars));
      setInterval(() => {}, 1000);
      return;
    }
    if (behavior.stderr) process.stderr.write(behavior.stderr);
    process.stdout.write(behavior.stdout ?? '', () => process.exit(behavior.exitCode ?? 0));
    if (behavior.ignoreTerm) setInterval(() => {}, 1000);
  }, behavior.delayMs ?? 0);
});
`;
  await writeFile(command, script);
  await chmod(command, 0o755);
  return {
    dir,
    command,
    calls: async () => {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ShimCall);
    },
  };
}
