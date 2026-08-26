import { expect, test } from '@playwright/test';

async function terminalResult(page, status = /^(themed|original|fallback)$/) {
  await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toMatch(status);
  return page.evaluate(() => window.mailflowFixtureResult);
}

async function renderedContrast(page, renderer, selector, pseudo = null) {
  return page.evaluate(({ renderer: targetRenderer, selector: targetSelector, pseudo: targetPseudo }) => {
    const root = targetRenderer === 'iframe'
      ? document.querySelector('iframe').contentDocument
      : document.querySelector('[data-fixture-root]');
    const style = getComputedStyle(root.querySelector(targetSelector), targetPseudo);
    const channels = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = value => {
      const linear = channels(value).map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  }, { renderer, selector, pseudo });
}

for (const renderer of ['iframe', 'div']) {
  test(`loads the ${renderer} fixture harness`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toMatch(/^(themed|fallback)$/);
    const result = await page.evaluate(() => window.mailflowFixtureResult);
    expect(result).toMatchObject({ renderer, fixture: 'plain', theme: 'dark', mode: 'auto' });
    expect(result.renderKey).toEqual(expect.any(Number));
  });

  test(`controller ${renderer} accepts rewritten color-scheme-only sender media`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=dark&mode=auto&scenario=color-scheme-only-media`);
    const result = await terminalResult(page, /themed/);
    expect(result).toMatchObject({ status: 'themed', visibility: 'visible' });
    expect(await renderedContrast(page, renderer, '.native-card')).toBeGreaterThanOrEqual(4.5);
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} falls back when viewport-width sender paint can change`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=post-terminal-width-media`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', reason: 'geometry_condition_unproven',
    });
  });
}

const BUILT_IN_THEMES = [
  'dark', 'light', 'gtd', 'gruvbox', 'catppuccin_mocha', 'catppuccin_latte',
  'nord', 'tokyo_night', 'solarized', 'dracula', 'rose_pine', 'midnight_blue',
  'cyberpunk', 'forest', 'sunset', 'executive', 'parchment', 'slate_pro',
  'monokai', 'high_contrast', 'espresso',
];

for (const renderer of ['iframe', 'div']) {
  for (const theme of BUILT_IN_THEMES) {
    test(`acceptance ${renderer} completes ${theme} with proved role contrast`, async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=transactional&theme=${theme}&mode=auto`);
      const result = await terminalResult(page, /themed/);
      expect(result).toMatchObject({ renderer, theme, terminalThemeName: theme, visibility: 'visible' });
      expect(result.paletteFingerprint.split('|')).toHaveLength(6);
      expect(result.changedPairs.length).toBeGreaterThan(0);
      for (const pair of result.changedPairs) {
        const minimum = pair.property.startsWith('border-') ? 3 : 4.5;
        expect(pair.targetContrast).toBeGreaterThanOrEqual(minimum);
        expect(pair.renderedContrast).toBeGreaterThanOrEqual(minimum);
      }
    });
  }

  test(`acceptance ${renderer} uses valid custom CSS as the resolved palette`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto`);
    const builtIn = await terminalResult(page, /themed/);
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&custom=valid`);
    const custom = await terminalResult(page, /themed/);
    expect(custom.paletteFingerprint).not.toBe(builtIn.paletteFingerprint);
    expect(custom.paletteFingerprint.split('|')).toHaveLength(6);
    expect(custom.rootColors.background).toBe(custom.paletteColors.background);
    expect(custom.rootColors.color).toBe(custom.paletteColors.text);
  });

  for (const customCase of ['invalid', 'broad']) {
    test(`acceptance ${renderer} rejects ${customCase} custom CSS sentinel corruption`, async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto`);
      const builtIn = await terminalResult(page, /themed/);
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&custom=${customCase}`);
      const result = await terminalResult(page, /themed/);
      expect(result.paletteFingerprint).toBe(builtIn.paletteFingerprint);
      if (customCase === 'invalid') {
        expect(result.rootColors.background).toBe(result.paletteColors.background);
        expect(result.rootColors.color).toBe(result.paletteColors.text);
      }
    });
  }

  test(`acceptance ${renderer} preserves every unknown-pixel island and image backing`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=protected-image&theme=dark&mode=auto`);
    const result = await terminalResult(page, /themed/);
    const protectedCases = ['gradient', 'opacity', 'filter', 'backdrop', 'blend', 'logo-backing', 'qr', 'remote-placeholder'];
    for (const name of protectedCases) {
      expect(result.protectedColors.after[name]).toEqual(result.protectedColors.before[name]);
      const recolors = result.mutations.filter(mutation => (
        mutation.protectedCase === name && mutation.kind === 'repair'
      ));
      expect(recolors).toEqual([]);
    }
    for (const mutation of result.mutations.filter(entry => entry.insideProtected)) {
      expect(mutation.kind).toBe('preserve');
      expect(mutation.atProtectedRoot).toBe(true);
      expect(['color', 'background-color']).toContain(mutation.property);
      expect(mutation.beforeValue).toMatch(/^rgba?\(/);
      expect(mutation.plannedValue).toMatch(/^rgba?\(/);
      expect(mutation.plannedValue).toBe(mutation.afterValue);
    }
    for (const mutation of result.mutations.filter(entry => entry.compositingBoundary)) {
      expect(mutation).toMatchObject({ kind: 'preserve', property: 'background-color' });
      expect(mutation.insideProtected).toBe(false);
      expect(mutation.beforeValue).toMatch(/^rgba?\(/);
      expect(mutation.plannedValue).toMatch(/^rgba?\(/);
      expect(mutation.plannedValue).toBe(mutation.afterValue);
    }
    expect(result.mutations.some(mutation => (
      (mutation.insideProtected || mutation.compositingBoundary)
      && mutation.beforeValue !== mutation.afterValue
    ))).toBe(true);
    expect(result.remotePlaceholder).toMatchObject({ protected: true, sourceProtocol: 'data:' });
  });

  test(`acceptance ${renderer} preserves inset-shadow text paint`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=inset-shadow`);
    const result = await terminalResult(page, /themed/);
    expect(result.protectedColors.after['inset-shadow']).toEqual(result.protectedColors.before['inset-shadow']);
    expect(result.mutations.filter(mutation => (
      mutation.protectedCase === 'inset-shadow' && mutation.kind === 'repair'
    ))).toEqual([]);
    const target = renderer === 'iframe'
      ? page.frameLocator('iframe').locator('[data-case="inset-shadow"]')
      : page.locator('[data-fixture-root] [data-case="inset-shadow"]');
    await expect(target).toHaveCSS('box-shadow', /inset/);
  });

  test(`acceptance ${renderer} keeps links and immutable downstream HTML on the real draft`, async ({ context, page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=quoted&theme=dark&mode=auto`);
    const result = await terminalResult(page, /themed/);
    expect(result.immutableBody).toEqual({ cache: true, reply: true, forward: true, ai: true });
    const expectedUrl = 'https://example.invalid/a/very/long/generic/path';
    const request = context.waitForEvent('request', candidate => candidate.url() === expectedUrl);
    const link = renderer === 'iframe'
      ? page.frameLocator('iframe').locator('a[href]')
      : page.locator('[data-fixture-root] a[href]');
    await link.click();
    expect((await request).url()).toBe(expectedUrl);
  });

  test(`acceptance ${renderer} prints sender light rules without analyzer mutations`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=dark&mode=auto&scenario=color-scheme-only-media`);
    await terminalResult(page, /themed/);
    const result = await page.evaluate(() => window.mailflowFixturePrintEvidence());
    expect(result).toMatchObject({
      mediaStatus: 'ready', cardBackground: 'rgb(255, 255, 255)',
      analyzerDelta: 0, htmlUnchanged: true,
    });
  });

  test(`acceptance ${renderer} print fail-closes oversized sender rules without losing its readable bases`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto`);
    await terminalResult(page, /themed/);
    const result = await page.evaluate(() => window.mailflowFixturePrintEvidence('over-budget'));
    expect(result).toMatchObject({
      mediaStatus: 'ready', senderStyleCount: 0,
      finalBaseRetained: true, printShellBaseRetained: true,
      bodyColor: 'rgb(17, 17, 17)', printRootBackground: 'rgb(255, 255, 255)',
    });
  });

  test(`acceptance ${renderer} never prints after an unwritable sender owner hard failure`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto`);
    await terminalResult(page, /themed/);
    const result = await page.evaluate(() => window.mailflowFixturePrintEvidence('unwritable-owner'));
    expect(result).toMatchObject({
      mediaStatus: 'fallback', mediaReason: 'media_rule_unwritable',
      printCalls: 0, printWindowClosed: true,
      finalBaseRetained: true, printShellBaseRetained: true,
    });
  });

  for (const [fixture, viewport] of [
    ['marketing-table', { width: 1280, height: 800 }],
    ['quoted', { width: 390, height: 844 }],
    ['wide', { width: 390, height: 844 }],
  ]) {
    test(`acceptance ${renderer} has one vertical scroll owner for ${fixture} at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=${fixture}&theme=dark&mode=auto`);
      const result = await terminalResult(page, fixture === 'marketing-table' ? /fallback/ : /themed/);
      if (fixture === 'marketing-table') {
        expect(result).toMatchObject({ reason: 'geometry_condition_unproven' });
      }
      expect(result.geometry.nestedVerticalScrolls).toBe(0);
      expect(result.geometry.contentWidth).toBeLessThanOrEqual(result.geometry.viewportWidth + 2);
      expect(result.geometry.contentHeight).toBeGreaterThan(0);
    });
  }

  test(`acceptance ${renderer} blocks executable probes and exposes no script capability`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=script-probe`);
    const result = await terminalResult(page, /themed/);
    expect(result.security.probeExecuted).toBe(false);
    expect(result.security.allowScripts).toBe(false);
    if (renderer === 'iframe') expect(result.security.csp).toContain("script-src 'none'");
    else expect(result.security.csp).toBeNull();
  });

  test(`acceptance ${renderer} freezes authored CSS motion without touching image pixels`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=animated-image`);
    const result = await terminalResult(page, /themed/);
    expect(result.motion).toMatchObject({
      textAnimation: 'none', textTransition: 'none',
      imageElementAnimation: 'none', imageSourceIntact: true,
      imageAssetAnimated: true,
    });
    const image = renderer === 'iframe'
      ? page.frameLocator('iframe').locator('[data-case="animated-image"]')
      : page.locator('[data-fixture-root] [data-case="animated-image"]');
    await expect.poll(() => image.evaluate(element => (
      element.complete && element.naturalWidth === 32
    ))).toBe(true);
  });

  for (const generatedCase of ['generated-double', 'generated-legacy', 'generated-media']) {
    test(`acceptance ${renderer} falls back before revealing ${generatedCase} text without contrast proof`, async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=${generatedCase}`);
      const result = await terminalResult(page, /fallback/);
      expect(result).toMatchObject({
        status: 'fallback', reason: 'style_complexity_limit', visibility: 'visible',
        analyzerLoaded: false, analyzerCalls: 0,
      });
    });
  }

  test(`acceptance ${renderer} preflights empty generated clearfix content`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=generated-empty`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', reason: 'style_complexity_limit', visibility: 'visible',
      analyzerLoaded: false, analyzerCalls: 0,
    });
  });

  for (const textPseudo of ['marker', 'first-line', 'first-letter']) {
    test(`acceptance ${renderer} falls back before revealing ${textPseudo} text without contrast proof`, async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=pseudo-${textPseudo}`);
      const result = await terminalResult(page, /fallback/);
      expect(result).toMatchObject({
        status: 'fallback', reason: 'style_complexity_limit', visibility: 'visible',
        analyzerLoaded: false, analyzerCalls: 0,
      });
    });
  }

  test(`acceptance ${renderer} preflights inactive and nonmatching text pseudo rules`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=pseudo-inactive-nonmatching`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', reason: 'style_complexity_limit', visibility: 'visible',
      analyzerLoaded: false, analyzerCalls: 0,
    });
  });

  test(`acceptance ${renderer} falls back before a divergent text fill bypasses foreground repair`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=divergent-text-fill`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', reason: 'text_fill_unproven', visibility: 'visible',
    });
  });

  test(`acceptance ${renderer} repairs an equal explicit text fill with its foreground`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=equal-text-fill`);
    const result = await terminalResult(page, /themed/);
    const textFill = result.mutations.find(mutation => mutation.property === '-webkit-text-fill-color');
    const color = result.mutations.find(mutation => (
      mutation.property === 'color'
      && mutation.afterValue === textFill?.afterValue
      && mutation.targetContrast === textFill?.targetContrast
    ));
    expect(textFill).toMatchObject({
      kind: 'repair', targetContrast: expect.any(Number),
    });
    expect(color).toBeDefined();
    const painted = renderer === 'iframe'
      ? await page.frameLocator('iframe').locator('.fill').evaluate(element => {
        const style = getComputedStyle(element);
        return { color: style.color, textFill: style.webkitTextFillColor };
      })
      : await page.locator('[data-fixture-root] .fill').evaluate(element => {
        const style = getComputedStyle(element);
        return { color: style.color, textFill: style.webkitTextFillColor };
      });
    expect(painted.textFill).toBe(painted.color);
  });

  test(`acceptance ${renderer} keeps valid CSS adjacent to browser-rejected declarations`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=malformed&theme=dark&mode=auto`);
    const result = await terminalResult(page, /themed/);
    expect(result.reason).toBeUndefined();
    const evidence = await page.evaluate(() => {
      const before = window.mailflowFixtureRoot.querySelector('[data-case="valid-before"]');
      const after = window.mailflowFixtureRoot.querySelector('[data-case="valid-after"]');
      return {
        beforeText: before?.textContent,
        afterText: after?.textContent,
        externalResources: [...window.mailflowFixtureRoot.querySelectorAll('[src], [href]')]
          .filter(element => /^https?:/i.test(element.src || element.href || '')).length,
      };
    });
    expect(evidence).toEqual({
      beforeText: 'Valid before malformed CSS',
      afterText: 'Valid after malformed CSS',
      externalResources: 0,
    });
  });

  test(`acceptance ${renderer} preserves responsive marketing columns on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=marketing-table&theme=catppuccin_mocha&mode=auto`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({ reason: 'geometry_condition_unproven' });
    const columns = await page.evaluate(() => [...window.mailflowFixtureRoot.querySelectorAll('.column')].map(element => {
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      return { display: style.display, width: element.getBoundingClientRect().width };
    }));
    expect(columns).toHaveLength(2);
    expect(columns.every(column => column.display === 'block')).toBe(true);
    expect(Math.abs(columns[0].width - columns[1].width)).toBeLessThanOrEqual(2);
  });
}

test('acceptance div keeps sender at-rule registrations out of app chrome', async ({ page }) => {
  await page.goto('/e2e/email-appearance/fixture.html?renderer=div&fixture=plain&theme=dark&mode=auto&scenario=scoped-global-at-rule');
  await terminalResult(page, /themed/);
  const evidence = await page.evaluate(() => {
    const outside = document.createElement('div');
    outside.style.color = 'var(--mailflow-global-probe, rgb(0, 128, 0))';
    document.body.appendChild(outside);
    return {
      appValue: getComputedStyle(document.documentElement).getPropertyValue('--mailflow-global-probe').trim(),
      outsideColor: getComputedStyle(outside).color,
      senderPropertyRules: [...document.styleSheets].flatMap(sheet => {
        try { return [...sheet.cssRules].map(rule => rule.cssText); } catch { return []; }
      }).filter(text => text.includes('@property')),
    };
  });
  expect(evidence).toEqual({
    appValue: '', outsideColor: 'rgb(0, 128, 0)', senderPropertyRules: [],
  });
});

const FAULTS = {
  'elapsed-40': { reason: 'analysis_deadline', analyzerCalls: 1, commitCalls: 0 },
  'remaining-analysis-budget': { reason: 'analysis_deadline', analyzerCalls: 1, commitCalls: 0 },
  'computed-style-throw': { reason: 'computed_style_error', analyzerCalls: 1, commitCalls: 0 },
  'commit-throw': { reason: 'email_reveal_deadline', analyzerCalls: 1, commitCalls: 1 },
};

for (const renderer of ['iframe', 'div']) {
  for (const [scenario, expected] of Object.entries(FAULTS)) {
    test(`controller ${renderer} records exact ${scenario} fail-closed evidence`, async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=${scenario}`);
      const result = await terminalResult(page, /fallback/);
      expect(result).toMatchObject({
        status: 'fallback', visibility: 'visible', recovery: false,
        generation: 1, rootCount: 1, parseCount: 1, survivingThemedMutations: 0,
        ...expected,
      });
    });
  }
}

