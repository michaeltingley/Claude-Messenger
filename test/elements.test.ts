import { describe, expect, it } from 'vitest';
import { ownText } from '../src/providers/beeper/own-text.js';
import { plainText } from '../src/providers/beeper/plain-text.js';

/**
 * Beeper's `text` is read two ways: as the chat shows it (`plainText`) and
 * for the sender's own words (`ownText`). Both show each element a
 * message's HTML may hold as the chat lays it out, so where words run
 * together or apart is the same in both. <mx-reply> and <blockquote> hold
 * someone else's words, which each leaves out its own way; their own tests
 * cover those.
 */
describe("a message's markup, read either way", () => {
  const bothRead = (text: string) => [plainText(text), ownText(text)];

  it.each(['a', 'b', 'code', 'del', 'em', 'font', 'i', 'rp', 'rt', 'ruby', 's', 'span', 'strike', 'strong', 'sub', 'sup', 'tbody', 'thead', 'u', 'B'])(
    '<%s> runs on with the words it touches, so a word partly inside it is one word',
    (name) => {
      expect(bothRead(`mail bob<${name}>@claude</${name}>.ai`)).toEqual(['mail bob@claude.ai', 'mail bob@claude.ai']);
    },
  );

  it.each(['caption', 'details', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ol', 'p', 'pre', 'summary', 'table', 'tr', 'ul', 'P'])(
    '<%s> puts what it holds on a line of its own',
    (name) => {
      expect(bothRead(`before<${name}>inside</${name}>after`)).toEqual(['before\ninside\nafter', 'before\ninside\nafter']);
    },
  );

  it.each(['<br>', '<br/>', '<BR />', '<hr>', '<hr/>'])('%s ends a line', (tag) => {
    expect(bothRead(`above${tag}below`)).toEqual(['above\nbelow', 'above\nbelow']);
  });

  it.each(['td', 'th'])('<%s> keeps what it holds apart from the cells beside it, on their line', (name) => {
    expect(bothRead(`before<${name}>inside</${name}>after`)).toEqual(['before inside after', 'before inside after']);
  });

  it('keeps an image apart from the words beside it', () => {
    expect(bothRead('before<img src="mxc://beeper.com/abc">after')).toEqual(['before after', 'before after']);
  });

  it("takes nothing else for markup: the chat shows it as text, and the sender's own words keep it as a space", () => {
    const text = 'mail bob<x>@claude</x>.ai';
    expect(plainText(text)).toBe(text);
    // "<" and ">" keep the words either side apart as text does, and what it holds is never read.
    expect(ownText(text)).toBe('mail bob @claude .ai');
    expect(ownText('<x-note title="@claude do it">ok')).toBe(' ok');
  });
});
