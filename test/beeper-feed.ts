import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Beeper's update feed and download host, for deploy/assistant-beeper.sh,
 * serving stand-ins for Beeper Server builds.
 *
 * The feed answers `?bundleID=…&platform=…&channel=…&arch=…` with the latest
 * build: its version, its download URL and the archive's SHA-512 in base64,
 * as api.beeper.com/desktop/update-feed.json does (read 2026-10-14). A build
 * is a .tar.gz holding `beeper-server-<version>-linux-<arch>/beeper-server`.
 * Here that file is `standInServer`: node, answering the two routes the
 * script reads as Beeper Server 4.3.176 answers them.
 */
export class BeeperFeed {
  /** What the feed announces, per stable Server build asked for. Undefined: it answers 404. */
  latest: StandInBuild | undefined;
  /** Every feed request's query, in order. */
  readonly queries: URLSearchParams[] = [];
  /** Every archive downloaded, by file name, in order. */
  readonly downloads: string[] = [];
  /**
   * Replaces the feed's answer, for feeds that announce something the script
   * must refuse. A string is sent as it is; anything else, as JSON.
   */
  shapeFeed: ((feed: FeedEntry) => unknown) | undefined;

  private readonly dir = mkdtempSync(join(tmpdir(), 'beeper-feed-'));
  /** Each build's archives, packed on first use: by build, then architecture. */
  private readonly packed = new Map<StandInBuild, Map<string, { path: string; bytes: Buffer }>>();
  private archives = 0;
  private server: Server | undefined;
  private base = '';

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://feed');
      if (url.pathname === '/desktop/update-feed.json') {
        this.queries.push(url.searchParams);
        if (!this.latest) {
          res.writeHead(404).end();
          return;
        }
        const entry = this.entry(this.latest, url.searchParams.get('arch') ?? '');
        const body = this.shapeFeed ? this.shapeFeed(entry) : entry;
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(typeof body === 'string' ? body : JSON.stringify(body));
        return;
      }
      // /builds/<n>/<file>: one directory per build packed, as the file name
      // is the same for two stand-ins of one version.
      const build = /^\/builds\/(\d+)\/([^/]+)$/.exec(url.pathname);
      if (build) {
        this.downloads.push(build[2]!);
        try {
          const archive = readFileSync(join(this.dir, build[1]!, build[2]!));
          res.writeHead(200, { 'content-type': 'application/gzip' }).end(archive);
        } catch {
          res.writeHead(404).end();
        }
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return `${this.base}/desktop/update-feed.json`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** The feed's answer for `build` on `arch`. */
  private entry(build: StandInBuild, arch: string): FeedEntry {
    const file = `beeper-server-${build.version}-linux-${arch}.tar.gz`;
    const archive = this.archive(build, arch, file);
    return {
      version: build.version,
      url: `${this.base}/builds/${archive.path}/${file}`,
      name: build.version,
      notes: [],
      sha512: createHash('sha512').update(archive.bytes).digest('base64'),
      pub_date: '2026-10-05T22:06:36+00:00',
    };
  }

  private archive(build: StandInBuild, arch: string, file: string): { path: string; bytes: Buffer } {
    const byArch = this.packed.get(build) ?? new Map<string, { path: string; bytes: Buffer }>();
    this.packed.set(build, byArch);
    const cached = byArch.get(arch);
    if (cached) return cached;

    const path = String(this.archives++);
    const stage = mkdtempSync(join(this.dir, 'stage-'));
    const folder = `beeper-server-${build.version}-linux-${arch}`;
    const server = join(stage, folder, 'beeper-server');
    mkdirSync(join(stage, folder));
    switch (build.holds ?? 'the server') {
      case 'the server':
        writeFileSync(server, standInServer(build));
        chmodSync(server, 0o755);
        break;
      case 'a symlink':
        // Into the host's files: whoever installs it as root would install them.
        symlinkSync('/etc/hostname', server);
        break;
      case 'no server':
        writeFileSync(join(stage, folder, 'README'), 'Nothing to run here.\n');
        break;
    }
    mkdirSync(join(this.dir, path));
    execFileSync('tar', ['-czf', join(this.dir, path, file), '-C', stage, folder]);
    const packed = { path, bytes: readFileSync(join(this.dir, path, file)) };
    byArch.set(arch, packed);
    return packed;
  }
}

export interface FeedEntry {
  version: string;
  url: string;
  name: string;
  notes: unknown[];
  sha512: string;
  pub_date: string;
}

export interface StandInBuild {
  version: string;
  /** Exits as soon as it starts, as a build that can't run on this host would. */
  crashes?: boolean;
  /** What the archive holds where the server belongs. The server, unless a test says otherwise. */
  holds?: 'the server' | 'a symlink' | 'no server';
}

/**
 * A stand-in for the `beeper-server` executable. Like Beeper Server 4.3.176:
 * started with --host, --port and --data-dir, it answers GET /v1/info with
 * its version and port, and GET /v1/app/setup with 200 while signed out and
 * 401 (no token) once signed in, which here means a file `signed-in` in its
 * data dir. Each start is appended to `starts.log` there, so a test can tell
 * a restart from no restart, and see the arguments systemd gave it.
 *
 * Under /test/ it also answers what it can do from where it runs, which is
 * how the sandbox test probes the unit's sandbox from inside: whether it can
 * stat a path, create a file there, or listen on a port, and which user it
 * runs as. Each answers 200 with `{ ok: true }` or `{ error: <errno code> }`.
 */
export function standInServer(build: StandInBuild): string {
  return `#!${process.execPath}
const { createServer } = require('node:http');
const { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } = require('node:fs');
const VERSION = ${JSON.stringify(build.version)};
const arg = (name) => process.argv.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const host = arg('host');
const port = Number(arg('port'));
const dataDir = arg('data-dir');
mkdirSync(dataDir, { recursive: true });
appendFileSync(dataDir + '/starts.log', JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), version: VERSION }) + '\\n');
${build.crashes ? "console.error('beeper-server: cannot start'); process.exit(1);" : ''}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const attempt = (res, act) => {
  try {
    act();
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 200, { error: err.code ?? String(err) });
  }
};
createServer((req, res) => {
  const url = new URL(req.url, 'http://server');
  const path = url.searchParams.get('path');
  switch (url.pathname) {
    case '/v1/info':
      return send(res, 200, {
        app: { name: 'Beeper', version: VERSION, bundle_id: 'com.automattic.beeper.desktop' },
        server: { status: 'running', base_url: 'http://' + host + ':' + port, port, hostname: host },
      });
    case '/v1/app/setup':
      return existsSync(dataDir + '/signed-in')
        ? send(res, 401, { message: 'Unauthorized: Invalid or missing token', code: 'unauthorized' })
        : send(res, 200, { state: 'needs-login', e2ee: { initialized: false } });
    case '/test/identity':
      return send(res, 200, { uid: process.getuid(), gid: process.getgid(), pid: process.pid });
    case '/test/stat':
      return attempt(res, () => statSync(path));
    case '/test/create':
      return attempt(res, () => writeFileSync(path, '', { flag: 'wx' }));
    case '/test/listen': {
      const probe = createServer();
      probe.once('error', (err) => send(res, 200, { error: err.code }));
      return probe.listen(Number(url.searchParams.get('port')), '127.0.0.1', () => probe.close(() => send(res, 200, { ok: true })));
    }
  }
  send(res, 404, { message: 'Not found', code: 'not_found' });
}).listen(port, host);
process.on('SIGTERM', () => process.exit(0));
`;
}
