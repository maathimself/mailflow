import { expect, test } from '@playwright/test';

const cases = [
  ['dark', 'plain', { width: 1280, height: 800 }, 'themed'],
  ['light', 'transactional', { width: 1280, height: 800 }, 'themed'],
  ['catppuccin_mocha', 'marketing-table', { width: 1280, height: 800 }, 'fallback'],
  ['catppuccin_latte', 'quoted', { width: 390, height: 844 }, 'themed'],
  ['solarized', 'native-dark', { width: 1280, height: 800 }, 'fallback'],
  ['parchment', 'protected-image', { width: 1280, height: 800 }, 'themed'],
  ['high_contrast', 'plain', { width: 390, height: 844 }, 'themed'],
  ['dark-custom', 'wide', { width: 390, height: 844 }, 'themed'],
];

test.describe('@visual email appearance', () => {
  for (const [themeCase, fixture, viewport, expectedStatus] of cases) {
    for (const renderer of ['iframe', 'div']) {
      test(`${themeCase} ${fixture} ${renderer} ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const theme = themeCase === 'dark-custom' ? 'dark' : themeCase;
        const custom = themeCase === 'dark-custom' ? '&custom=valid' : '';
        await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=${fixture}&theme=${theme}&mode=auto${custom}`);
        await expect(page.locator('body')).toHaveAttribute('data-status', expectedStatus);
        await expect(page.locator('body')).toHaveAttribute('data-geometry-ready', 'true');
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('#root')).toHaveScreenshot(
          `${themeCase}-${fixture}-${renderer}-${viewport.width}x${viewport.height}.png`,
        );
      });
    }
  }
});
