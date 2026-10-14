import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

/**
 * All runtime configuration comes from the environment (plus an optional
 * .env file loaded by the CLI entrypoint). The same config works for every
 * deployment topology — local Beeper Desktop, a tunnel to it, or a headless
 * Beeper Server on a VPS — because they all speak the same Client API.
 */
const EndpointSchema = z.object({
  /** Where the Beeper Client API is reachable from this process. */
  BEEPER_BASE_URL: z.string().url().default('http://localhost:23373'),
});

/** Set but empty reads as unset: `BEEPER_POLL_INTERVAL_MS=` means the default. */
const unsetIfEmpty = (value: unknown) => (value === '' ? undefined : value);

const ConfigSchema = EndpointSchema.extend({
  /**
   * Token from `claude-messenger connect` (Beeper's own approval box), or
   * minted in Beeper under Settings → Integrations → Approved connections.
   */
  BEEPER_ACCESS_TOKEN: z.string().min(1, 'BEEPER_ACCESS_TOKEN is required (get one with: claude-messenger connect)'),
  CLAUDE_MESSENGER_POLICY: z.string().default('./policy.json'),
  CLAUDE_MESSENGER_AUDIT_DIR: z.string().default('./audit'),
  /**
   * Mutable runtime state (e.g. the send rate window) — kept apart from the
   * audit dir, whose contract is an append-only trail the user may prune.
   */
  CLAUDE_MESSENGER_STATE_DIR: z.string().default('./state'),
  /**
   * Bearer token protecting the HTTP MCP endpoint (`serve --http`).
   * Deliberately distinct from the Beeper token: revoking Claude's access
   * must not require rotating the Beeper credential.
   */
  CLAUDE_MESSENGER_MCP_TOKEN: z.string().optional(),
  /**
   * How often a message watch (`mentions`) asks Beeper for new messages.
   * Lower notices a mention sooner and asks Beeper more often; more than
   * once a second gains a person nothing.
   */
  BEEPER_POLL_INTERVAL_MS: z.preprocess(
    unsetIfEmpty,
    z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  ),
});

/** Where the provider is: all a command needs before any credential exists. */
export interface EndpointConfig {
  beeperBaseUrl: string;
}

export interface Config extends EndpointConfig {
  beeperAccessToken: string;
  beeperPollIntervalMs: number;
  policyPath: string;
  auditDir: string;
  stateDir: string;
  mcpToken?: string;
}

function parse<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(
      `Invalid configuration — ${issues}. Copy .env.example to .env and fill it in (see docs/SETUP.md).`,
    );
  }
  return parsed.data;
}

export function loadEndpointConfig(env: NodeJS.ProcessEnv = process.env): EndpointConfig {
  return { beeperBaseUrl: parse(EndpointSchema, env).BEEPER_BASE_URL };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const data = parse(ConfigSchema, env);
  return {
    beeperAccessToken: data.BEEPER_ACCESS_TOKEN,
    beeperBaseUrl: data.BEEPER_BASE_URL,
    beeperPollIntervalMs: data.BEEPER_POLL_INTERVAL_MS,
    policyPath: data.CLAUDE_MESSENGER_POLICY,
    auditDir: data.CLAUDE_MESSENGER_AUDIT_DIR,
    stateDir: data.CLAUDE_MESSENGER_STATE_DIR,
    ...(data.CLAUDE_MESSENGER_MCP_TOKEN !== undefined && {
      mcpToken: data.CLAUDE_MESSENGER_MCP_TOKEN,
    }),
  };
}

/**
 * The configuration of the app as run from `dir`, such as the assistant's
 * own directory: that directory's `.env` alone, never this process's
 * environment, so nothing set here, such as another account's token, can
 * stand in for what the file leaves out. Relative paths in it are taken
 * from `dir`, as a command run there takes them.
 */
export async function loadConfigIn(dir: string): Promise<Config> {
  const file = join(dir, '.env');
  let config: Config;
  try {
    config = loadConfig(parseEnv(await readFile(file, 'utf8')));
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`, { cause: err });
  }
  return {
    ...config,
    policyPath: resolve(dir, config.policyPath),
    auditDir: resolve(dir, config.auditDir),
    stateDir: resolve(dir, config.stateDir),
  };
}

/** The variable that carries the provider credential, in env files and the environment. */
const ACCESS_TOKEN_VAR = 'BEEPER_ACCESS_TOKEN';

/**
 * Write the provider credential into an env file, keeping every other line.
 *
 * The new file is created owner-only (0600) and renamed over the old one, so
 * no reader ever sees a half-written file, and the token never sits in a file
 * anyone else can read, whatever the old file's mode was. A symlinked env
 * file is updated where it points. The result is read back with Node's own
 * env-file parser before it replaces anything: if that would load another
 * token, nothing is saved. Reports whether an earlier, non-empty token was
 * replaced, since the caller should say so: that token still works until it
 * is revoked in Beeper.
 */
export async function saveAccessToken(file: string, token: string): Promise<{ replaced: boolean }> {
  // Written unquoted, so only characters every env-file parser reads back
  // verbatim. Real tokens (hex, base64, JWT) fit; anything else is refused
  // rather than saved in a form that would load as a different token.
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    throw new Error('The access token contains characters an env file cannot hold verbatim; nothing was saved.');
  }

  let target = file;
  let text = '';
  try {
    target = await realpath(file);
    text = await readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // A link to nothing: renaming over it would replace the link itself.
    if ((await lstat(file).catch(() => undefined))?.isSymbolicLink()) {
      throw new Error(`${file} is a symlink to a file that does not exist; create that file, or remove the link. Nothing was saved.`);
    }
  }
  const replaced = Boolean(parseEnv(text)[ACCESS_TOKEN_VAR]);

  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${ACCESS_TOKEN_VAR}\\s*=`);
  const out: string[] = [];
  let written = false;
  for (const line of lines) {
    if (!assignment.test(line)) {
      out.push(line);
      continue;
    }
    // Every earlier assignment goes; the first one's slot keeps the file's order.
    if (!written) out.push(`${ACCESS_TOKEN_VAR}=${token}`);
    written = true;
  }
  if (!written) out.push(`${ACCESS_TOKEN_VAR}=${token}`);
  const content = `${out.join('\n')}\n`;
  if (parseEnv(content)[ACCESS_TOKEN_VAR] !== token) {
    throw new Error(`${file} has a line this could not replace cleanly, so it would load another token; nothing was saved.`);
  }

  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  return { replaced };
}
