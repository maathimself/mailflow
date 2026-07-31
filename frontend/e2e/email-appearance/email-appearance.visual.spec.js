import { expect, test } from '@playwright/test';

const cases = [
  ['dark', 'plain', { width: 1280, height: 800 }],
  ['light', 'transactional', { width: 1280, height: 800 }],
  ['catppuccin_mocha', 'marketing-table', { width: 1280, height: 800 }],
  ['catppuccin_latte', 'quoted', { width: 390, height: 844 }],
  ['solarized', 'native-dark', { width: 1280, height: 800 }],
  ['parchment', 'protected-image', { width: 1280, height: 800 }],
  ['high_contrast', 'plain', { width: 390, height: 844 }],
  ['dark-custom', 'wide', { width: 390, height: 844 }],
];

test.describe('@visual email appearance', () => {
  for (const [themeCase, fixture, viewport] of cases) {
    for (const renderer of ['iframe', 'div']) {
      test(`${themeCase} ${fixture} ${renderer} ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const theme = themeCase === 'dark-custom' ? 'dark' : themeCase;
        const custom = themeCase === 'dark-custom' ? '&custom=valid' : '';
        await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=${fixture}&theme=${theme}&mode=auto${custom}`);
        await expect(page.locator('body')).toHaveAttribute('data-status', 'themed');
        await expect(page.locator('body')).toHaveAttribute('data-geometry-ready', 'true');
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('#root')).toHaveScreenshot(
          `${themeCase}-${fixture}-${renderer}-${viewport.width}x${viewport.height}.png`,
        );
      });
    }
  }
});
