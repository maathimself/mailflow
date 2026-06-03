/**
 * i18n locale test — run with: node --test src/locales/i18n.test.js
 *
 * SUITE 1 — key coverage
 *   Every key present in any locale file must exist in all locale files.
 *
 *   Failure example:
 *     ✖ de has no missing keys
 *       Missing keys:
 *         - admin.rules.title
 *
 *   Fix: open de.json, navigate to admin → rules and add the missing key
 *   with a proper translation. Do NOT copy the English value — translate it.
 *   The dotted path admin.rules.title maps to { "admin": { "rules": { "title": "…" } } }.
 *   Create parent sections if they don't exist yet.
 *
 * SUITE 2 — value uniqueness
 *   For each key, every locale must have a distinct translated value.
 *   Two locales sharing the same string usually means one was never translated.
 *
 *   Failure example:
 *     ✖ admin.sso.allowInsecure
 *       Unexpected duplicate values:
 *         de = en: "Allow local / self-signed connections"
 *
 *   Fix A — translate: open de.json and replace the English string with
 *   the German translation.
 *
 *   Fix B — whitelist: if the strings are legitimately identical (see below),
 *   add an entry to SAME_VALUE_ALLOWED:
 *
 *     'some.key': 'any'              // brand name / placeholder, same everywhere
 *     'some.key': [['de', 'en']]     // only this pair may share a value
 *     'some.key': [['en','fr'],      // two independent groups; cross-group
 *                  ['es','it']]      // duplicates would still fail
 *
 * WHEN TO TRANSLATE vs WHITELIST
 *   Translate when the value is a regular word or sentence with a natural
 *   equivalent in the target language.
 *
 *   Whitelist when:
 *   - Brand names / proper nouns (Gmail, iCloud, Outlook)
 *   - Hostnames, URLs, UUID-format placeholders (imap.gmail.com, xxxxxxxx-…)
 *   - Technical abbreviations used internationally (SSO, Cc, Bcc, Port)
 *   - A word spelled identically in both languages: "Spam" (de/en),
 *     "Version" (de/en/fr), "Alias" (es/fr/it), "Archive" (en/fr)
 *   - Two Romance languages sharing the same translation: es+it say "contiene",
 *     es+fr say "De" for "From"
 *
 *   When in doubt, translate. Whitelist only when a translation would produce
 *   the identical string anyway.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

// Keys where identical values across some locales are intentional.
//
// 'any'          — all locales may share this value (brand names, universal placeholders)
// [['a','b',...]]— only these specific language groups may share a value
//
// Two locales sharing a value is only allowed if both appear in the same group.
// Any unlisted pair will still fail.
const SAME_VALUE_ALLOWED = {
  // ── Universal placeholders / brand names (all locales share) ───────────────
  'admin.accounts.imapHostPh':              'any', // imap.gmail.com
  'admin.accounts.presetGmail':             'any', // Gmail
  'admin.accounts.presetIcloud':            'any', // iCloud
  'admin.accounts.presetMicrosoft':         'any', // Outlook
  'admin.accounts.presetYahoo':             'any', // Yahoo Mail
  'admin.accounts.smtpHostPh':              'any', // smtp.gmail.com
  'admin.integrations.microsoft.clientIdPh':'any', // xxxxxxxx-xxxx-…
  'admin.integrations.microsoft.title':     'any', // Microsoft 365 / Outlook.com
  'admin.security.totpVerifyPh':            'any', // 000000
  'admin.sso.issuerUrlPh':                  'any', // https://accounts.google.com
  'admin.sso.scopesPh':                     'any', // openid email profile
  'login.totp.placeholder':                 'any', // 000000

  // ── Specific language groups ───────────────────────────────────────────────
  // "Build backend/frontend" — English tech term adopted in fr and it
  'admin.about.backendBuild':  [['fr', 'it']],
  'admin.about.frontendBuild': [['fr', 'it']],

  // "Version" — same spelling in de, en, fr
  'admin.about.version': [['de', 'en', 'fr']],

  // "Website" — international term, same in de and en
  'admin.about.website': [['de', 'en']],

  // "Alias" — Latin origin, same spelling in es, fr, it
  'admin.accounts.aliases': [['es', 'fr', 'it']],
  'admin.aliases.title':     [['es', 'fr', 'it']],

  // email placeholder — example.com address looks the same in en, ru, zhCN
  'admin.accounts.emailPh':    [['en', 'ru', 'zhCN']],
  'admin.aliases.emailPh':     [['de', 'en', 'ru', 'zhCN']],
  'admin.privacy.addDomainPh': [['de', 'en', 'ru', 'zhCN']],
  'admin.privacy.addSenderPh': [['en', 'ru', 'zhCN']],
  'admin.sso.domainsPh':       [['de', 'en', 'ru', 'zhCN']],
  'admin.users.invitePh':      [['de', 'en', 'ru', 'zhCN']],
  'compose.bccPh':             [['de', 'en', 'ru', 'zhCN']],
  'compose.ccPh':              [['de', 'en', 'ru', 'zhCN']],
  'compose.toPh':              [['en', 'ru', 'zhCN']],

  // "Port" — universal technical term, same in de, en, fr
  'admin.accounts.imapPort':  [['de', 'en', 'fr']],
  'admin.accounts.smtpPort':  [['de', 'en', 'fr']],
  'admin.systemEmail.port':   [['de', 'en', 'fr']],

  // "Signature" (en/fr) and "Firma" (es/it) — two separate legitimate groups
  'admin.accounts.signatureSection': [['en', 'fr'], ['es', 'it']],
  'admin.aliases.signatureSection':  [['en', 'fr'], ['es', 'it']],

  // "Reply-To:" — standardised email header, same in en and ru
  'admin.aliases.replyToLabel': [['en', 'ru']],

  // "Layout" — international term, same in de, en, it
  'admin.appearance.layout': [['de', 'en', 'it']],

  // "Display" — typography term, same in en and it
  'admin.appearance.typographyDisplay': [['en', 'it']],

  // "Mono" — typography abbreviation, same in de, en, es, fr, it
  'admin.appearance.typographyMono': [['de', 'en', 'es', 'fr', 'it']],

  // "Archive" — same spelling in en and fr
  'admin.folderMappings.archive': [['en', 'fr']],

  // "Spam / Junk" — "Spam" is a universal loanword, same in de and en
  'admin.folderMappings.spam': [['de', 'en']],

  // Microsoft Azure portal navigation — kept in English intentionally (en and ru)
  'admin.integrations.microsoft.clientId':     [['en', 'ru']],
  'admin.integrations.microsoft.clientSecret': [['en', 'ru']],
  'admin.integrations.microsoft.step4':        [['en', 'ru']],
  'admin.integrations.microsoft.tenantId':     [['en', 'ru']],

  // "Visita:" — "Visit:" translates identically in es and it (Romance languages)
  'admin.integrations.microsoft.deviceCodeVisit': [['es', 'it']],

  // "Notifications" — same spelling in en and fr
  'admin.notifications.title':  [['en', 'fr']],
  'admin.tabs.notifications':   [['en', 'fr']],

  // "Privacy" — international term, same in en and it
  'admin.privacy.title': [['en', 'it']],
  'admin.tabs.privacy':  [['en', 'it']],

  // "Actions" / "Conditions" — French loanwords, same in en and fr
  'admin.rules.actionsLabel':    [['en', 'fr']],
  'admin.rules.conditionsLabel': [['en', 'fr']],

  // "De" — "From" translates identically in es and fr
  'admin.rules.fieldFrom': [['es', 'fr']],
  'compose.from':          [['es', 'fr']],

  // "contiene" / "Evento" — Romance languages share the same word
  'admin.rules.opContains':          [['es', 'it']],
  'admin.security.activityColEvent': [['es', 'it']],

  // "Status" — same spelling in de and en
  'admin.security.activityColStatus': [['de', 'en']],

  // OAuth terms — en/ru keep English; fr/it share "ID client"
  'admin.sso.clientId':         [['en', 'ru'], ['fr', 'it']],
  'admin.sso.clientIdPh':       [['en', 'ru'], ['fr', 'it']],
  'admin.sso.clientSecretNew':  [['en', 'ru']],
  'admin.sso.clientSecretPhNew':[['en', 'ru']],

  // "Scopes" — OAuth technical term, same in de and en
  'admin.sso.scopes': [['de', 'en']],

  // "Single Sign-On" — international term, same in de, en, it
  'admin.sso.title': [['de', 'en', 'it']],

  // "SSO" — acronym, same in de, en, es, fr, it, ru
  'admin.tabs.sso': [['de', 'en', 'es', 'fr', 'it', 'ru']],

  // "Password" — international term, same in en and it
  'admin.systemEmail.password': [['en', 'it']],
  'login.password':             [['en', 'it']],

  // "Tema" — "Theme" translates identically in es and it
  'admin.tabs.theme': [['es', 'it']],

  // "Admin" — used as-is in de, en, es, fr, it
  'admin.users.adminBadge': [['de', 'en', 'es', 'fr', 'it']],

  // "Error: {{message}}" — "Error" is the same word in en and es
  'common.error': [['en', 'es']],

  // "Cc" / "Bcc" — email header abbreviations used internationally
  'compose.cc':  [['de', 'en', 'es', 'fr', 'it']],
  'compose.bcc': [['de', 'en', 'it']],

  // "{{count}} message(s)" — identical spelling in en and fr
  'thread.messages_one':   [['en', 'fr']],
  'thread.messages_other': [['en', 'fr']],
};

// ── helpers ──────────────────────────────────────────────────────────────────

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      Object.assign(out, flatten(v, path));
    } else {
      out[path] = v;
    }
  }
  return out;
}

function loadLocales() {
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const locales = {};
  for (const file of files) {
    const lang = file.replace('.json', '');
    locales[lang] = flatten(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  }
  return locales;
}

function isAllowedPair(key, lang1, lang2) {
  const rule = SAME_VALUE_ALLOWED[key];
  if (!rule) return false;
  if (rule === 'any') return true;
  return rule.some(group => group.includes(lang1) && group.includes(lang2));
}

// ── tests ─────────────────────────────────────────────────────────────────────

const locales = loadLocales();
const langs = Object.keys(locales).sort();
const allKeys = [...new Set(langs.flatMap(l => Object.keys(locales[l])))].sort();

describe('i18n locale files', () => {

  describe('key coverage — every key must appear in every locale', () => {
    for (const lang of langs) {
      it(`${lang} has no missing keys`, () => {
        const present = new Set(Object.keys(locales[lang]));
        const missing = allKeys.filter(k => !present.has(k));
        assert.equal(missing.length, 0,
          `Missing keys:\n${missing.map(k => `  - ${k}`).join('\n')}`);
      });
    }
  });

  describe('value uniqueness — no unlisted locale pair should share a value for the same key', () => {
    for (const key of allKeys) {
      it(key, () => {
        // group languages by value
        const valueToLangs = new Map();
        for (const lang of langs) {
          const val = locales[lang]?.[key];
          if (val === undefined) continue;
          if (!valueToLangs.has(val)) valueToLangs.set(val, []);
          valueToLangs.get(val).push(lang);
        }

        const violations = [];
        for (const [val, langsWithVal] of valueToLangs) {
          if (langsWithVal.length < 2) continue;
          for (let i = 0; i < langsWithVal.length; i++) {
            for (let j = i + 1; j < langsWithVal.length; j++) {
              const [l1, l2] = [langsWithVal[i], langsWithVal[j]];
              if (!isAllowedPair(key, l1, l2)) {
                violations.push(`  ${l1} = ${l2}: ${JSON.stringify(val)}`);
              }
            }
          }
        }

        assert.equal(violations.length, 0,
          `Unexpected duplicate values (add to SAME_VALUE_ALLOWED if intentional):\n${violations.join('\n')}`);
      });
    }
  });

});