for (const renderer of ['iframe', 'div']) {
  for (const [scenario, reason] of [
    ['deadline-exact', 'reveal_deadline'],
    ['deadline-zero-mutation', 'reveal_deadline'],
    ['deadline-post-commit', 'reveal_deadline'],
  ]) {
    test(`controller ${renderer} fail-closes ${scenario} before themed publication`, async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=${scenario}`);
      const result = await terminalResult(page, /fallback/);
      expect(result).toMatchObject({
        status: 'fallback', visibility: 'visible', reason,
        generation: 1, survivingThemedMutations: 0,
      });
    });
  }
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} repairs an empty custom-string list marker`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=custom-list-marker`);
    const result = await terminalResult(page, /themed/);
    expect(result).toMatchObject({ status: 'themed', visibility: 'visible' });
    expect(await renderedContrast(page, renderer, '.marker-item')).toBeGreaterThanOrEqual(4.5);
  });

  test(`controller ${renderer} fail-closes an empty image-backed list marker`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=image-list-marker`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', reason: 'generated_content_unproven',
    });
  });

  test(`controller ${renderer} never publishes paint mutated by an important sender animation`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=important-paint-animation`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', reason: 'dynamic_paint_unproven',
      analyzerLoaded: true, analyzerCalls: 1,
      survivingThemedMutations: 0,
    });
    await page.waitForTimeout(900);
    expect(await renderedContrast(page, renderer, '#important-paint-animation')).toBeGreaterThanOrEqual(4.5);
  });

  test(`controller ${renderer} fail-closes sender hover and focus paint before reveal`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=important-interaction-paint`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', reason: 'interaction_paint_unproven',
      survivingThemedMutations: 0,
    });
    const target = renderer === 'iframe'
      ? page.frameLocator('iframe').locator('#interactive-paint')
      : page.locator('[data-fixture-root] #interactive-paint');
    await target.hover();
    expect(await renderedContrast(page, renderer, '#interactive-paint')).toBeGreaterThanOrEqual(4.5);
    await target.focus();
    expect(await renderedContrast(page, renderer, '#interactive-paint')).toBeGreaterThanOrEqual(4.5);
  });

  test(`controller ${renderer} fail-closes initially empty generated content with delayed motion`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=important-pseudo-animation`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', reason: 'style_complexity_limit',
      analyzerLoaded: false, analyzerCalls: 0,
      survivingThemedMutations: 0,
    });
    await page.waitForTimeout(900);
    const content = await page.evaluate(targetRenderer => {
      const root = targetRenderer === 'iframe'
        ? document.querySelector('iframe').contentDocument
        : document.querySelector('[data-fixture-root]');
      return getComputedStyle(root.querySelector('#late-pseudo'), '::before').content;
    }, renderer);
    if (content !== 'none' && content.replace(/["']/g, '').trim()) {
      expect(await renderedContrast(page, renderer, '#late-pseudo', '::before')).toBeGreaterThanOrEqual(4.5);
    }
  });

  for (const scenario of ['post-geometry-container', 'post-geometry-container-inline']) {
    test(`controller ${renderer} conservatively handles ${scenario} before geometry`, async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=${scenario}`);
      const result = await terminalResult(page, renderer === 'iframe' ? /fallback/ : /themed/);
      if (renderer === 'iframe') {
        expect(result).toMatchObject({
          status: 'fallback', visibility: 'visible', reason: 'geometry_condition_unproven',
          survivingThemedMutations: 0,
        });
      } else {
        expect(result).toMatchObject({
          status: 'themed', visibility: 'visible', senderContainerRuleCount: 0,
        });
        expect(await renderedContrast(page, renderer, '.container-paint')).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} falls back for viewport-height sender media`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=post-geometry-height-media`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', reason: 'geometry_condition_unproven',
    });
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} treats an early reveal timer as an expired cleanup deadline`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=dark&mode=auto&scenario=reveal-early-timer`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureBlocked?.boundary)).toBe('before_engine');
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureState)).toMatchObject({
      generation: 1, status: 'fallback', visibility: 'visible',
    });
    await page.evaluate(() => window.mailflowFixtureRelease());
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      reason: 'reveal_deadline', senderStyleCount: 0, baseRetained: true,
      survivingThemedMutations: 0,
    });
  });

  test(`controller ${renderer} keeps functional scenarios independent of scheduler delay`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=functional-delay`);
    const result = await terminalResult(page, /themed/);
    expect(result).toMatchObject({ status: 'themed', visibility: 'visible', generation: 1 });
  });

  test(`controller ${renderer} rejects stale geometry after a deadline fallback is superseded`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=deadline-stale`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureState)).toMatchObject({
      generation: 1, status: 'fallback', visibility: 'visible',
    });
    await page.evaluate(() => window.mailflowFixtureAction('theme'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureState.generation)).toBe(2);
    await page.evaluate(() => window.mailflowFixtureRelease());
    const result = await terminalResult(page, /themed/);
    await expect.poll(() => page.evaluate(() => (
      window.mailflowFixtureProcessResults?.find(entry => entry.generation === 1)?.ready
    ))).toBe(false);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.mailflowFixtureResult)).toMatchObject({
      generation: 2, geometryPasses: 1,
    });
    expect(result.generation).toBe(2);
  });

  test(`controller ${renderer} completes geometry after the reveal deadline wins an async race`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=delayed-reveal`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', reason: 'reveal_deadline',
      generation: 1, recovery: false, rootCount: 1, parseCount: 1,
    });
    expect(result.geometry).toEqual(expect.objectContaining({ viewportWidth: expect.any(Number) }));
  });

  test(`controller ${renderer} retains the original 100 ms reveal deadline`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=dark&mode=auto&scenario=reveal-100ms`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', reason: 'reveal_deadline',
      generation: 1, recovery: false, rootCount: 1, parseCount: 1,
      senderStyleCount: 0, baseRetained: true, survivingThemedMutations: 0,
      analyzerCalls: 0, commitCalls: 0,
    });
    expect(result.terminalElapsedMs).toBeGreaterThanOrEqual(85);
    expect(result.revealDelayMs).toBeGreaterThan(0);
    expect(result.revealDelayMs).toBeLessThanOrEqual(100);
  });

  test(`controller ${renderer} rebuilds exactly once after rollback failure`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=rollback-failure`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', recovery: true,
      generation: 2, rootCount: 2, parseCount: 2, senderStyleCount: 0, baseRetained: true,
      analyzerCalls: 1, commitCalls: 1,
    });
    expect(result.survivingThemedMutations).toBeGreaterThan(0);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.mailflowFixtureResult)).toMatchObject({
      generation: result.generation, rootCount: result.rootCount, parseCount: result.parseCount,
      analyzerCalls: result.analyzerCalls, commitCalls: result.commitCalls,
    });
  });

  test(`controller ${renderer} reveals a sender-style-free shell after persistent baseline failure`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=dark&mode=auto&scenario=baseline-persistent`);
    const result = await terminalResult(page, /fallback/);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', recovery: true,
      generation: 2, rootCount: 2, parseCount: 2, senderStyleCount: 0, baseRetained: true,
      canvasBackground: 'rgb(255, 255, 255)',
      analyzerCalls: 0, commitCalls: 0, survivingThemedMutations: 0,
    });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.mailflowFixtureResult)).toMatchObject({
      generation: result.generation, rootCount: result.rootCount, parseCount: result.parseCount,
      analyzerCalls: result.analyzerCalls, commitCalls: result.commitCalls,
    });
  });

  test(`controller ${renderer} does not retry a completed fallback until a real input`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=nodes-5001`);
    const first = await terminalResult(page, /fallback/);
    expect(first).toMatchObject({
      generation: 1, rootCount: 1, parseCount: 1, analyzerCalls: 0, commitCalls: 0,
    });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.mailflowFixtureResult)).toMatchObject({
      generation: first.generation, rootCount: first.rootCount, parseCount: first.parseCount,
      analyzerCalls: first.analyzerCalls, commitCalls: first.commitCalls,
    });
    await page.evaluate(() => window.mailflowFixtureAction('theme'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.generation)).toBe(first.generation + 1);
    const second = await terminalResult(page, /fallback/);
    expect(second).toMatchObject({
      generation: first.generation + 1, rootCount: 2, parseCount: 2,
      analyzerCalls: 0, commitCalls: 0,
    });
  });

  test(`controller ${renderer} uses exactly one generation for theme and each custom CSS change`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto`);
    const initial = await terminalResult(page, /themed/);
    await page.evaluate(() => window.mailflowFixtureAction('theme'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.generation)).toBe(initial.generation + 1);
    const themed = await terminalResult(page, /themed/);
    expect(themed.terminalThemeName).toBe('light');
    await page.evaluate(() => window.mailflowFixtureAction('custom'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.generation)).toBe(initial.generation + 2);
    const applied = await terminalResult(page, /themed/);
    expect(applied.terminalThemeName).toBe('light');
    await page.evaluate(() => window.mailflowFixtureAction('custom-remove'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.generation)).toBe(initial.generation + 3);
    const removed = await terminalResult(page, /themed/);
    expect(removed).toMatchObject({ terminalThemeName: 'light', rootCount: 1, parseCount: 1 });
  });

  test(`controller ${renderer} does not reload remote images for appearance-only changes`, async ({ page }) => {
    let imageRequests = 0;
    await page.route('**/e2e/email-appearance/tracking-probe.svg', async route => {
      imageRequests += 1;
      await route.fulfill({
        contentType: 'image/svg+xml',
        headers: { 'cache-control': 'no-store' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="white"/></svg>',
      });
    });
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=remote-image-stability`);
    const initial = await terminalResult(page, /themed/);
    expect(imageRequests).toBe(1);

    await page.evaluate(() => window.mailflowFixtureAction('theme'));
    await terminalResult(page, /themed/);
    await page.evaluate(() => window.mailflowFixtureAction('custom'));
    await terminalResult(page, /themed/);
    await page.evaluate(() => window.mailflowFixtureAction('view'));
    const original = await terminalResult(page, /original/);

    expect(imageRequests).toBe(1);
    expect(original).toMatchObject({ rootCount: initial.rootCount, parseCount: initial.parseCount });
  });
}

for (const renderer of ['iframe', 'div']) {
  for (const boundary of ['before_engine', 'after_engine', 'before_analyze', 'before_commit']) {
    for (const action of ['message', 'theme', 'custom', 'view']) {
      test(`controller ${renderer} rejects stale ${action} work at ${boundary}`, async ({ page }) => {
        await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=race&boundary=${boundary}`);
        await expect.poll(() => page.evaluate(() => window.mailflowFixtureBlocked?.boundary)).toBe(boundary);
        const blocked = await page.evaluate(() => window.mailflowFixtureBlocked);
        expect(await page.evaluate(() => window.mailflowFixtureState)).toMatchObject({
          generation: blocked.generation, status: 'pending', visibility: 'hidden',
        });
        await page.evaluate(next => window.mailflowFixtureAction(next), action);
        await expect.poll(() => page.evaluate(() => window.mailflowFixtureState.generation)).toBe(blocked.generation + 1);
        await page.evaluate(() => window.mailflowFixtureRelease());
        const result = await terminalResult(page, action === 'view' ? /original/ : /themed/);
        const history = await page.evaluate(() => window.mailflowFixtureHistory);
        expect(history.some(entry => entry.generation === blocked.generation)).toBe(false);
        expect(result).toMatchObject({
          generation: blocked.generation + 1, visibility: 'visible',
          rootCount: action === 'message' ? 2 : 1,
          parseCount: action === 'message' ? 2 : 1,
          survivingThemedMutations: 0,
        });
        const staleReachedAnalysis = boundary === 'before_commit' ? 1 : 0;
        const currentAnalyzed = action === 'view' ? 0 : 1;
        expect(result.analyzerCalls).toBe(staleReachedAnalysis + currentAnalyzed);
        expect(result.commitCalls).toBe(action === 'view' ? 0 : 1);
      });
    }
  }
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} fail-closes the attempted 10,001st mutation`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=mutations-10001`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('fallback');
    const result = await page.evaluate(() => window.mailflowFixtureResult);
    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', recovery: false,
      reason: 'mutation_limit', attemptedMutationCount: 10001,
      generation: 1, commitCalls: 0, rootCount: 1, parseCount: 1,
      survivingThemedMutations: 0,
    });
    expect(result.analyzerCalls).toBe(1);
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} replaces the immutable root for same-message HTML`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=original`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
    const rootKey = await page.evaluate(() => window.mailflowFixtureResult.rootKey);
    await page.evaluate(() => {
      window.mailflowFixtureRoot.style.setProperty('background-color', 'rgb(1, 2, 3)', 'important');
      window.mailflowFixtureReplaceHtml('<main id="message"><p>replacement body</p></main>');
    });
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.rootKey)).toBe(rootKey + 1);
    expect(await page.evaluate(() => window.mailflowFixtureResult.rootChanged)).toBe(true);
    expect(await page.evaluate(() => window.mailflowFixtureRoot.style.backgroundColor || '')).not.toBe('rgb(1, 2, 3)');
  });
}

