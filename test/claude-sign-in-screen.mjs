// `claude setup-token`, as the fake host's `claude` shows it (see
// test/fake-host.ts): the sign-in screen, drawn the way Claude Code draws its
// screens (recorded from 2.1.299), so a script reading it must read what the
// screen shows rather than the bytes written to it.
// - Like the real one, it shows nothing without a terminal, and waits.
// - Words are placed by moving the cursor to their columns, not by spaces.
// - The link is an OSC 8 hyperlink, and its text wraps at the terminal's width.
// - The code is read a keypress at a time, unechoed, until Enter.
// - The next screen erases this one, and redraws in any order: each line of
//   the token is written second half first. It wraps at the width too.
// - Having shown the token or an error, it waits, as the real one does for
//   Enter; with `setup-token-exits`, it ends at once instead.
// Flags in the state directory it is given set what it does:
//   setup-token-says    words it fails with before showing any link
//   setup-token-scope   what its link asks for (default user:inference)
//   setup-token-code    the code it takes (default stand-in-code#stand-in-state)
//   setup-token-token   the token it then shows
// It records the code it was given in `setup-token-received`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.argv[2];
const flag = (name, fallback) => {
  const file = join(state, name);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : fallback;
};
const waitForever = () => setInterval(() => undefined, 1 << 30);

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  waitForever();
} else {
  const width = process.stdout.columns;
  let rows = 0;
  const line = (text = '') => {
    process.stdout.write(`${text}\r\n`);
    rows++;
  };
  // Each word placed at its column, the first at `from`.
  const words = (text, from = 2) => {
    let col = from;
    return text
      .split(' ')
      .map((word) => {
        const placed = `\x1b[${col}G${word}`;
        col += word.length + 1;
        return placed;
      })
      .join('');
  };
  // The text as it wraps at the terminal's width, indented by one.
  const wrapped = (text) => text.match(new RegExp(`.{1,${width - 1}}`, 'g')) ?? [];
  const nextScreen = () => {
    process.stdout.write('\x1b[2K\x1b[1A'.repeat(rows) + '\x1b[2K\x1b[G');
    rows = 0;
  };
  const after = () => (flag('setup-token-exits') === undefined ? waitForever() : process.exit(0));

  const says = flag('setup-token-says');
  if (says !== undefined) {
    line(`\x1b[2G\x1b[31m${says}\x1b[39m`);
    process.exit(1);
  }
  const scope = flag('setup-token-scope', 'user:inference');
  const link =
    'https://claude.com/cai/oauth/authorize?code=true&client_id=stand-in&response_type=code' +
    `&redirect_uri=${encodeURIComponent('https://platform.claude.com/oauth/code/callback')}` +
    `&scope=${encodeURIComponent(scope)}&code_challenge=stand-in&code_challenge_method=S256&state=stand-in`;
  process.stdout.write('\x1b[?25l');
  line(`\x1b[31m${words('Welcome to Claude Code', 1)}\x1b[39m`);
  line();
  line(`\x1b[37m${words("Browser didn't open? Use the url below to sign in (c to copy)")}\x1b[39m`);
  line();
  for (const part of wrapped(link)) line(`\x1b]8;id=stand-in;${link}\x07\x1b[2G\x1b[37m${part}\x1b[39m\x1b]8;;\x07`);
  line();
  line(words('Paste code here if prompted >'));

  let code = '';
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (keys) => {
    for (const key of keys) {
      if (key !== '\r') {
        code += key;
        continue;
      }
      process.stdin.removeAllListeners('data');
      writeFileSync(join(state, 'setup-token-received'), code);
      nextScreen();
      if (code !== flag('setup-token-code', 'stand-in-code#stand-in-state')) {
        line(`\x1b[2G\x1b[95mOAuth error: Request failed with status code 400\x1b[39m`);
        line(`\x1b[2G\x1b[97mPress Enter to retry.\x1b[39m`);
        return after();
      }
      line(`\x1b[2G\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m`);
      line();
      line(words('Your OAuth token (valid for 1 year):'));
      line();
      for (const part of wrapped(flag('setup-token-token', 'sk-ant-oat01-StandInToken_0123456789-abcdefghijAA'))) {
        const half = Math.floor(part.length / 2);
        line(`\x1b[${2 + half}G\x1b[33m${part.slice(half)}\x1b[2G${part.slice(0, half)}\x1b[39m`);
      }
      line();
      line(`\x1b[2m${words("Store this token securely. You won't be able to see it again.")}\x1b[22m`);
      return after();
    }
  });
}
