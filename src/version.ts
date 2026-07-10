import { createRequire } from 'node:module';

/**
 * Single source of truth for the package version: read from package.json at
 * runtime so the MCP handshake and CLI can never drift from the released
 * version. Falls back defensively if the package layout changes.
 */
export function packageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