test('controller iframe performs one srcdoc navigation without remount for same-message HTML', async ({ page }) => {
  await page.goto('/e2e/email-appearance/fixture.html?renderer=iframe&fixture=plain&theme=dark&mode=original');
  const initial = await terminalResult(page, /original/);
  const before = await page.evaluate(() => {
    window.mailflowFixtureFrameBeforeHtmlChange = document.querySelector('iframe');
    return { ...window.mailflowFixtureIframeLifecycle };
  });

  await page.evaluate(() => window.mailflowFixtureReplaceHtml('<main id="message"><p>one navigation</p></main>'));
  await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.rootKey)).toBe(initial.rootKey + 1);
  await expect.poll(() => page.evaluate(() => window.mailflowFixtureIframeLifecycle.loads)).toBe(before.loads + 1);

  const after = await page.evaluate(() => ({
    lifecycle: { ...window.mailflowFixtureIframeLifecycle },
    sameFrame: document.querySelector('iframe') === window.mailflowFixtureFrameBeforeHtmlChange,
    rootChanged: window.mailflowFixtureResult.rootChanged,
  }));
  expect(after).toMatchObject({ sameFrame: true, rootChanged: true });
  expect(after.lifecycle).toMatchObject({
    insertions: before.insertions,
    removals: before.removals,
    navigationAttempts: before.navigationAttempts + 1,
    loads: before.loads + 1,
    geometryPasses: before.geometryPasses + 1,
  });
});

