import { describe, it, expect } from 'vitest';
import { buildSnippetFromHtml, parseMessage, snippetFromBody } from './messageParser.js';

// Timing assertions use the fastest of a few runs so GC pauses and cold-JIT
// noise cannot flake CI; an accidental return to quadratic scanning is
// orders of magnitude over these thresholds (minutes, not milliseconds).
function fastestRunMs(fn, runs) {
  let fastest = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

describe('buildSnippetFromHtml', () => {
  it('drops CSS from an unclosed style block inside the document head', () => {
    const html = '<html><head><style>body{max-width:740px}h1{font-size:30px;color:#000}<title>Newsletter</head><body><p>Hello</p></body></html>';
    expect(buildSnippetFromHtml(html)).toBe('Hello');
  });

  it('strips a tag when an attribute contains a greater-than sign', () => {
    const html = '<p style="height:0;margin:0;"><img alt=\'Track Resource\' src="https://example.com/track?a=1>2" /></p><p>Real content here</p>';
    expect(buildSnippetFromHtml(html)).toBe('Real content here');
  });

  it('drops script contents when the block never closes', () => {
    const html = '<p>Visible content</p><script>window.track("<p>hidden marker</p>");';
    expect(buildSnippetFromHtml(html)).toBe('Visible content');
  });

  it('drops HTML comment contents when the comment never closes', () => {
    const html = '<p>Visible content</p><!-- hidden <b>comment marker</b>';
    expect(buildSnippetFromHtml(html)).toBe('Visible content');
  });

  it('drops a dangling tag-open fragment', () => {
    const html = '<p>Visible content</p><img alt="tracking pixel"';
    expect(buildSnippetFromHtml(html)).toBe('Visible content');
  });

  it('strips ordinary HTML tags', () => {
    const html = '<section><p>Hello <strong>ordinary</strong> markup</p><br></section>';
    expect(buildSnippetFromHtml(html)).toBe('Hello ordinary markup');
  });

  it('decodes HTML entities after stripping markup', () => {
    const html = '<p>Fish &amp; chips&nbsp;&hellip; &#x2014; &#169; &quot;yes&quot; &apos;ok&apos; &lt;done&gt;</p>';
    expect(buildSnippetFromHtml(html)).toBe('Fish & chips … — © "yes" \'ok\' <done>');
  });

  it('drops closed HTML comments with their contents', () => {
    const html = '<p>Before</p><!-- hidden production marker --><p>After</p>';
    expect(buildSnippetFromHtml(html)).toBe('Before After');
  });

  it('drops a decorative divider run from visible HTML text', () => {
    const html = '<p>========================================</p><p>Visible content</p>';
    expect(buildSnippetFromHtml(html)).toBe('Visible content');
  });

  it('keeps a bare less-than sign in prose that never closes as a tag', () => {
    const html = 'checking that 5 < 10 still reads as prose';
    expect(buildSnippetFromHtml(html)).toBe(html);
  });

  it('finishes a ~300KB body full of bare less-than signs well under 50ms', () => {
    const html = 'a < b and c '.repeat(25000);
    expect(buildSnippetFromHtml(html)).toContain('a < b and c');
    expect(fastestRunMs(() => buildSnippetFromHtml(html), 3)).toBeLessThan(50);
  });

  it('stays linear on crafted ~300KB tag-heavy bodies', () => {
    // Dangling opens, unpaired quotes, and quoted '>' runs are the shapes
    // that force a backtracking tag matcher to rescan the whole tail.
    const danglingOpens = '<a '.repeat(100000);
    const unpairedQuotes = ('<a"x ').repeat(60000);
    const quotedGtRuns = ('<"' + '>'.repeat(10) + '"').repeat(23000);
    expect(fastestRunMs(() => {
      buildSnippetFromHtml(danglingOpens);
      buildSnippetFromHtml(unpairedQuotes);
      buildSnippetFromHtml(quotedGtRuns);
    }, 2)).toBeLessThan(500);
  });
});

describe('snippetFromBody', () => {
  it('keeps a plain-text digest with divider rule lines clean', () => {
    const text = '***************\r\nWeekly Digest\r\n***************\r\n\r\n-----\r\nPosts\r\n-----\r\n\r\nWhat it takes to launch a new product this year\r\n\r\nWe were just about...';
    expect(snippetFromBody(text)).toBe("Weekly Digest Posts What it takes to launch a new product this year We were just about...");
  });

  it('drops bare CSS rule blocks while keeping the visible text', () => {
    const text = 'body{max-width:740px}h1{font-size:30px;color:#000}\n\nWelcome to our newsletter, here is what is new this week.';
    expect(snippetFromBody(text)).toBe('Welcome to our newsletter, here is what is new this week.');
  });

  it('routes an attribute-carrying HTML fragment through the HTML stripper', () => {
    const text = '<p style="height:0;margin:0;"><img alt="Track" src="https://example.com/pixel.gif"></p>\nThanks for your order, it is on its way.';
    expect(snippetFromBody(text)).toBe('Thanks for your order, it is on its way.');
  });

  it('routes a standalone style block through the HTML stripper', () => {
    const text = '<style>body{max-width:740px}</style>Actual content here';
    expect(snippetFromBody(text)).toBe('Actual content here');
  });

  it('keeps prose braces without CSS declaration separators byte-identical', () => {
    const text = 'The set is defined as {1, 2, 3} for this example.';
    expect(snippetFromBody(text)).toBe(text);
  });

  it('keeps an attribute-less HTML tag mentioned in prose byte-identical', () => {
    const text = 'Use the <b> tag for bold; multiply with 2 * 3 and keep snake_case names';
    expect(snippetFromBody(text)).toBe(text);
  });

  it('strips stray closing tags and HTML comments without an HTML fallback', () => {
    const text = 'Before</b> middle <!-- hidden marker -->after';
    expect(snippetFromBody(text)).toBe('Before middle after');
  });

  it('drops a leading decorative divider run', () => {
    const text = '======================================== Learn more about our product and how it can help you save time.';
    expect(snippetFromBody(text)).toBe('Learn more about our product and how it can help you save time.');
  });

  it('keeps two-character signature delimiters and three-character Markdown rules', () => {
    const text = 'Message complete -- Signature follows --- Markdown rule';
    expect(snippetFromBody(text)).toBe(text);
  });

  it('keeps ordinary plain text byte-identical', () => {
    const text = 'Your report is ready for review at 3:00 PM.';
    expect(snippetFromBody(text)).toBe(text);
  });

  it('strips a mid-prose CSS block together with its preceding selector run', () => {
    const text = 'Trouble viewing this email? .preheader { display: none; } Read the highlights below.';
    expect(snippetFromBody(text)).toBe('Read the highlights below.');
  });

  it('finishes a ~200KB brace-free body well under 50ms', () => {
    const text = 'newsletter content with plenty of ordinary prose words here '.repeat(3400);
    const snippet = snippetFromBody(text);
    expect(snippet).toHaveLength(200);
    expect(text.startsWith(snippet)).toBe(true);
    expect(fastestRunMs(() => snippetFromBody(text), 3)).toBeLessThan(50);
  });

  it('stays linear on crafted ~300KB brace-bearing bodies', () => {
    // A lone brace defeats a bare includes() gate; separator runs defeat a
    // bounded scan that still backtracks through the declaration content.
    const loneBrace = 'x{' + 'ordinary prose words here '.repeat(12000);
    const separatorRuns = ('a{' + ';'.repeat(6000)).repeat(50);
    expect(fastestRunMs(() => {
      snippetFromBody(loneBrace);
      snippetFromBody(separatorRuns);
    }, 2)).toBeLessThan(500);
  });
});

describe('parseMessage', () => {
  it('prefers the HTML sibling when a text/plain part is degenerate', async () => {
    const text = ' ()\r\n\r\nRelink to \r\n\r\nWe stopped importing transactions from  because we lost connection! To fix this we need you to go through the process of relinking to ?</b> Simply reply...\r\n\r\n<!-- Action -->\r\nGo to my accounts';
    const html = '<html><body><h1>Relink to Examplebank (Canada)</h1><p>Reconnect your account.</p></body></html>';
    const parsed = await parseMessage({
      uid: 1,
      envelope: { subject: 'Relink account', from: [{ name: 'Budget App', address: 'support@budget.example' }] },
      flags: new Set(),
      bodyStructure: {
        type: 'multipart/alternative',
        childNodes: [
          { type: 'text/plain', part: '1.1', encoding: '7bit', parameters: { charset: 'utf-8' } },
          { type: 'text/html', part: '1.2', encoding: '7bit', parameters: { charset: 'utf-8' } },
        ],
      },
      bodyParts: new Map([
        ['1.1', Buffer.from(text)],
        ['1.2', Buffer.from(html)],
      ]),
    });

    expect(parsed.snippet).toContain('Relink to Examplebank (Canada)');
    expect(parsed.snippet).not.toContain('</b>');
    expect(parsed.snippet).not.toContain('<!--');
  });
});
