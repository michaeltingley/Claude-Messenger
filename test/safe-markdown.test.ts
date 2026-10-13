import { describe, expect, it } from 'vitest';
import { safeMarkdown } from '../src/assistant/digest/safe-markdown.js';

/**
 * What the owner is shown of the model's words. Every case is a way a link,
 * an address or a number could reach them whole, or a terminal could be
 * handed a command: from GFM's autolinks, CommonMark's links, autolinks,
 * emphasis and raw HTML, the looser linkifiers some apps run, and how a
 * browser reads a domain.
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
        'or (link), or _(link)_, or \\`(link)\\`',
      ].join('\n'),
    );
  });

  it('keeps only the text of a Markdown link or image', () => {
    expect(safeMarkdown('[verify your account](https://evil.example/login) and ![a photo](https://evil.example/p.png)')).toBe(
      'verify your account and a photo',
    );
    expect(safeMarkdown('[https://evil.example/d](https://evil.example/d)')).toBe('(link)');
  });

  it('turns every domain into "(link)", alone or with a path, a business\'s own included, as a linkifier would link it', () => {
    expect(safeMarkdown('see bit.ly/3xYz, paypa1-login.com/verify. or amazon.com?ref=x')).toBe('see (link), (link). or (link)');
    expect(safeMarkdown('**Amazon.com** says your order shipped. Did you see amazon.com?')).toBe(
      '**(link)** says your order shipped. Did you see (link)?',
    );
    expect(safeMarkdown('Pay the fee at usps-redelivery-fee.com today, or log in at 203.0.113.5.')).toBe(
      'Pay the fee at (link) today, or log in at (link).',
    );
    // Wherever it starts: after letters, digits or the dots of an ellipsis too.
    expect(safeMarkdown('Pay at wwww.evil-pay.com, 1www.evil-pay.com, xwww.evil-pay.com or Wait...evil.com/login')).toBe(
      'Pay at (link), (link), (link) or Wait...(link)',
    );
    // A scheme with one slash, or "//" after a digit, starts no URL, but what follows is still a link.
    expect(safeMarkdown('https:/x.com/y or 1//x.com/y')).toBe('https:/(link) or 1//(link)');
    expect(safeMarkdown('http:\\\\evil.com\\login')).toBe('http:\\\\\\\\(link)\\\\login');
    // A hyphen ends a domain, as a linkifier reads it, and those before one are no part of it.
    expect(safeMarkdown('the Amazon.com-branded card, from evil.com-')).toBe('the (link)-branded card, from (link)-');
    expect(safeMarkdown('--evil.com, __evil.com/login, e.g.-evil.com or x--evil.com')).toBe('--(link), __(link), e.g.-(link) or (link)');
  });

  it("leaves a file's name, which ends in no domain's ending, but not one with a path, and words with dots between them", () => {
    expect(safeMarkdown('Node.js, notes.txt, report.pdf? and index.html/x')).toBe('Node.js, notes.txt, report.pdf? and (link)');
    expect(safeMarkdown('Node.js, e.g. Friday, i.e. a.m., U.S., Ph.D., St. Louis, 1.5/day, v1.2.3.4')).toBe(
      'Node.js, e.g. Friday, i.e. a.m., U.S., Ph.D., St. Louis, 1.5/day, v1.2.3.4',
    );
    // A dot inside a word, as code names a field, and a file's name before a hyphen.
    expect(safeMarkdown('user.first_name in a Node.js-based app')).toBe('user.first_name in a Node.js-based app');
  });

  it('turns a domain or an IP address with a port into "(link)" too, and one after anything that ends a URL', () => {
    expect(
      safeMarkdown('bit.ly:443/3xYz, paypal.com:80/verify, evil.example:8080, evil.xn--p1ai/login, ev_il.example/x, 127.0.0.1/login or 10.0.0.1:8080.'),
    ).toBe('(link), (link), (link), (link), (link), (link) or (link).');
    expect(safeMarkdown('v1.2.3 at 7:46 from Amazon.com: 2 items')).toBe('v1.2.3 at 7:46 from (link): 2 items');
  });

  it('reads a domain as a browser does: its ASCII form in any case, a dot after it, and its letters with their marks', () => {
    expect(safeMarkdown('evil.XN--P1AI/login, evil.com./login, evil.example.:8080, evil.com?/login, evil.com#/login')).toBe(
      '(link), (link), (link), (link), (link)',
    );
    expect(safeMarkdown('\u0939\u093f\u0928\u094d\u0926\u0940.com/login and evil.\u092d\u093e\u0930\u0924/login')).toBe('(link) and (link)');
    // Underscores, emphasis and bold around a domain or part of it.
    expect(safeMarkdown('_evil.com_ and **evil**-pay.com')).toBe('_(link)_ and **evil**-(link)');
  });

  it("reads an ideographic full stop between Latin letters as a domain's dot, as a browser does, but not one that ends a sentence", () => {
    expect(safeMarkdown('evil\u3002com/login, evil\uff61com/login and www\u3002evil\u3002com')).toBe('(link), (link) and (link)');
    expect(safeMarkdown('\u3042\u308a\u304c\u3068\u3046\u3002\u660e\u65e5\u306d')).toBe('\u3042\u308a\u304c\u3068\u3046\u3002\u660e\u65e5\u306d');
    expect(safeMarkdown('\u65e5\u672c\u3002evil.com/login')).toBe('\u65e5\u672c\u3002(link)');
  });

  it('turns every email address into "(email address)", however its at sign is written', () => {
    expect(
      safeMarkdown(
        'help@evil.example, <mailto:help@evil.example>, help\uff20evil.example, help\ufe6bevil.example, mailto:help%40evil.example or help@ev_il.example.',
      ),
    ).toBe('(email address), (email address), (email address), (email address), (email address) or (email address).');
  });

  it('reads a fullwidth or other compatibility form as the plain one, so none gets past as something else', () => {
    expect(safeMarkdown('\uff48\uff54\uff54\uff50\uff53\uff1a\uff0f\uff0f\uff45\uff56\uff49\uff4c\uff0e\uff45\uff58\uff41\uff4d\uff50\uff4c\uff45\uff0f\uff4c\uff4f\uff47\uff49\uff4e, \uff14\uff11\uff15-\uff15\uff15\uff15-\uff10\uff11\uff19\uff19, \uff48\uff45\uff4c\uff50\uff20\uff45\uff56\uff49\uff4c\uff0e\uff45\uff58\uff41\uff4d\uff50\uff4c\uff45 and \uff1cb\uff1e')).toBe(
      '(link), (number), (email address) and \\<b>',
    );
    // Before what shows as nothing goes, so none can hide between fullwidth characters.
    expect(safeMarkdown('Call \uff14\uff11\uff15\u200d\uff15\uff15\uff15\u200d\uff10\uff11\uff19\uff19 or see \uff42\uff49\uff54\u200d\uff0e\uff4c\uff59\uff0f\uff13\uff58\uff39\uff5a')).toBe(
      'Call (number) or see (link)',
    );
    // A no-break space, a no-break hyphen and a minus sign look like a space and a hyphen, and a dash groups digits too.
    expect(safeMarkdown('415\u00a0555\u00a00199, 415\u2011555\u20110199, 415\u2212555\u22120199 or 415\u2013555\u20130199')).toBe(
      '(number), (number), (number) or (number)',
    );
    // A symbol a browser reads as letters in a domain is read so too.
    expect(safeMarkdown('evil\u24c2.com/login, evil\u2122.com/login, evil.co\u24c2/login or payp\u0430\ufe00.com/login')).toBe(
      '(link), (link), (link) or (link)',
    );
  });

  it("keeps an emoji's own look, and Korean letters written on their own, though both have a plain form", () => {
    expect(safeMarkdown('\u2139\ufe0f Acme\u2122\ufe0f news \u203c\ufe0f \u{1f22f}')).toBe('\u2139\ufe0f Acme\u2122\ufe0f news \u203c\ufe0f \u{1f22f}');
    // Without the selector that asks for its emoji look, a symbol is read as what it stands for.
    expect(safeMarkdown('Acme\u2122 and \u24c2')).toBe('AcmeTM and M');
    expect(safeMarkdown('\u314b\u314b\u314b \uc88b\uc544\u3160\u3160')).toBe('\u314b\u314b\u314b \uc88b\uc544\u3160\u3160');
  });

  it('turns a phone number into "(number)", however its digits are grouped and whatever digits they are', () => {
    const numbers = [
      '+1 (415) 555-0199', '415-555-0199', '415.555.0199', '1-800-555-0199', '415 - 555 - 0199', '415 \u2013 555 \u2013 0199',
      '(415) 555 - 0199', '4 1 5 5 5 5 0 1 9 9', '4-1-5-5-5-5-0-1-9-9', '4.1.5.5.5.5.0.1.9.9', '415  555  0199', '415/555/0199',
      '415_555_0199', '415\u00b7555\u00b70199', '415\u2022555\u20220199', '415\u2800555\u28000199', '415\u02d7555\u02d70199',
      '415\u2796555\u27960199', '415\u1680555\u16800199', '415*555*0199', '415,555,0199', '+ 44 20 7946 0958', '06 12 34 56 78',
      '98765 43210', '0412 345 678', '555-0199', '\u0664\u0661\u0665-\u0665\u0665\u0665-\u0660\u0661\u0669\u0669',
      '\u096a\u0967\u096b\u096b\u096b\u096b\u0966\u0967\u096f\u096f',
      ['4', '1', '5', '5', '5', '5', '0', '1', '9', '9'].map((digit) => `${digit}\ufe0f\u20e3`).join(''),
      ['4', '1', '5', '5', '5', '5', '0', '1', '9', '9'].map((digit) => `${digit}\u0332`).join(''),
    ];
    for (const number of numbers) expect(safeMarkdown(`Call ${number} now`), number).toBe('Call (number) now');
    // Touching letters, and read in either direction.
    expect(safeMarkdown('Call415-555-0199 or \u8bf7\u62e8\u62534155550199')).toBe('Call(number) or \u8bf7\u62e8\u6253(number)');
    expect(safeMarkdown('Call \u0627 0199 555 415 today')).toBe('Call \u0627 (number) today');
  });

  it('turns an account, card or wallet number, or a code, into "(number)" or "(code)"', () => {
    expect(safeMarkdown('IBAN DE89 3704 0044 0532 0130 00, acct 1234 5678 9012, card 4111 1111 1111 1111 or 4111-1111-1111-1111')).toBe(
      '(code) 00, acct (number), card (number) or (number)',
    );
    expect(safeMarkdown('Your code is 482913, 482 913 or 482-913, or G-48291375.')).toBe(
      'Your code is (number), (number) or (number), or G-(number).',
    );
    expect(safeMarkdown('Send it to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh or 0x71C7656EC7ab88b098defB751B7401B5f6d8976F')).toBe(
      'Send it to (code) or (code)',
    );
    // A long word with no digit, or a long number with no letter, is neither.
    expect(safeMarkdown('Incomprehensibilities, 2026')).toBe('Incomprehensibilities, 2026');
    // Nor can a code or a phone number pass for an amount.
    expect(safeMarkdown('Use 123,456 or $4155550199, not $1,000.4155550199')).toBe('Use (number) or (number), not (number)');
  });

  it('turns a code written in groups, as a recovery key or a product key is, into "(code)", but not words side by side', () => {
    const codes = [
      // A Matrix recovery key, a product key, a gift card's code, an authenticator's key.
      'EsTc 3yST y93F SLpB jJsz eAXc 2XzA ygD3 w69H fGaN TKBj jXEd',
      'VK7JG-NPHTM-C97JM-9MPGT-3V66T',
      '4J8K-9LMN-3PQ7',
      'JBSW Y3DP EHPK 3PXP',
      // Across a line break inside a paragraph, which shows as a space.
      'AB12-CD34\nEF56-GH78',
    ];
    for (const code of codes) expect(safeMarkdown(`Key: ${code}.`), code).toBe('Key: (code).');
    // Words, names and capitals in a row, groups too short to be a code's, and numbers, which are found as numbers.
    const kept = [
      'WhatsApp LinkedIn YouTube', 'Gen2 USB4 ports with 40Gbps', 'RTX4090 GPUs with 24GB VRAM', 'HTTP HTTPS SMTP IMAP',
      'PLEASE CALL BACK SOON', 'XK7-P9Q', 'UA123 SFO-JFK', 'Room 1234 at 5678 Main St',
    ];
    for (const text of kept) expect(safeMarkdown(text), text).toBe(text);
    expect(safeMarkdown('card 4111 1111 1111 1111')).toBe('card (number)');
  });

  it('leaves dates, times, years and amounts, alone, in a span or one after another, and short numbers', () => {
    const kept = [
      'On 2026-10-13 at 7:46 AM, $1,250.00, in 94103, 10/13/2026.', '10/13/2026 7:46 PM', 'Fri 10/17, 7:30 PM', '7:30 - 9:00',
      '7:30-9:00', '2026\u20132027', '2026 \u2013 2027', '10/13 \u2013 10/17', '$1,250,000', '$12.50, $8.75, $3.20', 'Oct 13, 2026',
      '13.10.2026', '(10/13/2026)', '2026-10-13T07:46:00Z', 'rooms 3, 4, 5 and 6', 'Flight 1234 at gate 22', '\u00a530,000 on 10/13',
      '10/13 7:30 \u2013 10/14 9:00',
    ];
    for (const text of kept) expect(safeMarkdown(text), text).toBe(text);
  });

  it('ends a number at a comma and a space, a letter, a line that starts a block, or more signs than group a number', () => {
    expect(safeMarkdown('Call +1 (415) 555-0199, 415-555-0199, 415.555.0199 or 1-800-555-0199.')).toBe(
      'Call (number), (number), (number) or (number).',
    );
    // A line break inside a paragraph shows as a space, so a number across one is one number.
    expect(safeMarkdown('Call 415\n555\n0199 or 415\n   -555-0199.')).toBe('Call (number) or (number).');
    // One before a list's next item, a quote, a heading or a blank line, or after a comma, ends it, as do more signs than a phone number's groups have.
    const apart = [
      '- Order 12345\n- 678 items\n1. Pay 12345\n2. 678 left\nOwe 12345\n  >678 more\nDue 12345\n# 678 more',
      'Got 12345\n\n678, rooms 12345,\n678 up 12.5% \u2192 14.2%',
    ].join('\n');
    expect(safeMarkdown(apart)).toBe(apart);
  });

  it('escapes what could still open a link, an autolink, raw HTML, an entity or a code span', () => {
    // A link with its URL in another form: an autolink a scheme alone opens,
    // a reference to a definition, an entity for its colon, a line break.
    expect(safeMarkdown('<http:evil.example/login> and <b>bold</b>')).toBe('\\<http:(link)> and \\<b>bold\\</b>');
    expect(safeMarkdown('[1]: https&#58;//evil.example\n![p][1] [x](\n//evil.example)')).toBe(
      '\\[1\\]: https\\&#58;(link)\n!\\[p\\]\\[1\\] \\[x\\](\n(link))',
    );
    // A backslash of the model's own is escaped too, so it can't undo an escape.
    expect(safeMarkdown('\\<img src=x onerror=alert(1)> \\[x](//evil.example)')).toBe('\\\\\\<img src=x onerror=alert(1)> \\\\x');
    // A code span would show what is in it whole, whatever splits it.
    expect(safeMarkdown('Go to evil`.`com/login, or run `rm -rf ~`')).toBe('Go to evil\\`.\\`com/login, or run \\`rm -rf ~\\`');
  });

  it('escapes emphasis markers a renderer would drop from inside an address or a number, so it never shows whole', () => {
    expect(safeMarkdown('evi*l.c*om, evil.**com**, **evil**.com, help@**evil**.com, _evil_.com, ev~~il.c~~om')).toBe(
      'evi\\*l.c\\*om, evil.\\*\\*com**, **evil\\*\\*.com, help@\\*\\*evil\\*\\*.com, _evil\\_.com, ev\\~\\~il.c\\~\\~om',
    );
    expect(safeMarkdown('Call 415*555*0199 or mail *help*@evil.com')).toBe('Call (number) or mail *help*@(link)');
  });

  it('leaves the rest of the Markdown as written', () => {
    const digest =
      '**Needs you**\n- **Alice** asked about dinner Friday at 7:30.\n\n**Everything else**\n- _Family_: the cabin is booked by **Mom**.\n- snake_case, 5~10 and **Bob**: done';
    expect(safeMarkdown(digest)).toBe(digest.replace('5~10', '5\\~10'));
  });

  it('drops what shows as nothing between ASCII characters, so nothing invisible can split a number, an address or a link', () => {
    expect(safeMarkdown('Call 415\u200d555\u200d0199, mail help\u200c@evil.example, use 48\ufeff29\u034f13 at bit\u200d\u200d\u200d.ly/3xYz')).toBe(
      'Call (number), mail (email address), use (number) at (link)',
    );
    // Nor once what goes anyway is gone from among them.
    expect(safeMarkdown('4\u200d\u0600\u200d\u0600\u200d82913')).toBe('(number)');
  });

  it('drops what could carry hidden data next to other characters, but keeps what emoji are built with', () => {
    // A run of what shows as nothing, a zero-width no-break space, a variation selector no emoji uses, an unassigned
    // one, and the selectors that choose an emoji's look or a text one, on what is no emoji.
    const zwj = '\u200d\u200c'.repeat(30);
    const selectors = Array.from({ length: 16 }, (_, i) => String.fromCodePoint(0xe0100 + i)).join('');
    expect(safeMarkdown(`\u4e00${zwj}\u4e8c \u65e5\ufeff\u672c \u{1f600}${selectors} payp\u0430\ufe00l \u4e09\u2065\u56db \u0430\ufe0f\u0431\ufe0e`)).toBe(
      '\u4e00\u4e8c \u65e5\u672c \u{1f600} payp\u0430l \u4e09\u56db \u0430\u0431',
    );
    const emoji = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467} 1\ufe0f\u20e3 \u2764\ufe0f \u2764\ufe0f\u200d\u{1f525} \u{1f441}\ufe0f\u200d\u{1f5e8}\ufe0f \u{1f3f3}\ufe0f\u200d\u{1f308} thanks';
    expect(safeMarkdown(emoji)).toBe(emoji);
  });

  it('takes time linear in the text, whatever the text is', () => {
    const pieces = [
      '[', '![', '[a](', 'a.', 'a-', 'a_', '1.', 'a@', 'a.b:', 'www.', '//.', '+1 ', 'a.bc/.', '\u200d', 'a\u3002', 'a\u3002b.',
      '1 - ', '1,', '(1', '$1', '12 ', '1:2', '1\n', '1\n -', '1,\n', 'a*', '*a', 'a.*', 'a_.', 'xn--', '--a', 'a.b?', '\u0301', '\u0301\u0316', 'a\u034f',
      '1\u20e3', '\ufe0f', '\u{e0100}', `${'A'.repeat(19)}1 `, '-', '_', 'Ab1C ', 'Ab1C-Ab1C x ', 'ABCD ',
      // Numbers of dates that each read more than one way, each ending in one that is none.
      `${'10.10 '.repeat(10)}1234, `,
    ];
    const texts = [
      ...pieces.map((piece) => piece.repeat(200_000 / piece.length)),
      // Marks that normalizing would sort, the longer the run the slower.
      `a${'\u0301'.repeat(100_000)}${'\u0316'.repeat(100_000)}`,
      // A run that a domain's label can hold, after a label's start.
      `a${'_'.repeat(200_000)}`,
      // Spaces a number could be split across in many ways, but for a run of them taken whole.
      `1${' '.repeat(3_000)}x`,
    ];
    // Each takes well under a second; a pattern that backtracked over the text would take far longer on any one.
    for (const text of texts) {
      const started = performance.now();
      safeMarkdown(text);
      expect(performance.now() - started, JSON.stringify(text.slice(0, 12))).toBeLessThan(1_000);
    }
  }, 60_000);

  it("drops control and invisible characters, which could hide or reorder words or reach a terminal, but keeps emoji's joiners", () => {
    expect(safeMarkdown('Hi \u001b]52;c;cHduZWQ=\u0007 there\u001b[2J \u202eevil\u202c\u200b, \u{1f468}\u200d\u{1f469}\u200d\u{1f467}\r\n\tok')).toBe(
      'Hi ]52;c;cHduZWQ= there[2J evil, \u{1f468}\u200d\u{1f469}\u200d\u{1f467}\n\tok'.replace(/[[\]]/g, '\\$&'),
    );
    // A carriage return could let a line write over itself in a terminal; it, and every other line break, ends the line.
    expect(safeMarkdown('visible\rhidden, a\u0085b, c\u2028d')).toBe('visible\nhidden, a\nb, c\nd');
  });
});
