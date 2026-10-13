import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelError } from '../../core/errors.js';
import type { LanguageModel, WriteRequest } from '../../core/model.js';

export interface ClaudeCodeModelOptions {
  /** The Claude Code executable. Defaults to `claude` on PATH. */
  command?: string;
  /** Which Claude writes: an alias such as `sonnet`, or a full model name. Defaults to Claude Code's own choice. */
  model?: string;
  /** How long one answer may take before it is given up on. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Where the sign-in and network settings come from. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
}

/**
 * What a run takes from the environment: where Claude Code's sign-in lives,
 * how it reaches the network, and the locale. Nothing else: a Claude Code
 * session that runs this command passes on its own session's variables, and
 * a child holding those could stream its transcript into that session's.
 * API keys stay behind too, so a key someone left in the environment can't
 * move the bill from the subscription Claude Code is signed in with.
 */
const PASSED_ON = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  // Claude Code's own config directory, when it isn't under HOME, and the
  // subscription token `claude setup-token` makes.
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

const FIXED_ENV = {
  // Nothing a run reads may outlive it: no memories, no prompt history, no
  // telemetry.
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  // Nothing added to the input. Claude Code attaches whatever an @-mention in
  // a prompt names, tools or not, so a message naming a file would have it
  // read that file: the install's .env, say.
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
} as const;

/**
 * The input with each "@" made a full-width "＠", which reads the same but
 * mentions nothing, so no @-mention reaches Claude Code even if it stops
 * honoring CLAUDE_CODE_DISABLE_ATTACHMENTS.
 */
function inert(input: string): string {
  return input.replaceAll('@', '＠');
}

const ARGS = [
  '--print',
  '--output-format',
  'text',
  // No tools and no MCP servers: it can only write.
  '--tools',
  '',
  '--strict-mcp-config',
  // None of the host's hooks, plugins or CLAUDE.md: they would see the
  // content, or change what gets written.
  '--safe-mode',
  // No transcript on disk.
  '--no-session-persistence',
] as const;

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Time between asking a run to stop and making it. */
const KILL_GRACE_MS = 5_000;
/** Time after a run exits for its output to finish, should something it started hold it open. */
const DRAIN_GRACE_MS = 2_000;
/** An answer is a page of text; far more means something is wrong. */
const MAX_OUTPUT_CHARS = 1_000_000;
/** Enough of stderr to say why a run failed. */
const MAX_STDERR_CHARS = 16_000;
const MAX_REASON_CHARS = 300;

/**
 * Claude, through the Claude Code CLI installed and signed in on this host:
 * one `claude -p` run per answer, on the Claude subscription it is signed in
 * with. The run is made so that the content it reads goes nowhere else:
 * - the input travels on stdin, never on a command line, which every local
 *   user can read;
 * - it gets no tools, MCP servers, hooks, plugins or CLAUDE.md, and nothing
 *   is attached to the input, so the input can't have it read a file;
 * - it keeps no transcript, memory or history, and sends no telemetry;
 * - it starts in an empty directory of its own, removed afterwards.
 */
export class ClaudeCodeModel implements LanguageModel {
  private readonly command: string;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ClaudeCodeModelOptions = {}) {
    this.command = options.command ?? 'claude';
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = options.env ?? process.env;
  }

  async write(request: WriteRequest): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), 'claude-messenger-model-'));
    try {
      return await this.run(cwd, request);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of PASSED_ON) {
      const value = this.env[name];
      if (value !== undefined) env[name] = value;
    }
    return { ...env, ...FIXED_ENV };
  }

  private run(cwd: string, { instructions, input }: WriteRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const model = this.model === undefined ? [] : ['--model', this.model];
      const child = spawn(this.command, [...ARGS, ...model, '--system-prompt', instructions], {
        cwd,
        env: this.childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let failure: ModelError | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;

      const stop = (reason: ModelError) => {
        failure ??= reason;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      };
      const timer = setTimeout(
        () => stop(new ModelError(`Claude Code gave no answer within ${describeDuration(this.timeoutMs)}.`)),
        this.timeoutMs,
      );

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_CHARS) {
          stop(new ModelError(`Claude Code's answer ran past ${MAX_OUTPUT_CHARS} characters, so it was stopped.`));
        }
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
      });
      // The run can end before reading all its input; its exit says why.
      child.stdin.on('error', () => undefined);

      child.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(
          err.code === 'ENOENT'
            ? new ModelError(
                `Claude Code is not installed here: \`${this.command}\` is not on PATH. ` +
                  'Install it, then sign in once with your Claude subscription (run `claude`, then /login).',
                { cause: err },
              )
            : new ModelError(`Claude Code could not be started: ${err.message}`, { cause: err }),
        );
      });
      // A process the run started can hold its output open after it exits;
      // that must not keep this waiting.
      child.once('exit', () => {
        drainTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, DRAIN_GRACE_MS);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(drainTimer);
        const answer = stdout.trim();
        if (failure) return reject(failure);
        if (code !== 0) {
          const how = signal ? `was stopped by ${signal}` : `failed (exit ${code})`;
          // Why it failed (signed out, a usage limit, a crash) can come on
          // either stream: stderr's last word on it, else stdout's first.
          const why = shorten(lines(stderr).at(-1) ?? lines(stdout)[0]);
          return reject(new ModelError(`Claude Code ${how}${why ? `: ${why}` : '.'}`));
        }
        if (answer.length === 0) return reject(new ModelError('Claude Code answered with nothing.'));
        resolve(answer);
      });

      child.stdin.end(inert(input), 'utf8');
    });
  }
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function shorten(line: string | undefined): string | undefined {
  return line !== undefined && line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS)}…` : line;
}

function describeDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes >= 1 && Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const seconds = Math.round(ms / 1000);
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}
