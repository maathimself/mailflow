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
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/ai/chat')) {
    sent.push(JSON.parse(opts.body).messages);
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  return new Response('{}', { status: 200 });
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { useAiActions } = await import('./useAiActions.js');
const { AI_MESSAGE_MAX_CHARS, BUILTIN_SUMMARIZE } = await import('../aiActions.js');
const { getResults } = await import('../aiResults.js');

async function runWith(id, body, action) {
  let hook;
  function Probe() { hook = useAiActions(id, body); return null; }
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

test('an over-limit body is cut, disclosed, and the flag survives a reload', async () => {
  const huge = 'Paragraph text. '.repeat(4000);
  const { content, results } = await runWith('m3', { text: huge }, BUILTIN_SUMMARIZE);
  assert.ok(content.length <= AI_MESSAGE_MAX_CHARS);
  assert.match(content, /\[Only the first \d+ of 64000 characters/);
  assert.equal(results.summarize.truncated.total, 64000);
  assert.deepEqual(getResults('m3').summarize.truncated, results.summarize.truncated);
  // Shown again from the cache: the note comes back with it, no new request.
  const before = sent.length;
  let hook;
  function Probe() { hook = useAiActions('m3', { text: huge }); return null; }
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Probe)));
  assert.equal(hook.results.summarize.truncated.total, 64000);
  await React.act(async () => root.unmount());
  assert.equal(sent.length, before);
});