test('controller iframe rejects the complete old document before the new srcdoc load', async ({ page }) => {
  await page.goto('/e2e/email-appearance/fixture.html?renderer=iframe&fixture=plain&theme=dark&mode=original&scenario=stale-ready-state');
  const initial = await terminalResult(page, /original/);
  const before = await page.evaluate(() => {
    window.mailflowFixtureFrameBeforeStaleShortcut = document.querySelector('iframe');
    return {
      processCalls: window.mailflowFixtureResult.processCalls,
      geometryPasses: window.mailflowFixtureIframeLifecycle.geometryPasses,
      lifecycle: { ...window.mailflowFixtureIframeLifecycle },
    };
  });

  await page.evaluate(() => window.mailflowFixtureReplaceHtml('<main id="message"><p>guarded navigation</p></main>'));
  await expect.poll(() => page.evaluate(() => window.mailflowFixtureIframeLifecycle.staleShortcutComplete)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.mailflowFixtureIframeLifecycle.currentSourceBlocked)).toBe(true);

  expect(await page.evaluate(() => window.mailflowFixtureState)).toMatchObject({
    generation: initial.generation + 1, status: 'pending', visibility: 'hidden',
  });
  const guarded = await page.evaluate(() => ({
    processCalls: window.mailflowFixtureResult.processCalls,
    geometryPasses: window.mailflowFixtureIframeLifecycle.geometryPasses,
    rejectedSources: window.mailflowFixtureIframeLifecycle.rejectedSources,
    staleShortcutAttempts: window.mailflowFixtureIframeLifecycle.staleShortcutAttempts,
  }));
  expect(guarded).toMatchObject({
    processCalls: before.processCalls,
    geometryPasses: before.geometryPasses,
    staleShortcutAttempts: 1,
  });
  expect(guarded.rejectedSources).toBeGreaterThan(before.lifecycle.rejectedSources);

  await page.evaluate(() => window.mailflowFixtureReleaseCurrentSource());
  await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.rootKey)).toBe(initial.rootKey + 1);
  const terminal = await terminalResult(page, /original/);
  const after = await page.evaluate(() => ({
    lifecycle: { ...window.mailflowFixtureIframeLifecycle },
    sameFrame: document.querySelector('iframe') === window.mailflowFixtureFrameBeforeStaleShortcut,
  }));
  expect(terminal).toMatchObject({
    visibility: 'visible', processCalls: before.processCalls + 1,
  });
  expect(after.sameFrame).toBe(true);
  expect(after.lifecycle).toMatchObject({
    insertions: before.lifecycle.insertions,
    removals: before.lifecycle.removals,
    navigationAttempts: before.lifecycle.navigationAttempts + 1,
    loads: before.lifecycle.loads + 1,
    geometryPasses: before.geometryPasses + 1,
  });
});

