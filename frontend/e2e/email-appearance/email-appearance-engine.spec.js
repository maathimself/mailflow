import { expect, test } from '@playwright/test';
import { planEmailAppearance } from '../../src/utils/emailAppearance.js';
import { compositeColors, contrastRatio, parseCssColor } from '../../src/utils/emailColors.js';

const baseStyle = {
  color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(255, 255, 255)', backgroundImage: 'none',
  borderTopColor: 'rgb(220, 220, 220)', borderTopWidth: '1px', borderTopStyle: 'solid',
  borderRightColor: 'rgb(220, 220, 220)', borderRightWidth: '1px', borderRightStyle: 'solid',
  borderBottomColor: 'rgb(220, 220, 220)', borderBottomWidth: '1px', borderBottomStyle: 'solid',
  borderLeftColor: 'rgb(220, 220, 220)', borderLeftWidth: '1px', borderLeftStyle: 'solid',
  opacity: '1', filter: 'none', backdropFilter: 'none', mixBlendMode: 'normal', backgroundBlendMode: 'normal',
};

function snapshot(overrides = {}) {
  return {
    element: { style: {} }, parentIndex: -1, tagName: 'DIV', isCanvas: false,
    hasOwnText: true, imageOnlyBacking: false, ...overrides,
    style: { ...baseStyle, ...overrides.style },
  };
}

function mutationFor(result, element, property) {
  return result.mutations.find(mutation => mutation.element === element && mutation.property === property);
}

test('committed repairs retain their recorded contrast in computed CSS @engine-quantization', async ({ page }) => {
  const palette = {
    background: parseCssColor('#000'), elevated: parseCssColor('#fff'),
    text: parseCssColor('#fff'), mutedText: parseCssColor('#aaa'),
    accent: parseCssColor('#777'), border: parseCssColor('#555'),
    fingerprint: 'browser-representation',
  };
  const canvas = snapshot({ isCanvas: true, hasOwnText: false, style: { backgroundColor: 'rgb(0, 0, 0)' } });
  const link = snapshot({
    parentIndex: 0, tagName: 'A', style: { color: 'rgb(99, 102, 241)', backgroundColor: 'rgb(255, 255, 255)' },
  });
  const border = snapshot({
    isCanvas: true, hasOwnText: false,
    style: { backgroundColor: 'rgb(255, 255, 255)', borderTopColor: 'rgb(128, 0, 0)' },
  });
  const linkPlan = planEmailAppearance([canvas, link], palette);
  const borderPlan = planEmailAppearance([border], { ...palette, elevated: palette.background });
  const planned = {
    linkColor: mutationFor(linkPlan, link.element, 'color'),
    linkBackground: mutationFor(linkPlan, link.element, 'background-color'),
    borderColor: mutationFor(borderPlan, border.element, 'border-top-color'),
    borderBackground: mutationFor(borderPlan, border.element, 'background-color'),
  };

  const computed = await page.evaluate((values) => {
    const linkElement = document.createElement('a');
    linkElement.style.setProperty('color', values.linkColor.value, 'important');
    linkElement.style.setProperty('background-color', values.linkBackground.value, 'important');
    linkElement.textContent = 'Link';
    const borderElement = document.createElement('div');
    borderElement.style.setProperty('background-color', values.borderBackground.value, 'important');
    borderElement.style.setProperty('border-top', `1px solid ${values.borderColor.value}`, 'important');
    document.body.append(linkElement, borderElement);
    const linkStyle = getComputedStyle(linkElement);
    const borderStyle = getComputedStyle(borderElement);
    return {
      linkColor: linkStyle.color,
      linkBackground: linkStyle.backgroundColor,
      borderColor: borderStyle.borderTopColor,
      borderBackground: borderStyle.backgroundColor,
    };
  }, planned);

  const linkContrast = contrastRatio(parseCssColor(computed.linkColor), parseCssColor(computed.linkBackground));
  const borderContrast = contrastRatio(parseCssColor(computed.borderColor), parseCssColor(computed.borderBackground));
  expect(linkContrast).toBeGreaterThanOrEqual(4.5);
  expect(borderContrast).toBeGreaterThanOrEqual(3);
  expect(Math.abs(linkContrast - planned.linkColor.targetContrast)).toBeLessThan(1e-12);
  expect(Math.abs(borderContrast - planned.borderColor.targetContrast)).toBeLessThan(1e-12);
});

