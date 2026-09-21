import { describe, it, expect, vi } from 'vitest';

const mjml2html = vi.fn();
vi.mock('mjml', () => ({ default: mjml2html }));

import { compileMjml } from './mjmlCompile.js';

const VALID_MJML = '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>';

describe('compileMjml', () => {
  it('returns html when mjml compiles without errors', async () => {
    mjml2html.mockResolvedValue({ html: '<html>Hi</html>', errors: [] });
    const result = await compileMjml(VALID_MJML);
    expect(result).toBe('<html>Hi</html>');
    expect(mjml2html).toHaveBeenCalledWith(VALID_MJML, { validationLevel: 'strict' });
  });

  it('throws when mjml returns errors', async () => {
    mjml2html.mockResolvedValue({
      html: '',
      errors: [{ formattedMessage: 'Line 1: unknown tag' }],
    });
    await expect(compileMjml('<mjml-bad/>')).rejects.toThrow('MJML compile error');
    await expect(compileMjml('<mjml-bad/>')).rejects.toThrow('unknown tag');
  });

  it('throws when mjml throws', async () => {
    mjml2html.mockRejectedValue(new Error('parser crash'));
    await expect(compileMjml('<mjml/>')).rejects.toThrow('parser crash');
  });
});
