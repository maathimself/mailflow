import { describe, it, expect } from 'vitest';
import { htmlToText } from './htmlToText.js';

describe('htmlToText', () => {
  it('strips tags and leaves plain text unescaped', () => {
    expect(htmlToText('<p>R&amp;D</p>')).toBe('R&D');
    expect(htmlToText('<div>a &lt; b &gt; c</div>')).toBe('a < b > c');
    expect(htmlToText('<p>R&D a < b</p>')).toBe('R&D a < b');
  });

  it('decodes quote, apostrophe, nbsp and numeric entities', () => {
    expect(htmlToText('&quot;q&quot; it&#39;s')).toBe('"q" it\'s');
    expect(htmlToText('x&nbsp;y')).toBe('x y');
    expect(htmlToText('&#169; &#x1F600;')).toBe('© \u{1F600}');
  });

  it('decodes in a single pass so escaped entity text stays literal', () => {
    expect(htmlToText('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });

  it('drops script and style content and returns an empty string for empty input', () => {
    expect(htmlToText('<script>alert(1)</script>ok')).toBe('ok');
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null)).toBe('');
  });
});