test('unchanged transparent backgrounds retain computed alpha evidence @engine-quantization', async ({ page }) => {
  const source = await page.evaluate(() => {
    const canvas = document.createElement('div');
    canvas.style.backgroundColor = 'rgb(0, 0, 0)';
    const link = document.createElement('a');
    link.style.color = 'rgb(99, 102, 241)';
    link.style.backgroundColor = 'rgba(255, 255, 255, 0.499)';
    link.textContent = 'Transparent link';
    canvas.append(link);
    document.body.append(canvas);
    return {
      canvasBackground: getComputedStyle(canvas).backgroundColor,
      linkBackground: getComputedStyle(link).backgroundColor,
      linkColor: getComputedStyle(link).color,
    };
  });
  const palette = {
    background: parseCssColor('#000'), elevated: parseCssColor('#000'),
    text: parseCssColor('#fff'), mutedText: parseCssColor('#aaa'),
    accent: parseCssColor('#777'), border: parseCssColor('#777'),
    fingerprint: 'transparent-engine-representation',
  };
  const canvas = snapshot({
    isCanvas: true, hasOwnText: false, style: { backgroundColor: source.canvasBackground },
  });
  const link = snapshot({
    parentIndex: 0, tagName: 'A',
    style: { color: source.linkColor, backgroundColor: source.linkBackground },
  });
  const plan = planEmailAppearance([canvas, link], palette);
  const color = mutationFor(plan, link.element, 'color');
  expect(mutationFor(plan, link.element, 'background-color')).toBeUndefined();

  const computed = await page.evaluate((value) => {
    const canvasElement = document.createElement('div');
    canvasElement.style.backgroundColor = 'rgb(0, 0, 0)';
    const linkElement = document.createElement('a');
    linkElement.style.color = value;
    linkElement.style.backgroundColor = 'rgba(255, 255, 255, 0.499)';
    linkElement.textContent = 'Transparent link';
    canvasElement.append(linkElement);
    document.body.append(canvasElement);
    return {
      canvasBackground: getComputedStyle(canvasElement).backgroundColor,
      linkBackground: getComputedStyle(linkElement).backgroundColor,
      linkColor: getComputedStyle(linkElement).color,
    };
  }, color.value);
  const effectiveBackground = compositeColors(
    parseCssColor(computed.linkBackground),
    parseCssColor(computed.canvasBackground),
  );
  const renderedContrast = contrastRatio(parseCssColor(computed.linkColor), effectiveBackground);
  expect(renderedContrast).toBeGreaterThanOrEqual(4.5);
  expect(Math.abs(renderedContrast - color.targetContrast)).toBeLessThan(1e-12);
});

