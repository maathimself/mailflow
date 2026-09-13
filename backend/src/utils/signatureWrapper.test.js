import { describe, it, expect } from 'vitest';
import { wrapSignatureHtml, SIGNATURE_CLASS } from './signatureWrapper.js';

describe('wrapSignatureHtml', () => {
  it('wraps the signature in a div marked with the mailexpert-signature class', () => {
    expect(SIGNATURE_CLASS).toBe('mailexpert-signature');
    // The frontend draft splitter (frontend/src/utils/draftSignature.js) matches this exact
    // shape. Changing it here without updating the splitter reintroduces #432.
    expect(wrapSignatureHtml('<b>Sig</b>')).toBe(
      '<div class="mailexpert-signature" style="margin-top:16px;color:#555;font-size:13px"><b>Sig</b></div>'
    );
  });
});
