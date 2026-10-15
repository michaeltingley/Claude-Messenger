import { createServer } from 'node:net';

/**
 * Beeper Desktop's API port, the owner's on a real host: deploy scripts
 * refuse to put anything else there, so a test given it would fail.
 */
const BEEPER_DESKTOP_PORT = 23373;

/**
 * A loopback port nothing listens on, below Linux's ephemeral range (32768
 * and up), so that no other test's listen(0) or outgoing connection takes it
 * before the server under test binds it; and never Beeper Desktop's.
 */
export const unusedPort = async (): Promise<number> => {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    if (port === BEEPER_DESKTOP_PORT) continue;
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
        .once('error', () => resolve(false))
        .listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
};
