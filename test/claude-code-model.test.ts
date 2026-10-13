import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ModelError } from '../src/core/errors.js';
import { ClaudeCodeModel } from '../src/providers/claude-code/model.js';
import { writeClaudeShim } from './claude-code-shim.js';

const request = {
  instructions: 'Summarize the briefing.',
  input: 'Alice: are we still on for dinner?\nBob: the code is 123456',
};

/** The environment of a Claude Code session that runs the CLI, as the model sees it. */
const sessionEnv = (path: string) => ({
  HOME: '/home/owner',
  PATH: path,
  LANG: 'en_US.UTF-8',
  HTTPS_PROXY: 'http://proxy.example:3128',
  BEEPER_ACCESS_TOKEN: 'beeper-token-secret',
  CLAUDE_MESSENGER_MCP_TOKEN: 'mcp-token-secret',
  ANTHROPIC_API_KEY: 'sk-ant-api-key',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'remote',
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'session-token-secret',
});

const onPath = (dir: string) => `${dir}:${process.env.PATH ?? ''}`;

describe('ClaudeCodeModel (the real CLI started as a subprocess, a stand-in on PATH)', () => {
  it("answers with what Claude Code prints, trimmed", async () => {
    const shim = await writeClaudeShim({ stdout: '\n  **Needs you**\n- Alice asked about dinner.  \n\n' });
    const model = new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)) });
    await expect(model.write(request)).resolves.toBe('**Needs you**\n- Alice asked about dinner.');
  });

  it('hands over the input on stdin, never on the command line, and the instructions as the system prompt', async () => {
    const shim = await writeClaudeShim({ stdout: 'ok' });
    await new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)) }).write(request);
    const [call] = await shim.calls();
    expect(call!.stdin).toBe(request.input);
    // Every local user can read a process's command line.
    expect(call!.argv.join(' ')).not.toContain('dinner');
    expect(call!.argv.join(' ')).not.toContain('123456');
    expect(call!.argv[call!.argv.indexOf('--system-prompt') + 1]).toBe(request.instructions);
  });

  it('runs Claude Code in print mode with no tools, no MCP servers, no customizations and no transcript', async () => {
    const shim = await writeClaudeShim({ stdout: 'ok' });
    await new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)) }).write(request);
    const [{ argv }] = (await shim.calls()) as [{ argv: string[] }];
    expect(argv).toContain('--print');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--safe-mode');
    expect(argv).toContain('--no-session-persistence');
    expect(argv).not.toContain('--bare'); // reads only API keys, so it would leave the subscription
  });

  it('asks for the model it is given, and otherwise leaves the choice to Claude Code', async () => {
    const shim = await writeClaudeShim({ stdout: 'ok' });
    const env = sessionEnv(onPath(shim.dir));
    await new ClaudeCodeModel({ command: shim.command, env, model: 'sonnet' }).write(request);
    await new ClaudeCodeModel({ command: shim.command, env }).write(request);
    const [chosen, unchosen] = await shim.calls();
    expect(chosen!.argv[chosen!.argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(unchosen!.argv).not.toContain('--model');
  });

  it("passes on only the sign-in, network and locale environment: no Beeper token, API key or calling session's variables", async () => {
    const shim = await writeClaudeShim({ stdout: 'ok' });
    const env = sessionEnv(onPath(shim.dir));
    await new ClaudeCodeModel({ command: shim.command, env }).write(request);
    const [call] = await shim.calls();
    expect(call!.env).toEqual({
      HOME: env.HOME,
      PATH: env.PATH,
      LANG: env.LANG,
      HTTPS_PROXY: env.HTTPS_PROXY,
      // Nothing it reads may outlive the run.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  it('starts in an empty directory of its own, removed once it answers', async () => {
    const shim = await writeClaudeShim({ stdout: 'ok' });
    await new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)) }).write(request);
    const [call] = await shim.calls();
    expect(call!.cwd.startsWith(tmpdir())).toBe(true);
    expect(call!.cwdEntries).toEqual([]);
    expect(existsSync(call!.cwd)).toBe(false);
  });

  it('removes its directory when the run fails too', async () => {
    const shim = await writeClaudeShim({ exitCode: 1 });
    await expect(
      new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)) }).write(request),
    ).rejects.toThrow(ModelError);
    const [call] = await shim.calls();
    expect(existsSync(call!.cwd)).toBe(false);
  });

  it("says why Claude Code failed, from its last word on stderr", async () => {
    const shim = await writeClaudeShim({ stderr: 'Starting up\nInvalid API key · Please run /login\n', exitCode: 1 });
    const model = new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)) });
    const failure = model.write(request);
    await expect(failure).rejects.toThrow(ModelError);
    await expect(failure).rejects.toThrow('Claude Code failed (exit 1): Invalid API key · Please run /login');
  });

  it('says why from stdout when Claude Code puts it there, as it does for a usage limit', async () => {
    const shim = await writeClaudeShim({ stdout: 'Claude usage limit reached. Your limit will reset at 8am.\n', exitCode: 1 });
    const model = new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)) });
    await expect(model.write(request)).rejects.toThrow(
      'Claude Code failed (exit 1): Claude usage limit reached. Your limit will reset at 8am.',
    );
  });

  it('refuses an empty answer instead of passing it on as a digest', async () => {
    const shim = await writeClaudeShim({ stdout: '  \n\n' });
    const model = new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)) });
    await expect(model.write(request)).rejects.toThrow('Claude Code answered with nothing.');
  });

  it('says Claude Code is not installed when there is no such command, and how to fix it', async () => {
    const model = new ClaudeCodeModel({ command: 'claude-not-installed-here', env: sessionEnv('/nonexistent') });
    const failure = model.write(request);
    await expect(failure).rejects.toThrow(ModelError);
    await expect(failure).rejects.toThrow(/not installed here.*sign in once with your Claude subscription/);
  });

  it('gives up on a run that takes too long, and stops it', async () => {
    const shim = await writeClaudeShim({ stdout: 'too late', delayMs: 30_000 });
    const model = new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)), timeoutMs: 1_000 });
    await expect(model.write(request)).rejects.toThrow('Claude Code gave no answer within 1 second.');
    const [call] = await shim.calls();
    expect(() => process.kill(call!.pid, 0)).toThrow(); // gone
  });

  it('kills a run that ignores being asked to stop', async () => {
    const shim = await writeClaudeShim({ delayMs: 30_000, ignoreTerm: true });
    const model = new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)), timeoutMs: 500 });
    await expect(model.write(request)).rejects.toThrow('gave no answer');
    const [call] = await shim.calls();
    expect(() => process.kill(call!.pid, 0)).toThrow();
  }, 15_000);

  it('stops a run whose answer runs on far past a page', async () => {
    const shim = await writeClaudeShim({ floodChars: 2_000_000 });
    const model = new ClaudeCodeModel({ command: shim.command, env: sessionEnv(onPath(shim.dir)) });
    await expect(model.write(request)).rejects.toThrow('ran past 1000000 characters');
    const [call] = await shim.calls();
    expect(() => process.kill(call!.pid, 0)).toThrow();
  }, 15_000);
});