test('controller iframe paints a >5,000-node fallback before synchronous geometry', async ({ page }) => {
  await page.goto('/e2e/email-appearance/fixture.html?renderer=iframe&fixture=plain&theme=dark&mode=auto&scenario=paint-before-geometry');
  await terminalResult(page, /fallback/);
  await expect.poll(() => page.evaluate(() => window.mailflowFixtureFirstVisibleAt)).toEqual(expect.any(Number));
  const timing = await page.evaluate(() => ({
    firstVisibleAt: window.mailflowFixtureFirstVisibleAt,
    paintObservedBeforeGeometry: window.mailflowFixturePaintObservedBeforeGeometry,
    geometryStartedAt: window.mailflowFixtureGeometryStartedAt,
    geometryFinishedAt: window.mailflowFixtureGeometryFinishedAt,
  }));

  expect(timing.paintObservedBeforeGeometry).toBe(true);
  expect(timing.firstVisibleAt).toBeLessThanOrEqual(timing.geometryStartedAt);
  expect(timing.geometryFinishedAt).toBeGreaterThanOrEqual(timing.geometryStartedAt);
});

test('controller iframe reveals after DOM parsing while a subresource is still pending', async ({ page }) => {
  let releaseResource;
  await page.route('**/never-resolves.png', async route => {
    await new Promise(resolve => { releaseResource = resolve; });
    await route.abort();
  });
  await page.goto(
    '/e2e/email-appearance/fixture.html?renderer=iframe&fixture=plain&theme=dark&mode=auto&scenario=dom-parsed-no-load',
    { waitUntil: 'domcontentloaded' },
  );

  try {
    const result = await terminalResult(page, /themed/);
    expect(result).toMatchObject({ visibility: 'visible', geometryPasses: 1 });
    expect(result.geometry.scale).toBeLessThan(1);
    expect(await page.evaluate(() => document.querySelector('iframe').contentDocument.readyState)).toBe('interactive');
    releaseResource?.();
    releaseResource = null;
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureIframeLifecycle.loads)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureIframeLifecycle.scaleAfterLoad)).toBe(result.geometry.scale);
  } finally {
    releaseResource?.();
  }
});

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} keeps sender styles when analysis reaches its complexity bound`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=analysis-style-complexity`);
    const result = await terminalResult(page, /fallback/);

    expect(result).toMatchObject({
      status: 'fallback', reason: 'style_complexity_limit', visibility: 'visible',
      recovery: false, generation: 1, rootCount: 1, parseCount: 1,
      analyzerLoaded: true, analyzerCalls: 1, commitCalls: 0,
    });
    expect(result.senderStyleRuleCount).toBeGreaterThan(0);
  });
}

