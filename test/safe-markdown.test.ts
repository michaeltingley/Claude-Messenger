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

  it('turns every email address into "(email address)", however its at sign is written', () => {
    expect(
      safeMarkdown('help@evil.example, <mailto:help@evil.example>, help＠evil.example, help﹫evil.example or mailto:help%40evil.example.'),
    ).toBe('(email address), (email address), (email address), (email address) or (email address).');
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

  it("drops control and invisible characters, which could hide or reorder words or reach a terminal, but keeps emoji's joiners", () => {
    expect(safeMarkdown('Hi \u001b]52;c;cHduZWQ=\u0007 there\u001b[2J \u202eevil\u202c\u200b, \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\r\n\tok')).toBe(
      'Hi ]52;c;cHduZWQ= there[2J evil, \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\r\n\tok'.replace(/[[\]]/g, '\\$&'),
    );
  });
});
