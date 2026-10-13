import { describe, expect, it } from 'vitest';
import { safeMarkdown } from '../src/assistant/digest/safe-markdown.js';

/**
 * What the owner is shown of the model's words. Every case is a way a link
 * could reach them clickable, or a terminal could be handed a command: from
 * GFM's autolinks, CommonMark's links, autolinks and raw HTML, and the
 * looser linkifiers some apps run.
 */
describe('safeMarkdown', () => {
  it('turns every URL into "(link)", ending it before the punctuation that ends its sentence', () => {
    expect(
      safeMarkdown(
        [
          'verify at https://evil.example/a?b=c, or <https://evil.example/b>, or www.evil.example/c.',
          'see **ftp://evil.example/e** or (sftp://evil.example/f), or tracking:https://evil.example/g!',
          'or //evil.example/h, or _www.evil.example_, or `https://evil.example/i`',
        ].join('\n'),
      ),
    ).toBe(
      [
        'verify at (link), or (link), or (link).',
        'see **(link)** or ((link)), or tracking:(link)!',
        'or (link), or _(link)_, or `(link)`',
      ].join('\n'),
    );
  });

  it('keeps only the text of a Markdown link or image', () => {
    expect(safeMarkdown('[verify your account](https://evil.example/login) and ![a photo](https://evil.example/p.png)')).toBe(
      'verify your account and a photo',
    );
    expect(safeMarkdown('[https://evil.example/d](https://evil.example/d)')).toBe('(link)');
  });

  it('turns a domain with a path into "(link)", but leaves a bare domain, as in a name, as it is', () => {
    expect(safeMarkdown('see bit.ly/3xYz, paypa1-login.com/verify. or amazon.com?ref=x')).toBe('see (link), (link). or (link)');
    expect(safeMarkdown('**Amazon.com** says your order shipped. Did you see amazon.com?')).toBe(
      '**Amazon.com** says your order shipped. Did you see amazon.com?',
    );
    expect(safeMarkdown('Node.js, e.g. Friday, i.e. a.m., U.S., Ph.D., St. Louis, 1.5/day')).toBe(
      'Node.js, e.g. Friday, i.e. a.m., U.S., Ph.D., St. Louis, 1.5/day',
    );
  });

  it('turns a domain or an IP address with a port into "(link)" too, and one after anything that ends a URL', () => {
    expect(
      safeMarkdown('bit.ly:443/3xYz, paypal.com:80/verify, evil.example:8080, evil.xn--p1ai/login, ev_il.example/x, 127.0.0.1/login or 10.0.0.1:8080.'),
    ).toBe('(link), (link), (link), (link), (link), (link) or (link).');
    // A scheme with one slash, or "//" after a digit, starts no URL, but what follows is still a link.
    expect(safeMarkdown('https:/x.com/y or 1//x.com/y')).toBe('https:/(link) or 1//(link)');
    expect(safeMarkdown('v1.2.3 at 7:46 from Amazon.com: 2 items')).toBe('v1.2.3 at 7:46 from Amazon.com: 2 items');
  });

  it('turns every email address into "(email address)", however its at sign is written', () => {
    expect(
      safeMarkdown(
        'help@evil.example, <mailto:help@evil.example>, help＠evil.example, help﹫evil.example, mailto:help%40evil.example or help@ev_il.example.',
      ),
    ).toBe('(email address), (email address), (email address), (email address), (email address) or (email address).');
  });

  it('reads a fullwidth or other compatibility form as the plain one, so none gets past as something else', () => {
    expect(safeMarkdown('ｈｔｔｐｓ：／／ｅｖｉｌ．ｅｘａｍｐｌｅ／ｌｏｇｉｎ, ４１５-５５５-０１９９, ｈｅｌｐ＠ｅｖｉｌ．ｅｘａｍｐｌｅ and ＜b＞')).toBe(
      '(link), (number), (email address) and \\<b>',
    );
    // An emoji keeps its own form, though some have a plain one.
    expect(safeMarkdown('ℹ️ Acme™ news ‼️')).toBe('ℹ️ Acme™ news ‼️');
    // A no-break space and a no-break hyphen look like a space and a hyphen, and a dash groups digits too.
    expect(safeMarkdown('415\u00a0555\u00a00199, 415\u2011555\u20110199 or 415–555–0199')).toBe('(number), (number) or (number)');
  });

  it('turns phone numbers and codes into "(number)", leaving dates, times, years and amounts', () => {
    expect(safeMarkdown('Call +1 (415) 555-0199, 415-555-0199, 415.555.0199 or 1-800-555-0199.')).toBe(
      'Call (number), (number), (number) or (number).',
    );
    expect(safeMarkdown('Your code is 482913, or G-48291375.')).toBe('Your code is (number), or G-(number).');
    expect(safeMarkdown('On 2026-10-13 at 7:46 AM, $1,250.00, in 94103, 10/13/2026.')).toBe(
      'On 2026-10-13 at 7:46 AM, $1,250.00, in 94103, 10/13/2026.',
    );
  });

  it('escapes what could still open a link, an autolink, raw HTML or an entity', () => {
    // A link with its URL in another form: an autolink a scheme alone opens,
    // a reference to a definition, an entity for its colon, a line break.
    expect(safeMarkdown('<http:evil.example/login> and <b>bold</b>')).toBe('\\<http:(link)> and \\<b>bold\\</b>');
    expect(safeMarkdown('[1]: https&#58;//evil.example\n![p][1] [x](\n//evil.example)')).toBe(
      '\\[1\\]: https\\&#58;(link)\n!\\[p\\]\\[1\\] \\[x\\](\n(link))',
    );
    // A backslash of the model's own is escaped too, so it can't undo an escape.
    expect(safeMarkdown('\\<img src=x onerror=alert(1)> \\[x](//evil.example)')).toBe('\\\\\\<img src=x onerror=alert(1)> \\\\x');
  });

  it('leaves the rest of the Markdown as written', () => {
    const digest = '**Needs you**\n- **Alice** asked about dinner Friday at 7:30.\n\n**Everything else**\n- _Family_: the cabin is booked.';
    expect(safeMarkdown(digest)).toBe(digest);
  });

  it('drops what shows as nothing between ASCII characters, so nothing invisible can split a number, an address or a link', () => {
    expect(safeMarkdown('Call 415\u200d555\u200d0199, mail help\u200c@evil.example, use 48\ufeff29\u034f13 at bit\u200d\u200d\u200d.ly/3xYz')).toBe(
      'Call (number), mail (email address), use (number) at (link)',
    );
    // Nor once what goes anyway is gone from among them.
    expect(safeMarkdown('4\u200d\u0600\u200d\u0600\u200d82913')).toBe('(number)');
    // Emoji keep theirs, next to ASCII or not.
    const emoji = '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 1\ufe0f\u20e3 \u2764\ufe0f thanks';
    expect(safeMarkdown(emoji)).toBe(emoji);
  });

  it('takes time linear in the text, whatever the text is', () => {
    const started = Date.now();
    for (const piece of ['[', '![', '[a](', 'a.', 'a-', 'a_', '1.', 'a@', 'a.b:', 'www.', '//.', '+1 ', 'a.bc/.', '\u200d']) {
      safeMarkdown(piece.repeat(100_000 / piece.length));
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("drops control and invisible characters, which could hide or reorder words or reach a terminal, but keeps emoji's joiners", () => {
    expect(safeMarkdown('Hi \u001b]52;c;cHduZWQ=\u0007 there\u001b[2J \u202eevil\u202c\u200b, \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\r\n\tok')).toBe(
      'Hi ]52;c;cHduZWQ= there[2J evil, \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\r\n\tok'.replace(/[[\]]/g, '\\$&'),
    );
  });
});