for (const scenario of [
  'complex-pseudo-selector', 'complex-structural-selector',
  'authored-style-complexity',
  'escaped-continuation-selector', 'variable-amplification',
  'escaped-variable-delimiter', 'attribute-expansion', 'long-selector', 'nesting-depth', 'tracked-pseudo',
]) {
  for (const renderer of ['iframe', 'div']) {
    test(`controller ${renderer} keeps sender styles after ${scenario} preflight fallback`, async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=${scenario}`);
      const result = await terminalResult(page);

      expect(result).toMatchObject({
        status: 'fallback',
        visibility: 'visible',
        recovery: false,
        generation: 1,
        rootCount: 1,
        parseCount: 1,
        analyzerLoaded: false,
        analyzerCalls: 0,
        commitCalls: 0,
        reason: 'style_complexity_limit',
      });
      if (scenario === 'authored-style-complexity') {
        expect(result.senderInlineStylePresent).toBe(true);
      } else if (scenario !== 'escaped-continuation-selector') {
        expect(result.senderStyleRuleCount).toBeGreaterThan(0);
      }
    });
  }
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} strips sender styles when complexity forced-light restore exceeds its rule limit`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=style-resolution-complexity`);
    const result = await terminalResult(page, /fallback/);

    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', recovery: true,
      generation: 2, rootCount: 2, parseCount: 2,
      senderStyleRuleCount: 0, analyzerLoaded: false, analyzerCalls: 0, commitCalls: 0,
    });
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} strips sender styles only after complexity forced-light restore fails`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=complexity-baseline-persistent`);
    const result = await terminalResult(page, /fallback/);

    expect(result).toMatchObject({
      status: 'fallback', visibility: 'visible', recovery: true,
      generation: 2, rootCount: 2, parseCount: 2,
      senderStyleRuleCount: 0, analyzerLoaded: false, analyzerCalls: 0, commitCalls: 0,
    });
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} complexity fallback preserves style-like visible text`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=recovery-style-text`);
    const result = await terminalResult(page, /fallback/);

    expect(result).toMatchObject({
      recovery: false,
      rootCount: 1,
      analyzerLoaded: false,
      senderInlineStylePresent: true,
      reason: 'style_complexity_limit',
    });
    expect(await page.evaluate(() => window.mailflowFixtureRoot.textContent)).toContain('My style="bold" today');
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} preflights node overflow before its first renderer root`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=nodes-5001`);
    const result = await terminalResult(page, /fallback/);

    expect(result).toMatchObject({
      recovery: false,
      generation: 1,
      rootCount: 1,
      parseCount: 1,
      analyzerLoaded: false,
      analyzerCalls: 0,
      commitCalls: 0,
      senderInlineStylePresent: false,
      senderStyleRuleCount: 0,
    });
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} keeps styles for hostile async HTML after complexity preflight`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto`);
    const initial = await terminalResult(page, /themed/);
    const processedBefore = await page.evaluate(() => window.mailflowFixtureProcessedRoots.length);
    await page.evaluate(() => window.mailflowFixtureReplaceScenario('complex-structural-selector'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.generation)).toBe(initial.generation + 1);
    const result = await terminalResult(page, /fallback/);
    const hostileRoots = await page.evaluate(offset => window.mailflowFixtureProcessedRoots.slice(offset).filter(entry => entry.newRoot), processedBefore);

    expect(result).toMatchObject({ recovery: false, analyzerCalls: initial.analyzerCalls, commitCalls: initial.commitCalls });
    expect(hostileRoots).toHaveLength(1);
    expect(hostileRoots[0].senderStyleRuleCount).toBeGreaterThan(0);
  });

  test(`controller ${renderer} drops a stale Original override before a hostile message switch`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto`);
    await terminalResult(page, /themed/);
    await page.evaluate(() => window.mailflowFixtureAction('view'));
    const original = await terminalResult(page, /original/);
    const processedBefore = await page.evaluate(() => window.mailflowFixtureProcessedRoots.length);
    await page.evaluate(() => window.mailflowFixtureReplaceMessageScenario('complex-structural-selector'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.generation)).toBe(original.generation + 1);
    const result = await terminalResult(page, /fallback/);
    const hostileRoots = await page.evaluate(offset => window.mailflowFixtureProcessedRoots.slice(offset).filter(entry => entry.newRoot), processedBefore);

    expect(result).toMatchObject({ desiredMode: 'auto', renderMode: 'original', recovery: false });
    expect(hostileRoots).toHaveLength(1);
    expect(hostileRoots[0].senderStyleRuleCount).toBeGreaterThan(0);
  });

  test(`controller ${renderer} does not carry a complexity fallback onto safe replacement HTML`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=complex-structural-selector`);
    const hostile = await terminalResult(page, /fallback/);
    const processedBefore = await page.evaluate(() => window.mailflowFixtureProcessedRoots.length);
    await page.evaluate(() => window.mailflowFixtureReplaceScenario('safe-preflight-style'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.generation)).toBe(hostile.generation + 1);
    const safe = await terminalResult(page, /themed/);
    const safeRoots = await page.evaluate(offset => window.mailflowFixtureProcessedRoots.slice(offset).filter(entry => entry.newRoot), processedBefore);

    expect(safe).toMatchObject({ recovery: false, renderMode: 'auto', rootCount: 2, parseCount: 2 });
    expect(safeRoots).toHaveLength(1);
    expect(safeRoots[0].senderInlineStylePresent).toBe(true);
    expect(safeRoots[0].senderStyleRuleCount).toBeGreaterThan(0);
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} recovery toggle follows desired rather than rendered mode`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto&scenario=rollback-failure`);
    const recovered = await terminalResult(page, /fallback/);
    expect(recovered).toMatchObject({
      desiredMode: 'auto', renderMode: 'original', recovery: true,
      toggleLabelKey: 'message.showOriginalColors',
    });

    await page.evaluate(() => window.mailflowFixtureAction('view'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.generation)).toBe(recovered.generation + 1);
    const original = await terminalResult(page, /original/);
    expect(original).toMatchObject({
      desiredMode: 'original', renderMode: 'original',
      toggleLabelKey: 'message.matchThemeColors',
    });

    await page.evaluate(() => window.mailflowFixtureAction('view'));
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.generation)).toBeGreaterThan(original.generation);
    const retried = await terminalResult(page);
    expect(retried).toMatchObject({
      desiredMode: 'auto', toggleLabelKey: 'message.showOriginalColors',
    });
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} preserves the mounted document across view changes`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=original`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
    const initialRenderKey = await page.evaluate(() => window.mailflowFixtureResult.renderKey);
    await page.evaluate(() => {
      window.mailflowFixtureRoot.querySelector('#message')?.style.setProperty('color', 'rgb(1, 2, 3)', 'important');
    });

    await page.evaluate(() => window.mailflowFixtureToggle());
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.renderMode)).toBe('auto');
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toMatch(/^(themed|fallback)$/);
    expect(await page.evaluate(() => window.mailflowFixtureResult.renderKey)).toBe(initialRenderKey);
    expect(await page.evaluate(() => window.mailflowFixtureResult.rootChanged)).toBe(false);
    expect(await page.evaluate(() => window.mailflowFixtureRoot.querySelector('#message')?.style.color || '')).toBe('rgb(1, 2, 3)');

    await page.evaluate(() => window.mailflowFixtureToggle());
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
    expect(await page.evaluate(() => window.mailflowFixtureResult.renderKey)).toBe(initialRenderKey);
    expect(await page.evaluate(() => window.mailflowFixtureRoot.querySelector('#message')?.style.color || '')).toBe('rgb(1, 2, 3)');
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`controller ${renderer} restores earlier media rewrites before a fail-closed fallback`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=dark&mode=auto&scenario=color-scheme-only-media`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('themed');
    const result = await page.evaluate(() => window.mailflowFixturePartialMediaFailure());
    expect(result.automatic).toEqual({ status: 'fallback', reason: 'media_rule_unwritable' });
    expect(result.fallback).toMatchObject({ status: 'ready', removedSheets: 1 });
    expect(result.firstMediaText).toContain('max-width: -1px');
    expect(result.secondRemoved).toBe(true);
  });
}

