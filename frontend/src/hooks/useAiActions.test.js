// What useAiActions sends to /api/ai/chat for a long email, and what it keeps (#633).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, DOMParser: dom.window.DOMParser, IS_REACT_ACT_ENVIRONMENT: true });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const sent = [];
const purposes = [];
let refuse = null; // the refusal code the stubbed server answers with
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/ai/chat')) {
    sent.push(JSON.parse(opts.body).messages);
    purposes.push(JSON.parse(opts.body).purpose);
    if (refuse) return new Response(JSON.stringify({ error: 'Refused by the server.', code: refuse }), { status: 403 });
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  return new Response('{}', { status: 200 });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { useAiActions } = await import('./useAiActions.js');
const { AI_MESSAGE_MAX_CHARS, BUILTIN_SUMMARIZE } = await import('../aiActions.js');
const { getResults } = await import('../aiResults.js');

async function runWith(id, body, action, subject) {
  let hook;
  function Probe() { hook = useAiActions(id, body, subject); return null; }
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Probe)));
  await React.act(async () => { await hook.run(action); });
  await React.act(async () => root.unmount());
  return { content: sent.at(-1)[0].content, results: hook.results };
}

const LONG = 'Synthetic '.repeat(800) + 'TAIL_SENTINEL'; // 8013 chars, far below the limit

test('Summarize sends a long plain-text body whole', async () => {
  const { content, results } = await runWith('m1', { text: LONG }, BUILTIN_SUMMARIZE);
  assert.ok(content.endsWith(`\n\n${LONG}`));
  assert.equal(results.summarize.truncated, null);
});

test('a custom action on an HTML-only body sends it whole', async () => {
  const { content } = await runWith('m2', { html: `<p>${LONG}</p>` }, { id: 'x', label: 'Translate', prompt: 'Translate the complete email.' });
  assert.ok(content.includes('TAIL_SENTINEL'));
});

// #646: the model reads the visible message. Summarize also loses the trailing quoted
// history; a custom action gets the whole mail, CSS aside.
test('an HTML-only body reaches the model without CSS, and only Summarize loses the quoted history', async () => {
  const html = '<style>p{margin:0}</style><p>Can we meet at 10?</p>'
    + '<div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 19, 2026 at 8:27 AM Anna &lt;anna@example.com&gt; wrote:</div>'
    + '<blockquote class="gmail_quote">Earlier in the thread</blockquote></div>';
  const summary = (await runWith('m8', { html }, BUILTIN_SUMMARIZE, 'Re: meeting')).content;
  assert.match(summary, /Can we meet at 10\?/);
  assert.doesNotMatch(summary, /margin|Earlier in the thread/);
  const custom = (await runWith('m9', { html }, { id: 'z', label: 'Translate', prompt: 'Translate it.' }, 'Re: meeting')).content;
  assert.match(custom, /Earlier in the thread/);
  assert.doesNotMatch(custom, /margin/);
});

test('the subject reaches the extraction: an Outlook forward keeps the mail it forwards', async () => {
  const text = 'Please handle this.\n\nFrom: Anna\nSent: Monday, October 19, 2026 10:00 AM\nTo: Bob\n'
    + 'Subject: RE: Invoice 42\n\nInvoice 42 is attached, please pay before Friday.';
  const { content } = await runWith('m10', { text }, BUILTIN_SUMMARIZE, 'FW: RE: Invoice 42');
  assert.match(content, /please pay before Friday/);
});

test('an over-limit body is cut, disclosed, and the flag survives a reload', async () => {
  const huge = 'Paragraph text.'.repeat(4000);
  const { content, results } = await runWith('m3', { text: huge }, BUILTIN_SUMMARIZE);
  assert.ok(content.length <= AI_MESSAGE_MAX_CHARS);
  assert.match(content, /\[Only the first \d+ of 60000 characters/);
  assert.equal(results.summarize.truncated.total, 60000);
  assert.deepEqual(getResults('m3').summarize.truncated, results.summarize.truncated);
  // Shown again from the cache: the note comes back with it, no new request.
  const before = sent.length;
  let hook;
  function Probe() { hook = useAiActions('m3', { text: huge }); return null; }
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Probe)));
  assert.equal(hook.results.summarize.truncated.total, 60000);
  await React.act(async () => root.unmount());
  assert.equal(sent.length, before);
});

// #644: the server checks each request against the admin's switch for its feature. Summaries and
// custom actions both fall under summaries, as the reading pane gates them today.
test('Summarize and custom actions ask for the summarize feature', async () => {
  purposes.length = 0;
  await runWith('m4', { text: 'Hello' }, BUILTIN_SUMMARIZE);
  await runWith('m5', { text: 'Hello' }, { id: 'y', label: 'Translate', prompt: 'Translate it.' });
  assert.deepEqual(purposes, ['summarize', 'summarize']);
});

test('a refusal says which switch is off: the user\'s, or summaries for everyone', async () => {
  try {
    for (const [id, code, key] of [['m6', 'ai_user_disabled', 'message.aiNotAllowed'], ['m7', 'ai_feature_disabled', 'message.aiFeatureOff']]) {
      refuse = code;
      const { results } = await runWith(id, { text: 'Hello' }, BUILTIN_SUMMARIZE);
      assert.equal(results.summarize.status, 'error');
      assert.equal(results.summarize.text, key);
    }
  } finally { refuse = null; }
});
