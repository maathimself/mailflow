import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTACT_LABEL_KEYS, formatContactValue, humanizeContactLabel } from './contactLabels.js';
import { contactToForm, formToContactDraft } from './contactCarddavState.js';

const testDir = dirname(fileURLToPath(import.meta.url));

function valueAt(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function localeT(locale) {
  const messages = JSON.parse(readFileSync(join(testDir, 'locales', `${locale}.json`), 'utf8'));
  return key => {
    const value = valueAt(messages, key);
    assert.equal(typeof value, 'string', `${locale} is missing ${key}`);
    return value;
  };
}

const t = localeT('en');

describe('contact label humanizer', () => {
  it('humanizes the raw Apple/Nextcloud label artifacts seen in production', () => {
    // Exactly what a Nextcloud collection of Apple-authored contacts hands the client.
    assert.equal(humanizeContactLabel('_$!<HomePage>!$_', t), 'Web address');
    assert.equal(humanizeContactLabel('WORK', t), 'Work');
    assert.equal(humanizeContactLabel('HOME', t), 'Home');
  });

  it('resolves well-known labels case-insensitively, wrapped or bare', () => {
    for (const label of ['work', 'Work', 'WORK', '_$!<Work>!$_', '_$!<WORK>!$_']) {
      assert.equal(humanizeContactLabel(label, t), 'Work');
    }
    assert.equal(humanizeContactLabel('_$!<Other>!$_', t), 'Other');
    assert.equal(humanizeContactLabel('CELL', t), 'Mobile');
    assert.equal(humanizeContactLabel('_$!<Mobile>!$_', t), 'Mobile');
    assert.equal(humanizeContactLabel('_$!<Anniversary>!$_', t), 'Anniversary');
  });

  it('reuses the localized copy the app already ships, in every locale', () => {
    const de = localeT('de');
    assert.equal(humanizeContactLabel('WORK', de), 'Arbeit');
    assert.equal(humanizeContactLabel('_$!<HomePage>!$_', de), 'Webadresse');
    const zhCN = localeT('zhCN');
    assert.equal(humanizeContactLabel('HOME', zhCN), '家庭');

    // Every mapped key must be an existing key — no parallel copy for labels.
    const en = JSON.parse(readFileSync(join(testDir, 'locales', 'en.json'), 'utf8'));
    const missing = CONTACT_LABEL_KEYS.filter(key => typeof valueAt(en, key) !== 'string');
    assert.deepEqual(missing, []);
  });

  it('strips the wrapper and title-cases anything it does not know', () => {
    assert.equal(humanizeContactLabel('_$!<Fax>!$_', t), 'Fax');
    assert.equal(humanizeContactLabel('PAGER', t), 'Pager');
    assert.equal(humanizeContactLabel('MAIN', t), 'Main');
    assert.equal(humanizeContactLabel('_$!<ski cabin>!$_', t), 'Ski Cabin');
    assert.equal(humanizeContactLabel('', t), '');
    assert.equal(humanizeContactLabel(null, t), '');
    assert.equal(humanizeContactLabel(undefined, t), '');
  });

  it('formats vCard values with humanized labels and omits boolean metadata', () => {
    assert.equal(formatContactValue({
      kind: 'url',
      label: '_$!<HomePage>!$_',
      value: 'https://example.test',
    }, t), 'Web address: https://example.test');
    assert.equal(formatContactValue({
      value: 'ada@example.test',
      type: 'work',
      primary: true,
    }, t), 'ada@example.test · work');
  });

  it('is presentation only: the stored label still round-trips byte-for-byte', () => {
    const label = '_$!<HomePage>!$_';
    const form = contactToForm({
      additional_fields: [{ id: 'vcard-1', kind: 'url', label, value: 'https://example.test' }],
    });

    assert.equal(form.additionalFields[0].label, label);
    assert.equal(formToContactDraft(form).additionalFields[0].label, label);
  });

  it('humanizes labels in both the detail and the edit rendering', () => {
    const contactsPage = readFileSync(join(testDir, 'components', 'ContactsPage.jsx'), 'utf8');
    const detail = contactsPage.slice(
      contactsPage.indexOf('function ContactDetail'),
      contactsPage.indexOf('function ContactForm'),
    );
    const form = contactsPage.slice(
      contactsPage.indexOf('function ContactForm'),
      contactsPage.indexOf('function AdditionalFieldInput'),
    );

    assert.match(detail, /humanizeContactLabel\(field\.label, t\)/);
    assert.match(form, /humanizeContactLabel\(field\.label, t\)/);
    // The edit control still writes the raw value the user typed, never the humanized one.
    assert.match(form, /onSetAdditional\(field\.id, \{ label: event\.target\.value \}\)/);
  });
});