for (const renderer of ['iframe', 'div']) {
  test.describe(`controller ${renderer}`, () => {
    test('commits an automatic draft before revealing it', async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=auto`);
      await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('themed');
      await expect(page.locator('body')).toHaveAttribute('data-status', 'themed');
      const result = await page.evaluate(() => window.mailflowFixtureResult);
      expect(result).toMatchObject({ status: 'themed', renderer, mode: 'auto', visibility: 'visible' });
      expect(result.analyzerCalls).toBeGreaterThan(0);
      expect(result.changedTextContrast.length).toBeGreaterThan(0);
      expect(result.changedTextContrast.every(value => value >= 4.5)).toBe(true);
    });

    test('keeps original mode forced-light without loading the automatic analyzer', async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=original`);
      await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
      await expect(page.locator('body')).toHaveAttribute('data-status', 'original');
      const result = await page.evaluate(() => window.mailflowFixtureResult);
      expect(result).toMatchObject({ status: 'original', renderer, analyzerLoaded: false, visibility: 'visible' });
    });
  });
}

for (const renderer of ['iframe', 'div']) {
  test.describe(`sender media ${renderer}`, () => {
    test.use({ colorScheme: 'light' });

    test('selects sender dark rules independently of the operating system', async ({ page }) => {
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=dark&mode=original`);
      await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
      const result = await page.evaluate(() => window.mailflowFixtureResult);
      expect(result.media).toMatchObject({ status: 'ready' });
      expect(result.colors.cardBackground).toBe('rgb(18, 24, 38)');
      expect(result.root.attributes).toEqual({ ogsc: true, ogsb: true });
      expect(result.root.colorScheme).toBe('dark');
      expect(result.malformedSelectorPresent).toBe(false);
      expect(result.secondPass).toMatchObject({ status: 'ready' });
      expect(result.secondPass.cardBackground).toBe('rgb(255, 255, 255)');
    });

    test('selects light sender rules while the operating system is dark', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=light&mode=original`);
      await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
      const result = await page.evaluate(() => window.mailflowFixtureResult);
      expect(result.media).toMatchObject({ status: 'ready' });
      expect(result.colors.cardBackground).toBe('rgb(255, 255, 255)');
      expect(result.root.attributes).toEqual({ ogsc: false, ogsb: false });
      expect(result.root.colorScheme).toBe('light');
    });

    test('preserves responsive clauses after selecting sender media', async ({ page }) => {
      await page.setViewportSize({ width: 400, height: 700 });
      await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=plain&theme=dark&mode=original&scenario=responsive-color-scheme`);
      await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
      const responsive = renderer === 'iframe'
        ? page.frameLocator('iframe').locator('.responsive-flag')
        : page.locator('[data-fixture-root] .responsive-flag');
      await expect(responsive).toHaveCSS('color', 'rgb(7, 8, 9)');
      await page.setViewportSize({ width: 700, height: 700 });
      await expect(responsive).toHaveCSS('color', 'rgb(1, 2, 3)');
    });
  });
}

for (const renderer of ['iframe', 'div']) {
  test(`sender media ${renderer} reports unwritable rules and preserves the base`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=dark&mode=original`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
    const result = await page.evaluate(() => window.mailflowFixtureMediaFailure());
    expect(result.automatic).toEqual({ status: 'fallback', reason: 'media_rule_unwritable' });
    expect(result.original).toMatchObject({ status: 'ready', removedSheets: 1 });
    expect(result.baseRetained).toBe(true);
  });

  test(`sender media ${renderer} fail-closes over-budget sender styles`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=light&mode=original`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
    const result = await page.evaluate(() => window.mailflowFixtureMediaBudgetFailure());
    expect(result.automatic).toEqual({ status: 'fallback', reason: 'media_rule_limit' });
    expect(result.original).toMatchObject({ status: 'ready', removedSheets: 2 });
    expect(result.senderRetained).toBe(false);
    expect(result.baseRetained).toBe(true);
  });

  test(`sender media ${renderer} fail-closes when its deadline expires`, async ({ page }) => {
    await page.goto(`/e2e/email-appearance/fixture.html?renderer=${renderer}&fixture=native-dark&theme=light&mode=original`);
    await expect.poll(() => page.evaluate(() => window.mailflowFixtureResult?.status)).toBe('original');
    const result = await page.evaluate(() => window.mailflowFixtureMediaDeadlineFailure());
    expect(result.automatic).toEqual({ status: 'fallback', reason: 'media_deadline' });
    expect(result.original).toMatchObject({ status: 'ready', removedSheets: 2 });
    expect(result.senderRetained).toBe(false);
    expect(result.baseRetained).toBe(true);
  });
}
