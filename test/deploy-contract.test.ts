import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contracts between the host install paths. Nothing here runs a provisioner
 * (that needs a real VM). These checks catch the drift that would otherwise
 * only show up on one: a script that no longer parses, the two install paths
 * disagreeing about which units exist, or the Beeper sign-in surface being
 * enabled at boot again.
 */

const DEPLOY = join(import.meta.dirname, '..', 'deploy');
const read = (file: string) => readFileSync(join(DEPLOY, file), 'utf8');

/** Unit names an install path copies out of deploy/systemd/ in its install loop. */
const installedUnits = (source: string): string[] => {
  const loop = /for (?:u|unit) in ([a-z0-9 -]+); do\s+install /.exec(source);
  if (!loop?.[1]) throw new Error('no deploy/systemd install loop found');
  return loop[1].trim().split(/\s+/).sort();
};

describe('deploy/ contracts', () => {
  it('every deploy shell script parses', () => {
    const scripts = readdirSync(DEPLOY).filter((f) => f.endsWith('.sh'));
    expect(scripts).toEqual(expect.arrayContaining(['bootstrap.sh', 'signin-surface.sh']));

    for (const script of scripts) {
      const { status, stderr } = spawnSync('bash', ['-n', join(DEPLOY, script)], { encoding: 'utf8' });
      expect(status, `${script}: ${stderr}`).toBe(0);
    }
  });

  it('bootstrap.sh and cloud-init.yaml install the same Beeper units, and every one exists', () => {
    const fromBootstrap = installedUnits(read('bootstrap.sh'));
    const fromCloudInit = installedUnits(read('cloud-init.yaml'));

    expect(fromCloudInit).toEqual(fromBootstrap);
    for (const unit of fromBootstrap) {
      expect(existsSync(join(DEPLOY, 'systemd', `${unit}.service`)), unit).toBe(true);
    }
  });

  it('every unit file in deploy/systemd is installed by bootstrap.sh', () => {
    const bootstrap = read('bootstrap.sh');
    const shipped = readdirSync(join(DEPLOY, 'systemd')).map((f) => f.replace(/\.service$/, ''));
    const installed = new Set(installedUnits(bootstrap));

    for (const unit of shipped) {
      const viaLoop = installed.has(unit);
      const byPath = bootstrap.includes(`deploy/systemd/${unit}.service`);
      expect(viaLoop || byPath, `${unit}.service is shipped but never installed`).toBe(true);
    }
  });

  it('no install path enables the sign-in surface at boot', () => {
    for (const file of ['bootstrap.sh', 'cloud-init.yaml']) {
      const offending = read(file)
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .filter((line) => /\benable\b/.test(line) && /x11vnc|novnc/.test(line));
      expect(offending, file).toEqual([]);
    }
  });

  it('signin-surface.sh is executable, because the runbook and DEPLOY.md invoke it directly', () => {
    expect(statSync(join(DEPLOY, 'signin-surface.sh')).mode & 0o111).not.toBe(0);
  });
});
