import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, emailDomain } from './providerDetect.js';

describe('detectProvider', () => {
  for (const [email, provider] of [
    ['maria.lopez@outlook.com', 'microsoftPersonal'],
    ['Maria@Hotmail.co.uk', 'microsoftPersonal'],
    ['me@live.fr', 'microsoftPersonal'],
    ['me@msn.com', 'microsoftPersonal'],
    ['me@windowslive.com', 'microsoftPersonal'],
    ['me@outlook.com.br', 'microsoftPersonal'],
    ['  me@outlook.de  ', 'microsoftPersonal'],
    ['me@gmail.com', 'gmail'],
    ['me@googlemail.com', 'gmail'],
    ['me@yahoo.com', 'yahoo'],
    ['me@yahoo.co.uk', 'yahoo'],
    // Yahoo! JAPAN has its own servers: the IMAP form, not the Yahoo preset.
    ['me@yahoo.co.jp', 'other'],
    ['me@ymail.com', 'yahoo'],
    ['me@icloud.com', 'icloud'],
    ['me@me.com', 'icloud'],
    ['me@mac.com', 'icloud'],
    // Look-alikes and custom domains go to the IMAP form.
    ['me@contoso.com', 'other'],
    ['me@outlookfan.com', 'other'],
    ['me@live.example.org', 'other'],
    ['me@mail.gmail.com', 'other'],
    ['me@company.onmicrosoft.com', 'other'],
  ]) {
    test(`${email.trim()} is ${provider}`, () => assert.equal(detectProvider(email), provider));
  }

  test('something that is not an address is nothing', () => {
    for (const value of ['', 'maria', 'maria@', '@outlook.com', 'maria@outlook', 'a b@outlook.com', null, undefined]) {
      assert.equal(detectProvider(value), null, String(value));
    }
  });

  test('emailDomain lowercases and trims', () => {
    assert.equal(emailDomain(' Me@Outlook.COM '), 'outlook.com');
  });
});
