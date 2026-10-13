import { describe, expect, it } from 'vitest';
import { plainText } from '../src/providers/beeper/plain-text.js';

/** Beeper's `text` is Matrix's HTML formatted body when a message has one, else its plain body. */
describe('plainText (Beeper)', () => {
  it('drops markup but keeps the words it wrapped, with no space added inside a word or before its punctuation', () => {
    expect(plainText('Dinner on <b>Fri</b>day<i>?</i>')).toBe('Dinner on Friday?');
  });

  it('leaves out the copy of the message a reply answers', () => {
    const reply =
      '<mx-reply><blockquote><a href="https://matrix.to/#/!room:beeper.com/$event">In reply to</a> ' +
      '<a href="https://matrix.to/#/@bob:beeper.com">Bob</a><br>the old words</blockquote></mx-reply>Sure, see you then';
    expect(plainText(reply)).toBe('Sure, see you then');
  });

  it("ends the reply's copy at its last closing tag, so markup inside the copy can't end it early", () => {
    expect(plainText('<mx-reply>the copy </mx-reply> still the copy</mx-reply>the reply')).toBe('the reply');
  });

  it('drops the rest of the text when a reply copy never closes', () => {
    expect(plainText('<mx-reply>a copy with no end, then the reply')).toBe('');
  });

  it('breaks the line where an element ends one', () => {
    expect(plainText('<p>one</p><p>two</p>three<br/>four<ul><li>five</li></ul>')).toBe('one\n\ntwo\nthree\nfour\n\nfive');
  });

  it('keeps the name in a pill, and only the text of a link, never where it points', () => {
    expect(plainText('<a href="https://matrix.to/#/@michael:beeper.com">Michael</a> are you in?')).toBe('Michael are you in?');
    expect(plainText('see <a href="https://evil.example/login">the menu</a>')).toBe('see the menu');
  });

  it('leaves plain text that only looks like markup alone: only the elements a message can hold count as markup', () => {
    expect(plainText('I <3 you, and 2 < 3 > 1')).toBe('I <3 you, and 2 < 3 > 1');
    expect(plainText('Press <Enter> to go on')).toBe('Press <Enter> to go on');
    expect(plainText('a List<String> of them')).toBe('a List<String> of them');
    expect(plainText('<hugs>')).toBe('<hugs>');
    expect(plainText('if x<y and y>z')).toBe('if x<y and y>z');
    expect(plainText('<B>Loud</B> <Span>and</Span> <MX-REPLY>copy</MX-REPLY>clear')).toBe('Loud and \nclear');
  });

  it("reads a quoted attribute through to its end, though it may hold \">\"", () => {
    expect(plainText('<a href="https://x.example/?a>b" title=\'c>d\'>the menu</a> is up')).toBe('the menu is up');
  });

  it('shows an image as its alt text, as a custom emoji shows its name, and drops comments', () => {
    expect(plainText('nice <img data-mx-emoticon src="mxc://x/y" alt=":partyparrot:" height="32"> one')).toBe('nice :partyparrot: one');
    expect(plainText("<img src='mxc://x/y' alt='a &amp; b'><img src=\"mxc://x/z\">")).toBe('a & b');
    expect(plainText('seen<!-- hidden from the chat -->, thanks')).toBe('seen, thanks');
  });

  it('takes time linear in the text, however its tags are broken', () => {
    const started = Date.now();
    for (const piece of ['<a title="', '<b ', '<img alt=', '<mx-reply>', '</mx-reply>', '<!-- ', '&#']) {
      plainText(piece.repeat(200_000 / piece.length));
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('decodes entities once, so escaped markup stays text', () => {
    expect(plainText('Cy &amp; I can&#39;t &#x1F600; &amp;lt;b&amp;gt; &lt;i&gt;')).toBe("Cy & I can't 😀 &lt;b&gt; <i>");
    expect(plainText('&#99999999; &bogus;')).toBe('&#99999999; &bogus;');
  });
});
