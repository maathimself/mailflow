import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMAIL_BODY_APPEARANCE_AUTO,
  EMAIL_BODY_APPEARANCE_ORIGINAL,
  emailBodyAppearanceToggleLabel,
  normalizeEmailBodyAppearance,
} from './emailBodyAppearance.js';

describe('normalizeEmailBodyAppearance', () => {
  it('keeps the two persisted values', () => {
    assert.equal(normalizeEmailBodyAppearance('auto'), EMAIL_BODY_APPEARANCE_AUTO);
    assert.equal(normalizeEmailBodyAppearance('original'), EMAIL_BODY_APPEARANCE_ORIGINAL);
  });

  it('defaults missing and invalid values to auto', () => {
    for (const value of [undefined, null, '', 'dark', 'AUTO', false, 1]) {
      assert.equal(normalizeEmailBodyAppearance(value), EMAIL_BODY_APPEARANCE_AUTO);
    }
  });
});

describe('emailBodyAppearanceToggleLabel', () => {
  it('describes the desired-mode action even when recovery renders original colors', () => {
    const recovery = { desiredMode: EMAIL_BODY_APPEARANCE_AUTO, renderMode: EMAIL_BODY_APPEARANCE_ORIGINAL };

    assert.equal(emailBodyAppearanceToggleLabel(recovery.desiredMode), 'message.showOriginalColors');
    assert.equal(emailBodyAppearanceToggleLabel(EMAIL_BODY_APPEARANCE_ORIGINAL), 'message.matchThemeColors');
  });
});
