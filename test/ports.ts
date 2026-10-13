import { createServer } from 'node:net';

/**
 * A loopback port nothing listens on, below Linux's ephemeral range (32768
 * and up), so that no other test's listen(0) or outgoing connection takes it
 * before the server under test binds it.
 */
export const unusedPort = async (): Promise<number> => {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer()
        .once('error', () => resolve(false))
        .listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
};
