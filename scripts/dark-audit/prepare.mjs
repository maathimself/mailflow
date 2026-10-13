// Dark-mode audit (#228), step 1 of 3: run each corpus email through the backend's sanitizer, as
// MailFlow stores it, and split off the sender's dark design as the body route does.
//
//   node scripts/dark-audit/prepare.mjs <corpus-dir> [--blocked-images]
//
// --blocked-images serves every email as MailFlow does when remote images are blocked (the
// default): blockRemoteImages after the sanitizer, as the body route applies it. Without it,
// remote images stay in place (the audit still blocks their requests, so they draw nothing).
// A corpus line can also ask for it alone with "blockImages": true (the self-test does).
//
// Reads every *.jsonl in the corpus folder (one email per line: its original HTML part plus
// sender domain, subject and date) and writes prepared.jsonl next to them. The corpus is the
// developer's own mail and stays outside the repo.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeEmail, splitDarkScheme, blockRemoteImages } from '../../backend/src/services/emailSanitizer.js';

export const PREPARED = 'prepared.jsonl';

export function prepareCorpus(dir, { blockedImages = false } = {}) {
  const prepared = [];
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl') && f !== PREPARED).sort();
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const { html: original, blockImages, ...meta } = JSON.parse(line);
      const imagesBlocked = blockedImages || blockImages === true;
      const sanitized = sanitizeEmail(original);
      const { html, darkCss, lightOnly } = splitDarkScheme(imagesBlocked ? blockRemoteImages(sanitized) : sanitized);
      prepared.push({ ...meta, html, darkCss: darkCss || '', lightOnly, imagesBlocked });
    }
  }
  writeFileSync(join(dir, PREPARED), prepared.map(e => JSON.stringify(e)).join('\n') + '\n');
  return prepared;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!dir) { console.error('usage: prepare.mjs <corpus-dir> [--blocked-images]'); process.exit(2); }
  const blockedImages = process.argv.includes('--blocked-images');
  const prepared = prepareCorpus(dir, { blockedImages });
  const withDark = prepared.filter(e => e.darkCss).length;
  const lightOnly = prepared.filter(e => e.lightOnly).length;
  console.log(`${prepared.length} emails prepared${blockedImages ? ' with remote images blocked' : ''}: ${withDark} carry a dark design, ${lightOnly} ask to stay light`);
}
