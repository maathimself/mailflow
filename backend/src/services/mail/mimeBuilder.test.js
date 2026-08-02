import { describe, expect, it } from 'vitest';
import {
  bodyToHtml,
  bodyToPlain,
  buildMailOptions,
  renderRaw,
  sigToPlainText,
  textToHtml,
} from './mimeBuilder.js';

describe('mail body helpers', () => {
  it('escapes plain text and preserves line structure in HTML', () => {
    expect(textToHtml('hello & <world>\n')).toBe(
      '<div style="font-family:sans-serif;font-size:14px;line-height:1.6">' +
      '<p style="margin:0">hello &amp; &lt;world&gt;</p><p style="margin:0">&nbsp;</p></div>',
    );
  });

  it('turns signature and HTML bodies into plain text', () => {
    expect(sigToPlainText('<p>Hello <b>there</b></p>')).toBe('Hello there');
    expect(bodyToPlain('<p>Hello <b>there</b></p>', true)).toBe('Hello there');
    expect(bodyToPlain('plain', false)).toBe('plain');
  });

  it('sanitizes HTML compose bodies and converts plain text bodies', () => {
    expect(bodyToHtml('<p>safe</p><script>bad()</script>', true)).toBe('<p>safe</p>');
    expect(bodyToHtml('plain', false)).toContain('<p style="margin:0">plain</p>');
  });
});

describe('buildMailOptions', () => {
  it('owns the complete shared mail header and content shape', () => {
    const attachments = [{ filename: 'a.txt', content: Buffer.from('a') }];
    expect(buildMailOptions({
      messageId: '<id@example.com>',
      fromName: 'Sender',
      fromEmail: 'sender@example.com',
      replyTo: 'reply@example.com',
      to: ['A <a@example.com>'],
      cc: ['c@example.com'],
      bcc: ['b@example.com'],
      subject: ' hello\r\n ',
      priority: 'high',
      text: 'plain body',
      html: '<p>html body</p>',
      inReplyTo: '<parent@example.com>\r\n',
      references: '<root@example.com> <parent@example.com>',
      attachments,
    })).toEqual({
      messageId: '<id@example.com>',
      from: 'Sender <sender@example.com>',
      replyTo: 'reply@example.com',
      to: 'A <a@example.com>',
      cc: 'c@example.com',
      bcc: 'b@example.com',
      subject: 'hello',
      priority: 'high',
      text: 'plain body',
      html: '<p>html body</p>',
      inReplyTo: '<parent@example.com>',
      references: '<root@example.com> <parent@example.com>',
      attachments,
    });
  });

  it('omits empty optional headers and normal priority', () => {
    expect(buildMailOptions({
      messageId: '<id@example.com>',
      fromName: 'Sender',
      fromEmail: 'sender@example.com',
      to: [],
      subject: '',
      priority: 'normal',
      text: '',
    })).toEqual({
      messageId: '<id@example.com>',
      from: 'Sender <sender@example.com>',
      to: undefined,
      cc: undefined,
      bcc: undefined,
      subject: '',
      text: '',
    });
  });
});

describe('renderRaw', () => {
  it('renders a raw MIME buffer without opening a network listener', async () => {
    const raw = await renderRaw(buildMailOptions({
      messageId: '<stable@example.com>',
      fromName: 'Sender',
      fromEmail: 'sender@example.com',
      to: ['recipient@example.com'],
      subject: 'Rendered',
      text: 'hello',
      html: '<p>hello</p>',
    }));

    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(raw.toString()).toContain('Message-ID: <stable@example.com>');
    expect(raw.toString()).toContain('Subject: Rendered');
  });
});
