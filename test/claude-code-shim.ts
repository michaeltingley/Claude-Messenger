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
  /** Write to stdout without end, as fast as it is read. */
  floodForever?: boolean;
  /** Leave a process behind that holds stdout open after exiting, as a helper Claude Code started might. */
  lingeringChild?: boolean;
  /** Exit at once, without reading stdin, as Claude Code does when it refuses its command line. */
  exitUnread?: boolean;
}

export interface Shim {
  /** The stand-in's directory, to put first on PATH: it holds an executable named `claude`. */
  dir: string;
  /** The stand-in's absolute path. */
  command: string;
  /** Every run so far, in order. */
  calls(): Promise<ShimCall[]>;
  /** How much a flooding run has written to stdout so far. */
  written(): Promise<number>;
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
 * --no-session-persistence [--model <name>] --system-prompt <text>`, in any
 * order, as Claude Code takes them.
 */
export async function writeClaudeShim(behavior: ShimBehavior = {}): Promise<Shim> {
  const root = await mkdtemp(join(tmpdir(), 'claude-shim-'));
  const dir = join(root, 'bin');
  await mkdir(dir);
  const log = join(root, 'calls.jsonl');
  const writtenFile = join(root, 'written');
  const command = join(dir, 'claude');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
const FLAGS = ['--print', '--strict-mcp-config', '--safe-mode', '--no-session-persistence'];
const VALUES = { '--output-format': (v) => v === 'text', '--tools': (v) => v === '', '--model': (v) => v !== '', '--system-prompt': () => true };
const REQUIRED = [...FLAGS, '--output-format', '--tools', '--system-prompt'];
const seen = new Set();
let modeled = true;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (seen.has(arg)) modeled = false;
  seen.add(arg);
  if (FLAGS.includes(arg)) continue;
  if (arg in VALUES && i + 1 < args.length && VALUES[arg](args[i + 1])) i++;
  else modeled = false;
}
if (!modeled || !REQUIRED.every((arg) => seen.has(arg))) {
  process.stderr.write('fake claude: unmodeled invocation: ' + JSON.stringify(args) + '\\n');
  process.exit(64);
}
if (behavior.exitUnread) {
  process.stderr.write(behavior.stderr ?? '');
  process.exit(behavior.exitCode ?? 1);
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
    if (behavior.floodForever) {
      const chunk = 'x'.repeat(1 << 20);
      let written = 0;
      const flood = (err) => {
        if (err) return setInterval(() => {}, 1000);
        fs.writeFileSync(${JSON.stringify(writtenFile)}, String(written));
        written += chunk.length;
        process.stdout.write(chunk, flood);
      };
      process.stdout.on('error', () => {});
      flood();
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
    written: async () => Number(await readFile(writtenFile, 'utf8').catch(() => '0')),
    calls: async () => {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ShimCall);
    },
  };
}
