# i18n test guide

## Running the test

```bash
cd frontend
node --test src/locales/i18n.test.js
```

---

## What the test checks

Two things:

1. **Key coverage** — every translation key present in any locale file must exist in all locale files. A key that only exists in `en.json` but not `de.json` is a bug.

2. **Value uniqueness** — for each key, every locale should have a distinct translated value. If two locales share the same string for the same key it usually means one of them was never translated. Exceptions (brand names, borrowed words, etc.) are explicitly listed in `SAME_VALUE_ALLOWED` inside `i18n.test.js`.

---

## Failure type 1 — missing keys

```
✖ de has no missing keys
  AssertionError: Missing keys:
    - admin.rules.title
    - admin.rules.newButton
```

`de.json` is missing keys that exist in other locales. This happens when a new feature adds strings to `en.json` without updating the other locale files.

**Fix:** open each failing locale file and add the missing keys with a proper translation. Do not copy the English value — translate it.

The JSON files are nested objects. The dotted path `admin.rules.title` maps to:

```json
{
  "admin": {
    "rules": {
      "title": "translation here"
    }
  }
}
```

If the parent section doesn't exist yet in the file, create it. Run the test after each file to confirm.

---

## Failure type 2 — duplicate values

```
✖ admin.sso.allowInsecure
  AssertionError: Unexpected duplicate values (add to SAME_VALUE_ALLOWED if intentional):
    de = en: "Allow local / self-signed connections"
```

`de.json` and `en.json` have the same string for this key. This usually means the German string was never translated and still holds the English original.

**Fix — translate it:** open `de.json`, find `admin → sso → allowInsecure`, and replace the English value with the German translation.

**Fix — whitelist it:** if the strings are legitimately identical (see below), open `i18n.test.js`, find `SAME_VALUE_ALLOWED`, and add an entry:

```js
// All locales may share this value (brand name, placeholder):
'some.key': 'any',

// Only these specific languages may share a value:
'some.key': [['de', 'en']],

// Multiple independent groups (each group may share internally):
'some.key': [['en', 'fr'], ['es', 'it']],
```

Add a short comment explaining why.

---

## When to translate vs whitelist

**Translate** when:
- The value is a regular word or phrase that has a natural translation (e.g. "Notifications", "Password", "Save", "Rename favorite")
- The string is a full sentence or prose
- The duplicate is the English value appearing unchanged in another locale

**Whitelist** when:
- Brand names or proper nouns: Gmail, iCloud, Outlook
- Hostnames, URLs, UUID-format placeholders: `imap.gmail.com`, `xxxxxxxx-xxxx-…`
- Technical abbreviations used internationally: SSO, Cc, Bcc, Port
- A word that is spelled identically in both languages: "Spam" (de/en), "Version" (de/en/fr), "Alias" (es/fr/it), "Archive" (en/fr)
- Two Romance languages share the same translation: es+it both say "contiene" for "contains", es+fr both say "De" for "From"

When in doubt, translate. The whitelist is for cases where a translation would produce the identical string anyway.

---

## Locale files

| File | Language |
|------|----------|
| `en.json` | English — source of truth |
| `de.json` | German |
| `es.json` | Spanish |
| `fr.json` | French |
| `it.json` | Italian |
| `ru.json` | Russian |
| `zhCN.json` | Simplified Chinese |