test('protected boundaries prove descendant contrast against committed computed CSS @engine-quantization', async ({ page }) => {
  const source = await page.evaluate(() => {
    const root = document.createElement('div');
    root.style.backgroundColor = 'rgb(255, 255, 255)';
    const createBoundary = alpha => {
      const boundary = document.createElement('div');
      boundary.style.backgroundColor = `rgba(0, 0, 0, ${alpha})`;
      const island = document.createElement('div');
      island.style.opacity = '0.5';
      const descendant = document.createElement('div');
      descendant.style.backgroundColor = 'rgba(0, 0, 0, 0)';
      boundary.append(island, descendant);
      root.append(boundary);
      return { boundary, island, descendant };
    };
    const text = createBoundary('0.01');
    text.descendant.textContent = 'Protected boundary text';
    const border = createBoundary('0.65');
    border.descendant.style.borderTop = '1px solid rgb(0, 0, 0)';
    document.body.append(root);
    const styles = element => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderTopColor: style.borderTopColor,
        borderTopWidth: style.borderTopWidth,
        borderTopStyle: style.borderTopStyle,
        borderRightColor: style.borderRightColor,
        borderRightWidth: style.borderRightWidth,
        borderRightStyle: style.borderRightStyle,
        borderBottomColor: style.borderBottomColor,
        borderBottomWidth: style.borderBottomWidth,
        borderBottomStyle: style.borderBottomStyle,
        borderLeftColor: style.borderLeftColor,
        borderLeftWidth: style.borderLeftWidth,
        borderLeftStyle: style.borderLeftStyle,
        opacity: style.opacity,
        filter: style.filter,
        backdropFilter: style.backdropFilter,
        mixBlendMode: style.mixBlendMode,
        backgroundBlendMode: style.backgroundBlendMode,
      };
    };
    return {
      root: styles(root),
      textBoundary: styles(text.boundary), textIsland: styles(text.island), text: styles(text.descendant),
      borderBoundary: styles(border.boundary), borderIsland: styles(border.island), border: styles(border.descendant),
    };
  });
  const palette = {
    background: parseCssColor('#121826'), elevated: parseCssColor('#20293a'),
    text: parseCssColor('#757575'), mutedText: parseCssColor('#757575'),
    accent: parseCssColor('#777'), border: parseCssColor('#000'),
    fingerprint: 'protected-boundary-engine-representation',
  };
  const root = snapshot({ isCanvas: true, hasOwnText: false, style: source.root });
  const textBoundary = snapshot({ parentIndex: 0, hasOwnText: false, style: source.textBoundary });
  const textIsland = snapshot({ parentIndex: 1, hasOwnText: false, style: source.textIsland });
  const text = snapshot({ parentIndex: 1, style: source.text });
  const borderBoundary = snapshot({ parentIndex: 0, hasOwnText: false, style: source.borderBoundary });
  const borderIsland = snapshot({ parentIndex: 4, hasOwnText: false, style: source.borderIsland });
  const border = snapshot({ parentIndex: 4, hasOwnText: false, style: source.border });
  const result = planEmailAppearance([
    root, textBoundary, textIsland, text, borderBoundary, borderIsland, border,
  ], palette);
  const planned = {
    textBackground: mutationFor(result, textBoundary.element, 'background-color'),
    textColor: mutationFor(result, text.element, 'color'),
    borderBackground: mutationFor(result, borderBoundary.element, 'background-color'),
    borderColor: mutationFor(result, border.element, 'border-top-color'),
  };

  const computed = await page.evaluate((values) => {
    const textBoundary = document.createElement('div');
    textBoundary.style.setProperty('background-color', values.textBackground.value, 'important');
    const text = document.createElement('div');
    text.style.setProperty('color', values.textColor.value, 'important');
    text.textContent = 'Protected boundary text';
    textBoundary.append(text);
    const borderBoundary = document.createElement('div');
    borderBoundary.style.setProperty('background-color', values.borderBackground.value, 'important');
    const border = document.createElement('div');
    border.style.setProperty('border-top', `1px solid ${values.borderColor.value}`, 'important');
    borderBoundary.append(border);
    document.body.append(textBoundary, borderBoundary);
    return {
      textBackground: getComputedStyle(textBoundary).backgroundColor,
      textColor: getComputedStyle(text).color,
      borderBackground: getComputedStyle(borderBoundary).backgroundColor,
      borderColor: getComputedStyle(border).borderTopColor,
    };
  }, planned);
  const textContrast = contrastRatio(parseCssColor(computed.textColor), parseCssColor(computed.textBackground));
  const borderContrast = contrastRatio(parseCssColor(computed.borderColor), parseCssColor(computed.borderBackground));
  expect(textContrast).toBeGreaterThanOrEqual(4.5);
  expect(borderContrast).toBeGreaterThanOrEqual(3);
  expect(Math.abs(textContrast - planned.textColor.targetContrast)).toBeLessThan(1e-12);
  expect(Math.abs(borderContrast - planned.borderColor.targetContrast)).toBeLessThan(1e-12);
});
