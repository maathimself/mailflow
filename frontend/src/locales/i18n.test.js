/**
 * i18n locale test — run with: node --test src/locales/i18n.test.js
 *
 * SUITE 1 — source coverage
 *   Every key in the locale files must be referenced at least once in the
 *   frontend source. Keys with no reference are dead and should be removed.
 *   Fix dead keys before fixing missing translations (Suite 2) — otherwise
 *   you'll add translations for keys that should be deleted.
 *
 *   Failure example:
 *     ✖ no unused keys
 *       Unused keys (remove from all locale files or add a source reference):
 *         - admin.rules.legacyTitle
 *
 *   Fix A — remove: delete the key from every locale file if it is genuinely dead.
 *
 *   Fix B — keep: if the key is referenced dynamically (e.g. via a variable passed
 *   to t()), add it to DYNAMIC_KEYS so the test does not flag it:
 *
 *     const DYNAMIC_KEYS = new Set([
 *       'admin.tabs.accounts',   // t(tab.labelKey) where labelKey is set at runtime
 *     ]);
 *
 *   The test scans for the key string anywhere in *.js / *.jsx files under src/,
 *   excluding the locale files themselves. A key counts as referenced if it
 *   appears literally in the source — even in a comment or property assignment.
 *
 * SUITE 2 — key coverage
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
 * SUITE 3 — value uniqueness
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
 * SUITE 4 — hardcoded user-facing strings
 *   JSX source must not contain user-visible string literals outside of t().
 *   Two patterns are flagged:
 *     A) Attribute values — title="…", placeholder="…", aria-label="…", alt="…"
 *        with a plain string instead of {t('…')}
 *     B) Text nodes — natural-language text between JSX tags not in { }
 *
 *   Failure example:
 *     ✖ no hardcoded user-facing strings
 *       Hardcoded strings found (wrap in t() and add a locale key):
 *         ComposeModal.jsx:1038  title="Minimize"
 *
 *   Fix:
 *     1. Replace the hardcoded value with a t() call:
 *          Before: title="Minimize"
 *          After:  title={t('compose.toolbar.minimize')}
 *     2. Add the key to en.json with the English string.
 *     3. Run the locale tests — Suite 1 will list the other locales that
 *        now need the key. Translate it in each.
 *
 *   If a string is intentionally hardcoded (technical term, placeholder, brand
 *   name) add it to HARDCODED_OK with a short comment explaining why.
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
import { join, dirname, resolve } from 'node:path';
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
  'admin.categories.gtdReveal':             'any', // "GTD" — brand-like acronym, same everywhere
  'admin.accounts.imapHostPh':              'any', // imap.gmail.com
  'admin.accounts.presetGmail':             'any', // Gmail
  'admin.accounts.presetIcloud':            'any', // iCloud
  'admin.accounts.presetYahoo':             'any', // Yahoo Mail
  'admin.accounts.smtpHostPh':              'any', // smtp.gmail.com
  'admin.ai.baseUrlPh':                      'any', // http://localhost:11434/v1
  'admin.appearance.customCssPlaceholder':   'any', // CSS code snippet, same in all locales
  'admin.integrations.microsoft.clientIdPh':'any', // xxxxxxxx-xxxx-…
  'admin.integrations.microsoft.title':     'any', // Microsoft 365 / Outlook.com
  'admin.security.totpVerifyPh':            'any', // 000000
  'admin.sso.adminGroupClaimPh':            'any', // groups
  'admin.sso.adminGroupValuePh':            'any', // mailflow-admins
  'admin.sso.issuerUrlPh':                  'any', // https://accounts.google.com
  'admin.sso.scopesPh':                     'any', // openid email profile
  'login.totp.placeholder':                 'any', // 000000

  // ── Specific language groups ───────────────────────────────────────────────
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

  // "QR code" — same in en and es; de "QR-Code", fr "code QR", it "codice QR", ru "QR-код", zhCN "QR码"
  'admin.security.qrCodeAlt': [['en', 'es']],

  // "Visita:" — "Visit:" translates identically in es and it (Romance languages)
  'admin.integrations.microsoft.deviceCodeVisit': [['es', 'it']],

  // "Notifications" — same spelling in en and fr
  'admin.notifications.title':  [['en', 'fr']],
  'admin.tabs.notifications':   [['en', 'fr']],

  // "Privacy" — international term, same in en and it
  'admin.privacy.title': [['en', 'it']],
  'admin.tabs.privacy':  [['en', 'it']],

  // "Header" — technical email term used as-is in de and en
  'admin.rules.fieldHeader': [['de', 'en']],

  // "Actions" / "Conditions" — French loanwords, same in en and fr
  'admin.rules.actionsLabel':    [['en', 'fr']],
  'admin.rules.conditionsLabel': [['en', 'fr']],

  // "De" — "From" translates identically in es and fr
  'admin.rules.fieldFrom': [['es', 'fr']],
  'compose.from':          [['es', 'fr']],

  // "contiene" / "Evento" / "Manualmente" — Romance languages share the same word
  'admin.rules.opContains':          [['es', 'it']],
  'admin.security.activityColEvent': [['es', 'it']],
  'admin.messageList.markReadManual': [['es', 'it']],

  // "Status" — same spelling in de and en
  'admin.security.activityColStatus': [['de', 'en']],

  // "ID client" — fr and it share the same OAuth term
  'admin.sso.clientId':   [['fr', 'it']],
  'admin.sso.clientIdPh': [['fr', 'it']],

  // "Scopes" — OAuth technical term, same in de and en
  'admin.sso.scopes': [['de', 'en']],

  // "Single Sign-On" — international term, same in de, en, it
  'admin.sso.title': [['de', 'en', 'it']],

  // "SSO" — acronym, same in de, en, es, fr, it, ru
  'admin.tabs.sso': [['de', 'en', 'es', 'fr', 'it', 'ru']],

  // "Password" — international term, same in en and it
  'admin.systemEmail.password':      [['en', 'it']],
  'login.password':                  [['en', 'it']],
  'lockScreen.passwordPlaceholder':  [['en', 'it']],

  // "Tema" — "Theme" translates identically in es and it
  'admin.tabs.theme': [['es', 'it']],

  // "Administration" — same spelling in de, en, fr
  'admin.tabs.groupAdmin': [['de', 'en', 'fr']],

  // "Admin" — used as-is in de, en, es, fr, it
  'admin.users.adminBadge': [['de', 'en', 'es', 'fr', 'it']],

  // "Error: {{message}}" — "Error" is the same word in en and es
  'common.error': [['en', 'es']],

  // "Cc" / "Bcc" — email header abbreviations used internationally
  'compose.cc':  [['de', 'en', 'es', 'fr', 'it']],
  'compose.bcc': [['de', 'en', 'it']],

  // "Normal" — loanword, same spelling in de, en, es, fr
  'compose.priorityNormal': [['de', 'en', 'es', 'fr']],

  // "{{count}} message(s)" — identical spelling in en and fr
  'thread.messages_one':   [['en', 'fr']],
  'thread.messages_other': [['en', 'fr']],

  // ── Contacts ───────────────────────────────────────────────────────────────
  // "auto" — universal technical loanword, same in all locales
  'contacts.auto': 'any',
  // "contacts" — same word in English and French
  'contacts.count': [['en', 'fr']],
  'contacts.title': [['en', 'fr']],
  // "Email" — international term used as-is in en, es, it, ru, zhCN
  'contacts.fields.email': [['en', 'es', 'it', 'ru', 'zhCN']],
  // "Notes" — same spelling in English and French
  'contacts.fields.notes': [['en', 'fr']],
  // "Organisation" — same spelling in German and French
  'contacts.fields.organization': [['de', 'fr']],
  // "Casa" — Spanish and Italian share the same word for "home"
  'contacts.emailTypes.home': [['es', 'it']],
  'contacts.phoneTypes.home': [['es', 'it']],
  // "Mobile" — same spelling in English, French, and Italian
  'contacts.phoneTypes.mobile': [['en', 'fr', 'it']],

  // ── MFA / 2FA ─────────────────────────────────────────────────────────────
  // "Optional" — same spelling in de and en
  'admin.security.mfaEnforcementOff': [['de', 'en']],
  // "Permanent" — same in en and fr; "Permanente" same in es and it
  'admin.security.mfaDeviceTrustForever': [['en', 'fr'], ['es', 'it']],
  // email placeholder — en and ru share same format
  'admin.security.recoveryEmailPh': [['en', 'ru', 'zhCN']],

  // ── Email categorization ───────────────────────────────────────────────────
  // URL placeholder — identical in all locales
  'admin.categories.urlSubPh': 'any',
  // "Primary" — "Principal" in both es and fr
  'messageList.categories.primary': [['es', 'fr']],
  // "Newsletter(s)" — en and fr both use "Newsletters"; de and it both use "Newsletter"
  'messageList.categories.newsletter': [['en', 'fr'], ['de', 'it']],
  // "Promotions" — same spelling in en and fr
  'messageList.categories.promotion': [['en', 'fr']],
  // "Social" — international term used as-is in en, es, and it
  'messageList.categories.social': [['en', 'es', 'it']],

  // ── GTD ────────────────────────────────────────────────────────────────────
  // "GTD" — acronym (Getting Things Done), same in every locale
  'gtd.title': 'any',

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  // "GTD" — acronym group heading, same in every locale (like admin.categories.gtdReveal)
  'shortcuts.groups.gtd': 'any',
  // "Navigation" — spelled identically in de, en, fr (es "Navegación", it "Navigazione")
  'shortcuts.groups.navigation': [['de', 'en', 'fr']],

  // ── Todoist integration ────────────────────────────────────────────────────
  // "Todoist" — brand name, same in all locales
  'admin.integrations.todoist.title': 'any',
  // "Beta" — same spelling in de, en, es, it; fr uses "Bêta", ru uses "Бета", zh uses "测试版"
  'todoist.betaLabel': [['de', 'en', 'es', 'it']],
  // "Description" — same spelling in en and fr
  'todoist.description': [['en', 'fr']],
  // "Labels" — international loanword, same in de and en
  'todoist.labels': [['de', 'en']],
  // "Urgent" — same in en and fr; "Urgente" same in es and it (Romance languages)
  'todoist.priorityUrgent': [['en', 'fr'], ['es', 'it']],
  // "Alta" — "High" translates identically in es and it (Romance languages)
  'todoist.priorityHigh': [['es', 'it']],
  // "Media" — "Medium" translates identically in es and it (Romance languages)
  'todoist.priorityMedium': [['es', 'it']],
};

// Keys referenced dynamically (via a variable passed to t()) that cannot be
// found by a plain text search of the source. Add here to suppress false
// "unused key" failures.
const DYNAMIC_KEYS = new Set([
  // t(tab.labelKey) — labelKey is a string property set in the TABS array
  'admin.tabs.accounts',
  'admin.tabs.rules',
  'admin.tabs.appearance',
  'admin.tabs.integrations',
  'admin.tabs.users',
  'admin.tabs.sso',
  'admin.tabs.security',
  'admin.tabs.notifications',
  'admin.tabs.shortcuts',
  'admin.tabs.about',
  'admin.tabs.categories',
  // t(group.labelKey) — labelKey is a string property set in the TAB_GROUPS array
  'admin.tabs.groupAccountMail',
  'admin.tabs.groupDisplay',
  'admin.tabs.groupSecurityIntegrations',
  'admin.tabs.groupAdmin',
  // t(`messageList.categories.${cat}`) — category tab labels referenced via template literal
  'messageList.categories.primary',
  'messageList.categories.newsletter',
  'messageList.categories.promotion',
  'messageList.categories.automated',
  'messageList.categories.social',
  // t(`gtd.state.${state}`) — GTD state labels referenced via template literal for
  // the merged-Waiting kind chip and the classify submenu (watch/delegated never
  // appear as literals; the other three do via the tab pills).
  'gtd.state.watch',
  'gtd.state.delegated',
]);

// JSX attribute names whose values must never be plain strings — always t().
const I18N_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

// Plain strings that are intentionally NOT translated (technical terms,
// brand names, format placeholders). Add with a comment explaining why.
const HARDCODED_OK = new Set([
  // CSS/DOM placeholder for a variable-name input field — not a sentence
  'value',
  // Tooltip label for a rich-text editor colour input — purely visual affordance,
  // identical concept in all languages
  'Emoji',
  // "MailFlow" brand name split into two spans for typography styling
  'Mail', 'Flow',
  // Email header labels inside the handlePrint() HTML template literal —
  // translating them requires passing t() results into the template string
  'From:', 'Date:',
  // Standard email forwarding header used internationally (RFC convention)
  '---------- Forwarded message ----------',
  // Search-syntax example shown inside a <code> tag — demonstrating format, not UI text
  'from:amazon invoice',
  // Beta badge label — universally understood technical term, same in all languages
  'BETA',
]);

// Matches: someAttr="string value" (not someAttr={...})
const attrStringRe = new RegExp(
  String.raw`\b(${I18N_ATTRS.join('|')})="([^"]+)"`, 'g'
);

// Matches text directly between a closing > and an opening </ on the same line,
// (i.e. a JSX text node immediately before a closing tag). Using </ rather than <
// avoids false positives from JS arrow functions (=>) and comparison operators (<=).
const textNodeRe = />([^<>{}]+)<\//g;

function looksLikeUserText(str) {
  const s = str.trim();
  if (s.length < 4) return false;
  if (!/[a-zA-Z]/.test(s)) return false;
  if (/^https?:\/\//.test(s)) return false;         // URL
  if (/^[a-z][a-z0-9_-]*$/.test(s)) return false;  // all-lowercase identifier
  if (/^\d/.test(s)) return false;                   // starts with digit
  if (/[()]/.test(s)) return false;                  // parenthesised (SMTP options, JS calls)
  if (/\|\||&&/.test(s)) return false;               // JS logical operators
  // flag if multiword OR starts with uppercase (sentence / proper label)
  return s.includes(' ') || /^[A-Z]/.test(s);
}

function scanHardcodedStrings() {
  const srcRoot = resolve(dir, '../..');
  const violations = [];

  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (full === dir) continue; // skip locales/
        walk(full);
      } else if (entry.name.endsWith('.jsx')) {
        const lines = readFileSync(full, 'utf8').split('\n');
        const rel = full.replace(srcRoot + '/', '');
        lines.forEach((line, i) => {
          const stripped = line.replace(/^\s*\/\/.*$/, ''); // skip full-line comments

          // A) JSX attribute values
          for (const m of stripped.matchAll(attrStringRe)) {
            const val = m[2];
            if (looksLikeUserText(val) && !HARDCODED_OK.has(val)) {
              violations.push(`  ${rel}:${i + 1}  ${m[1]}="${val}"`);
            }
          }

          // B) JSX text nodes
          for (const m of stripped.matchAll(textNodeRe)) {
            const val = m[1].trim();
            if (looksLikeUserText(val) && !HARDCODED_OK.has(val)) {
              violations.push(`  ${rel}:${i + 1}  text: "${val}"`);
            }
          }
        });
      }
    }
  }
  walk(srcRoot);
  return violations;
}

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

// i18next resolves t('base', { count }) to base_one / base_other at runtime.
// Strip known plural suffixes before searching — if the base key is in the
// source the plural form is considered referenced.
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
function baseKey(key) {
  for (const s of PLURAL_SUFFIXES) {
    if (key.endsWith(s)) return key.slice(0, -s.length);
  }
  return key;
}

function loadSourceText() {
  const srcRoot = resolve(dir, '../..');
  const out = [];
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (full === dir) continue; // skip locales/
        walk(full);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) {
        out.push(readFileSync(full, 'utf8'));
      }
    }
  }
  walk(srcRoot);
  return out.join('\n');
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

  describe('source coverage — every key must be referenced in the source', () => {
    it('no unused keys', () => {
      const source = loadSourceText();
      const unused = allKeys.filter(k => !DYNAMIC_KEYS.has(k) && !source.includes(baseKey(k)));
      assert.equal(unused.length, 0,
        `Unused keys (remove from all locale files or add to DYNAMIC_KEYS if referenced dynamically):\n${unused.map(k => `  - ${k}`).join('\n')}`);
    });
  });

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

  describe('hardcoded strings — user-visible text must go through t()', () => {
    it('no hardcoded user-facing strings', () => {
      const violations = scanHardcodedStrings();
      assert.equal(violations.length, 0,
        `Hardcoded strings found (wrap in t() and add a locale key, or add to HARDCODED_OK if intentional):\n${violations.join('\n')}`);
    });
  });

});
