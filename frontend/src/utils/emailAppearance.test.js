import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeEmailAppearance,
  commitEmailAppearance,
  planEmailAppearance,
} from './emailAppearance.js';
import {
  compositeColors,
  contrastRatio,
  parseCssColor,
  rgbToHsl,
} from './emailColors.js';

const palette = {
  background: parseCssColor('#121826'),
  elevated: parseCssColor('#20293a'),
  text: parseCssColor('#f4f7fb'),
  mutedText: parseCssColor('#b7c2d4'),
  accent: parseCssColor('#8b9dff'),
  border: parseCssColor('#667085'),
  fingerprint: 'test-dark',
};

const baseStyle = {
  color: 'rgb(0, 0, 0)',
  webkitTextFillColor: 'currentcolor',
  backgroundColor: 'rgb(255, 255, 255)',
  backgroundImage: 'none',
  borderTopColor: 'rgb(220, 220, 220)', borderTopWidth: '1px', borderTopStyle: 'solid',
  borderRightColor: 'rgb(220, 220, 220)', borderRightWidth: '1px', borderRightStyle: 'solid',
  borderBottomColor: 'rgb(220, 220, 220)', borderBottomWidth: '1px', borderBottomStyle: 'solid',
  borderLeftColor: 'rgb(220, 220, 220)', borderLeftWidth: '1px', borderLeftStyle: 'solid',
  opacity: '1', filter: 'none', backdropFilter: 'none', mixBlendMode: 'normal', backgroundBlendMode: 'normal',
  animationName: 'none', animationDuration: '0s', animationDelay: '0s',
  transitionProperty: 'all', transitionDuration: '0s', transitionDelay: '0s',
};

function fakeElement() {
  const values = new Map();
  const priorities = new Map();
  return {
    style: {
      getPropertyValue: property => values.get(property) || '',
      getPropertyPriority: property => priorities.get(property) || '',
      setProperty(property, value, priority = '') { values.set(property, value); priorities.set(property, priority); },
      removeProperty(property) { values.delete(property); priorities.delete(property); },
    },
  };
}

function node(overrides = {}) {
  return {
    element: fakeElement(), parentIndex: -1, tagName: 'DIV', isCanvas: false,
    hasOwnText: true, imageOnlyBacking: false, ...overrides,
    style: { ...baseStyle, ...overrides.style },
  };
}

function mutationFor(result, element, property) {
  return result.mutations.find(mutation => mutation.element === element && mutation.property === property);
}

describe('planEmailAppearance', () => {
  it('fails closed when a divergent text fill can bypass the planned foreground', () => {
    const element = node({
      style: {
        color: 'rgb(17, 17, 17)',
        webkitTextFillColor: 'rgb(0, 0, 0)',
      },
    });

    const result = planEmailAppearance([element], palette);

    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, 'text_fill_unproven');
  });

  for (const [name, webkitTextFillColor] of [
    ['currentColor', 'currentcolor'],
    ['unsupported empty value', ''],
  ]) {
    it(`accepts ${name} text fill semantics`, () => {
      const result = planEmailAppearance([node({
        style: { color: 'rgb(17, 17, 17)', webkitTextFillColor },
      })], palette);

      assert.equal(result.status, 'ready');
    });
  }

  it('repairs an equal computed text fill alongside its foreground', () => {
    const element = node({
      style: {
        color: 'rgb(17, 17, 17)',
        webkitTextFillColor: 'rgb(17, 17, 17)',
      },
    });

    const result = planEmailAppearance([element], palette);
    const color = mutationFor(result, element.element, 'color');
    const textFill = mutationFor(result, element.element, '-webkit-text-fill-color');

    assert.equal(result.status, 'ready');
    assert.equal(textFill.value, color.value);
    assert.equal(textFill.targetContrast, color.targetContrast);
  });

  it('ignores divergent text fill on nodes without their own text', () => {
    const result = planEmailAppearance([node({
      hasOwnText: false,
      style: { webkitTextFillColor: 'rgb(0, 0, 0)' },
    })], palette);

    assert.equal(result.status, 'ready');
  });

  it('maps neutral canvas colors into the palette with readable evidence', () => {
    const canvas = node({ isCanvas: true });
    const result = planEmailAppearance([canvas], palette);
    const color = mutationFor(result, canvas.element, 'color');
    const background = mutationFor(result, canvas.element, 'background-color');

    assert.equal(result.status, 'ready');
    assert.equal(background.value, 'rgb(18, 24, 38)');
    assert.ok(color.targetContrast >= 4.5);
    assert.ok(contrastRatio(parseCssColor(color.value), parseCssColor(background.value)) >= 4.5);
  });

  it('maps the renderer canvas directly to the background instead of elevated', () => {
    const canvas = node({ isCanvas: true, style: { backgroundColor: 'rgb(230, 230, 230)' } });
    const result = planEmailAppearance([canvas], palette);
    assert.equal(mutationFor(result, canvas.element, 'background-color').value, 'rgb(18, 24, 38)');
  });

  it('maps a transparent scoped canvas directly to the palette background', () => {
    const canvas = node({
      isCanvas: true, hasOwnText: false, style: { backgroundColor: 'rgba(0, 0, 0, 0)' },
    });
    const result = planEmailAppearance([canvas], palette);
    const background = mutationFor(result, canvas.element, 'background-color');
    assert.equal(background.value, 'rgb(18, 24, 38)');
  });

  it('keeps an already-readable chromatic foreground unchanged', () => {
    const element = node({
      style: { color: 'rgb(255, 80, 80)', backgroundColor: 'rgb(18, 24, 38)' },
    });
    const result = planEmailAppearance([element], palette);
    assert.equal(mutationFor(result, element.element, 'color'), undefined);
  });

  it('keeps default-link mapping separate from an ordinary chromatic foreground cache entry', () => {
    const canvas = node({ isCanvas: true, hasOwnText: false });
    const link = node({
      parentIndex: 0, tagName: 'A', style: { color: 'rgb(99, 102, 241)', backgroundColor: 'rgba(0, 0, 0, 0)' },
    });
    const ordinary = node({
      parentIndex: 0, style: { color: 'rgb(99, 102, 241)', backgroundColor: 'rgba(0, 0, 0, 0)' },
    });
    const result = planEmailAppearance([canvas, link, ordinary], palette);
    const linkColor = mutationFor(result, link.element, 'color');
    const ordinaryColor = mutationFor(result, ordinary.element, 'color');
    assert.equal(linkColor.value, 'rgb(139, 157, 255)');
    assert.ok(ordinaryColor);
    assert.notEqual(ordinaryColor.value, linkColor.value);
  });

  it('repairs an injected default link against its local elevated surface', () => {
    const localPalette = {
      ...palette,
      background: parseCssColor('#000'),
      elevated: parseCssColor('#fff'),
      accent: parseCssColor('#777'),
      fingerprint: 'local-elevated-link',
    };
    const canvas = node({ isCanvas: true, hasOwnText: false, style: { backgroundColor: 'rgb(0, 0, 0)' } });
    const link = node({
      parentIndex: 0, tagName: 'A', style: { color: 'rgb(99, 102, 241)', backgroundColor: 'rgb(255, 255, 255)' },
    });
    const result = planEmailAppearance([canvas, link], localPalette);
    const color = mutationFor(result, link.element, 'color');
    const background = mutationFor(result, link.element, 'background-color');
    assert.equal(result.status, 'ready');
    assert.match(color.value, /^rgb\(\d+, \d+, \d+\)$/);
    assert.ok(color.targetContrast >= 4.5);
    assert.ok(contrastRatio(parseCssColor(color.value), parseCssColor(background.value)) >= 4.5);
    assert.ok(Math.abs(
      color.targetContrast - contrastRatio(parseCssColor(color.value), parseCssColor(background.value)),
    ) < 1e-12);
  });

  it('keeps foreground evidence and neutral targets separate when source backdrops differ', () => {
    const firstCanvas = node({ isCanvas: true, hasOwnText: false });
    const firstText = node({ parentIndex: 0, style: { backgroundColor: 'rgba(0, 0, 0, 0)' } });
    const secondCanvas = node({
      isCanvas: true, hasOwnText: false, style: { backgroundColor: 'rgb(0, 0, 0)' },
    });
    const secondText = node({ parentIndex: 2, style: { backgroundColor: 'rgba(0, 0, 0, 0)' } });
    const result = planEmailAppearance([firstCanvas, firstText, secondCanvas, secondText], palette);
    const first = mutationFor(result, firstText.element, 'color');
    const second = mutationFor(result, secondText.element, 'color');
    assert.ok(Math.abs(first.sourceContrast - 21) < 0.001);
    assert.ok(Math.abs(second.sourceContrast - 1) < 0.001);
    assert.notEqual(first.value, second.value);
  });

  it('preserves an unchanged transparent background alpha when proving local text contrast', () => {
    const localPalette = {
      ...palette,
      background: parseCssColor('#000'),
      elevated: parseCssColor('#000'),
      accent: parseCssColor('#777'),
      fingerprint: 'unchanged-transparent-alpha',
    };
    const canvas = node({ isCanvas: true, hasOwnText: false, style: { backgroundColor: 'rgb(0, 0, 0)' } });
    const link = node({
      parentIndex: 0, tagName: 'A',
      style: { color: 'rgb(99, 102, 241)', backgroundColor: 'rgba(255, 255, 255, 0.499)' },
    });
    const result = planEmailAppearance([canvas, link], localPalette);
    const color = mutationFor(result, link.element, 'color');
    const actualBackground = compositeColors(parseCssColor(link.style.backgroundColor), localPalette.background);
    assert.equal(mutationFor(result, link.element, 'background-color'), undefined);
    assert.ok(contrastRatio(parseCssColor(color.value), actualBackground) >= 4.5);
    assert.ok(Math.abs(color.targetContrast - contrastRatio(parseCssColor(color.value), actualBackground)) < 1e-12);
  });

  it('repairs failing chromatic foregrounds without changing hue or saturation', () => {
    const element = node({ style: { color: 'rgb(210, 120, 145)', backgroundColor: 'rgb(255, 255, 255)' } });
    const result = planEmailAppearance([element], { ...palette, background: parseCssColor('#fff'), elevated: parseCssColor('#eee') });
    const mutation = mutationFor(result, element.element, 'color');
    const source = rgbToHsl(parseCssColor(element.style.color));
    const target = rgbToHsl(parseCssColor(mutation.value));
    assert.ok(mutation.targetContrast >= 4.5);
    assert.ok(Math.abs(target.h - source.h) < 0.2);
    assert.ok(Math.abs(target.s - source.s) < 0.01);
  });

  it('maps all visible neutral borders with 3:1 evidence', () => {
    const element = node({ isCanvas: true, hasOwnText: false });
    const result = planEmailAppearance([element], palette);
    for (const property of ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']) {
      const mutation = mutationFor(result, element.element, property);
      assert.equal(mutation.value, 'rgb(102, 112, 133)');
      assert.ok(mutation.targetContrast >= 3);
    }
  });

  it('records border source contrast against the source surface, not the planned surface', () => {
    const element = node({ isCanvas: true, hasOwnText: false });
    const result = planEmailAppearance([element], palette);
    const border = mutationFor(result, element.element, 'border-top-color');
    assert.ok(Math.abs(border.sourceContrast - 1.3713058806) < 0.0001);
    assert.ok(border.targetContrast >= 3);
  });

  it('records border evidence for its browser-representable integer repair', () => {
    const localPalette = {
      ...palette,
      background: parseCssColor('#000'),
      elevated: parseCssColor('#000'),
      border: parseCssColor('#555'),
      fingerprint: 'integer-border-repair',
    };
    const element = node({ isCanvas: true, hasOwnText: false, style: { backgroundColor: 'rgb(0, 0, 0)' } });
    const result = planEmailAppearance([element], localPalette);
    const border = mutationFor(result, element.element, 'border-top-color');
    assert.match(border.value, /^rgb\(\d+, \d+, \d+\)$/);
    const representedContrast = contrastRatio(parseCssColor(border.value), localPalette.background);
    assert.ok(representedContrast >= 3);
    assert.ok(Math.abs(border.targetContrast - representedContrast) < 1e-12);
  });

  it('repairs a chromatic border that passes on source white but fails on planned black', () => {
    const localPalette = {
      ...palette,
      background: parseCssColor('#000'),
      elevated: parseCssColor('#000'),
      fingerprint: 'chromatic-border-planned-surface',
    };
    const element = node({
      isCanvas: true,
      hasOwnText: false,
      style: { backgroundColor: 'rgb(255, 255, 255)', borderTopColor: 'rgb(128, 0, 0)' },
    });
    const result = planEmailAppearance([element], localPalette);
    const border = mutationFor(result, element.element, 'border-top-color');
    assert.ok(border.sourceContrast >= 3);
    assert.ok(border.targetContrast >= 3);
    assert.ok(contrastRatio(parseCssColor(border.value), localPalette.background) >= 3);
  });

  it('composites a transparent child background over the planned parent surface', () => {
    const parent = node({ isCanvas: true });
    const child = node({ parentIndex: 0, style: { backgroundColor: 'rgba(255, 255, 255, 0)', color: 'rgb(0, 0, 0)' } });
    const result = planEmailAppearance([parent, child], palette);
    const childBackground = mutationFor(result, child.element, 'background-color');
    const childColor = mutationFor(result, child.element, 'color');
    assert.equal(childBackground, undefined);
    assert.ok(childColor.targetContrast >= 4.5);
  });

  for (const [name, style, extra] of [
    ['background image', { backgroundImage: 'linear-gradient(red, blue)' }],
    ['opacity', { opacity: '0.5' }],
    ['filter', { filter: 'blur(1px)' }],
    ['backdrop filter', { backdropFilter: 'blur(1px)' }],
    ['mix blend mode', { mixBlendMode: 'multiply' }],
    ['background blend mode', { backgroundBlendMode: 'multiply' }],
    ['raster', {}, { tagName: 'IMG' }],
    ['image-only backing', {}, { imageOnlyBacking: true }],
  ]) {
    it(`does not recolor inside a protected ${name} island`, () => {
      const root = node({ isCanvas: true });
      const protectedRoot = node({ parentIndex: 0, hasOwnText: false, style, ...extra });
      const descendant = node({ parentIndex: 1 });
      const result = planEmailAppearance([root, protectedRoot, descendant], palette);
      assert.equal(result.status, 'ready');
      assert.equal(mutationFor(result, descendant.element, 'color'), undefined);
      assert.equal(mutationFor(result, descendant.element, 'background-color'), undefined);
    });
  }

  it('freezes a protected root foreground and its local source backdrop before ancestor repair', () => {
    const root = node({ isCanvas: true, hasOwnText: false });
    const island = node({ parentIndex: 0, hasOwnText: false, tagName: 'IMG', style: { backgroundColor: 'rgba(0, 0, 0, 0)' } });
    const result = planEmailAppearance([root, island], palette);
    const foreground = mutationFor(result, island.element, 'color');
    const backing = mutationFor(result, island.element, 'background-color');
    assert.equal(foreground.kind, 'preserve');
    assert.equal(foreground.value, island.style.color);
    assert.equal(backing.kind, 'preserve');
    assert.equal(backing.value, 'rgb(255, 255, 255)');
  });

  it('freezes the nearest unprotected boundary for a compositing island', () => {
    const root = node({ isCanvas: true, hasOwnText: false });
    const island = node({ parentIndex: 0, hasOwnText: false, style: { opacity: '0.5' } });
    const result = planEmailAppearance([root, island], palette);
    const boundary = mutationFor(result, root.element, 'background-color');
    assert.equal(boundary.kind, 'preserve');
    assert.equal(boundary.value, 'rgb(255, 255, 255)');
  });

  it('proves descendant text and borders against the serialized protected boundary', () => {
    const localPalette = {
      ...palette,
      text: parseCssColor('#757575'),
      mutedText: parseCssColor('#757575'),
      border: parseCssColor('#000'),
      fingerprint: 'serialized-protected-boundary',
    };
    const root = node({ isCanvas: true, hasOwnText: false });
    const textBoundary = node({
      parentIndex: 0, hasOwnText: false, style: { backgroundColor: 'rgba(0, 0, 0, 0.01)' },
    });
    const textIsland = node({ parentIndex: 1, hasOwnText: false, style: { opacity: '0.5' } });
    const text = node({ parentIndex: 1, style: { backgroundColor: 'rgba(0, 0, 0, 0)' } });
    const borderBoundary = node({
      parentIndex: 0, hasOwnText: false, style: { backgroundColor: 'rgba(0, 0, 0, 0.65)' },
    });
    const borderIsland = node({ parentIndex: 4, hasOwnText: false, style: { opacity: '0.5' } });
    const border = node({
      parentIndex: 4, hasOwnText: false,
      style: { backgroundColor: 'rgba(0, 0, 0, 0)', borderTopColor: 'rgb(0, 0, 0)' },
    });
    const result = planEmailAppearance([
      root, textBoundary, textIsland, text, borderBoundary, borderIsland, border,
    ], localPalette);
    const textBoundaryMutation = mutationFor(result, textBoundary.element, 'background-color');
    const textMutation = mutationFor(result, text.element, 'color');
    const borderBoundaryMutation = mutationFor(result, borderBoundary.element, 'background-color');
    const borderMutation = mutationFor(result, border.element, 'border-top-color');
    const writtenTextBackground = parseCssColor(textBoundaryMutation.value);
    const writtenBorderBackground = parseCssColor(borderBoundaryMutation.value);

    assert.equal(result.status, 'ready');
    assert.ok(contrastRatio(parseCssColor(textMutation.value), writtenTextBackground) >= 4.5);
    assert.ok(contrastRatio(parseCssColor(borderMutation.value), writtenBorderBackground) >= 3);
    assert.ok(Math.abs(
      textMutation.targetContrast - contrastRatio(parseCssColor(textMutation.value), writtenTextBackground),
    ) < 1e-12);
    assert.ok(Math.abs(
      borderMutation.targetContrast - contrastRatio(parseCssColor(borderMutation.value), writtenBorderBackground),
    ) < 1e-12);
  });

  it('preserves an image-only backing surface without recoloring it', () => {
    const cell = node({ isCanvas: true, tagName: 'TD', hasOwnText: false, imageOnlyBacking: true });
    const result = planEmailAppearance([cell], palette);
    assert.equal(mutationFor(result, cell.element, 'background-color'), undefined);
  });

  it('falls back rather than emitting an unproven text repair', () => {
    const element = node({ isCanvas: true, style: { color: 'rgba(255, 0, 0, 0.1)' } });
    const result = planEmailAppearance([element], palette);
    assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'fallback', reason: 'contrast_unproven' });
  });

  it('falls back before the 10,001st property mutation', () => {
    const snapshots = Array.from({ length: 2501 }, (_, index) => node({ isCanvas: index === 0 }));
    const result = planEmailAppearance(snapshots, palette, { maxMutations: 10000, maxAnalysisMs: Infinity });
    assert.deepEqual(
      {
        status: result.status,
        reason: result.reason,
        mutationCount: result.mutationCount,
        attemptedMutationCount: result.attemptedMutationCount,
      },
      {
        status: 'fallback',
        reason: 'mutation_limit',
        mutationCount: 10000,
        attemptedMutationCount: 10001,
      },
    );
  });

  it('does not write fake inline styles while planning', () => {
    const element = node({ isCanvas: true });
    planEmailAppearance([element], palette);
    assert.equal(element.element.style.getPropertyValue('color'), '');
    assert.equal(element.element.style.getPropertyValue('background-color'), '');
  });
});

describe('analyzeEmailAppearance budgets', () => {
  function documentWith(elements, { throwStyle = false, querySelectorAll } = {}) {
    const doc = {
      nodeType: 9,
      documentElement: elements[0], body: elements[0],
      createTreeWalker() {
        let index = 0;
        return { nextNode: () => elements[++index] || null };
      },
      defaultView: { getComputedStyle: element => {
        if (throwStyle) throw new Error('denied');
        return element.computed;
      } },
    };
    doc.querySelectorAll = querySelectorAll || (selector => elements.filter(element => element.matches?.(selector)));
    for (const element of elements) {
      element.ownerDocument = doc;
      element.parentElement = element.parentElement || null;
      element.childNodes = [];
      element.tagName = element.tagName || 'DIV';
    }
    return doc;
  }

  function domElement(parent = null) {
    return { ...fakeElement(), computed: baseStyle, parentElement: parent, childNodes: [], tagName: 'DIV' };
  }

  it('stops at the 5,001st collected node before reading computed style', () => {
    const elements = Array.from({ length: 5001 }, () => domElement());
    const result = analyzeEmailAppearance(documentWith(elements, { throwStyle: true }), palette);
    assert.equal(result.reason, 'node_limit');
  });

  it('checks the deadline immediately after collection', () => {
    const elements = Array.from({ length: 64 }, () => domElement());
    const ticks = [0, 2];
    const result = analyzeEmailAppearance(documentWith(elements), palette, {
      maxAnalysisMs: 1, clock: () => ticks.shift() ?? 2,
    });
    assert.equal(result.reason, 'analysis_deadline');
  });

  it('honors an absolute controller deadline instead of starting a fresh analysis window', () => {
    const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
      deadline: 100, maxAnalysisMs: Infinity, clock: () => 100,
    });

    assert.equal(result.reason, 'analysis_deadline');
  });

  it('checks the deadline while reading computed styles', () => {
    const elements = Array.from({ length: 65 }, () => domElement());
    const ticks = [0, 0, 0, 2];
    const result = analyzeEmailAppearance(documentWith(elements), palette, {
      maxAnalysisMs: 1, clock: () => ticks.shift() ?? 2,
    });
    assert.equal(result.reason, 'analysis_deadline');
  });

  it('checks the deadline after pure computation', () => {
    const ticks = [0, 0, 0, 2];
    const result = planEmailAppearance([node({ isCanvas: true })], palette, {
      startedAt: 0, maxAnalysisMs: 1, clock: () => ticks.shift() ?? 2,
    });
    assert.equal(result.reason, 'analysis_deadline');
  });

  it('checks protected-root preservation cadence even when root indexes avoid multiples of 64', () => {
    const snapshots = [node({ isCanvas: true, hasOwnText: false })];
    for (let index = 1; index <= 128; index += 1) {
      snapshots.push(node({
        parentIndex: 0,
        hasOwnText: false,
        style: index % 2 ? { backgroundImage: 'linear-gradient(red, blue)' } : {},
      }));
    }
    let calls = 0;
    const result = planEmailAppearance(snapshots, palette, {
      startedAt: 0,
      maxAnalysisMs: Infinity,
      clock: () => {
        calls += 1;
        return 0;
      },
    });
    assert.equal(result.status, 'ready');
    assert.equal(calls, 11);
  });

  it('falls back when the protected-root preservation pass reaches its deadline', () => {
    const snapshots = [node({ isCanvas: true, hasOwnText: false })];
    for (let index = 1; index <= 128; index += 1) {
      snapshots.push(node({
        parentIndex: 0,
        hasOwnText: false,
        style: index % 2 ? { backgroundImage: 'linear-gradient(red, blue)' } : {},
      }));
    }
    let calls = 0;
    const result = planEmailAppearance(snapshots, palette, {
      startedAt: 0,
      maxAnalysisMs: 1,
      clock: () => {
        calls += 1;
        return calls === 6 ? 2 : 0;
      },
    });
    assert.equal(result.reason, 'analysis_deadline');
  });

  it('returns computed_style_error for unexpected style reads', () => {
    const result = analyzeEmailAppearance(documentWith([domElement()], { throwStyle: true }), palette);
    assert.equal(result.reason, 'computed_style_error');
  });

  it('fails closed when sender important animation survives the renderer freeze layer', () => {
    const element = domElement();
    element.computed = {
      ...baseStyle,
      animationName: 'sender-paint-shift',
      animationDuration: '1s',
    };

    const result = analyzeEmailAppearance(documentWith([element]), palette);

    assert.equal(result.reason, 'dynamic_paint_unproven');
  });

  it('fails closed when a nonzero sender transition survives the renderer freeze layer', () => {
    const element = domElement();
    element.computed = {
      ...baseStyle,
      transitionProperty: 'color',
      transitionDuration: '250ms',
    };

    const result = analyzeEmailAppearance(documentWith([element]), palette);

    assert.equal(result.reason, 'dynamic_paint_unproven');
  });

  it('fails closed when a delayed zero-duration transition can change paint later', () => {
    const element = domElement();
    element.computed = {
      ...baseStyle,
      transitionProperty: 'color',
      transitionDuration: '0s',
      transitionDelay: '2s',
    };

    assert.equal(
      analyzeEmailAppearance(documentWith([element]), palette).reason,
      'dynamic_paint_unproven',
    );
  });

  it('accepts the computed transition default with no duration', () => {
    assert.equal(analyzeEmailAppearance(documentWith([domElement()]), palette).status, 'ready');
  });

  it('bounds attacker-sized computed motion lists before splitting them', () => {
    const element = domElement();
    element.computed = { ...baseStyle, animationName: `${'none,'.repeat(500_000)}none` };
    const startedAt = performance.now();

    const result = analyzeEmailAppearance(documentWith([element]), palette, {
      maxComputedValueChars: 4096,
    });

    assert.equal(result.reason, 'dynamic_paint_unproven');
    assert.ok(performance.now() - startedAt < 100);
  });

  it('treats attacker-sized own text as present without trimming it', () => {
    const element = domElement();
    element.computed = { ...baseStyle, webkitTextFillColor: 'rgb(255, 0, 0)' };
    const doc = documentWith([element]);
    element.childNodes = [{ nodeType: 3, textContent: ' '.repeat(500_000) }];

    const result = analyzeEmailAppearance(doc, palette, {
      maxComputedValueChars: 4096,
    });

    assert.equal(result.reason, 'text_fill_unproven');
  });

  it('repairs the inherited color of an empty custom-string list marker', () => {
    const element = domElement();
    element.computed = {
      ...baseStyle,
      color: 'rgb(0, 0, 0)',
      display: 'inline list-item',
      listStyleType: '"Generated label"',
      listStyleImage: 'none',
    };

    const result = analyzeEmailAppearance(documentWith([element]), palette);

    assert.equal(result.status, 'ready');
    assert.ok(mutationFor(result, element, 'color'));
  });

  it('fails closed for an empty list marker backed by an image', () => {
    const element = domElement();
    element.computed = {
      ...baseStyle,
      display: 'list-item',
      listStyleType: 'none',
      listStyleImage: 'url("data:image/svg+xml,marker")',
    };

    const result = analyzeEmailAppearance(documentWith([element]), palette);

    assert.equal(result.reason, 'generated_content_unproven');
  });

  for (const conditionText of [
    '(min-height: 600px)',
    '(max-width: 600px)',
    '(orientation: landscape)',
    '(max-aspect-ratio: 4 / 3)',
    '(400px < height)',
    '(400px < width)',
  ]) {
    it(`fails closed for sender media that can change after reveal: ${conditionText}`, () => {
      const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
        styleSheets: [{ cssRules: [{ conditionText, media: {}, cssRules: [] }] }],
      });

      assert.equal(result.reason, 'geometry_condition_unproven');
    });
  }

  it('fails closed for viewport media on a scoped div root too', () => {
    const element = domElement();
    documentWith([element]);
    const result = analyzeEmailAppearance(element, palette, {
      styleSheets: [{ cssRules: [{
        conditionText: '(600px >= width)', media: {}, cssRules: [],
      }] }],
    });

    assert.equal(result.reason, 'geometry_condition_unproven');
  });

  for (const conditionText of [
    '(device-width: 600px)',
    '(device-aspect-ratio: 4 / 3)',
    '(prefers-reduced-motion: reduce)',
    '(resolution: 2dppx)',
    '(pointer: coarse)',
  ]) {
    it(`fails closed for nonconstant sender media feature: ${conditionText}`, () => {
      const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
        styleSheets: [{ cssRules: [{ conditionText, media: {}, cssRules: [] }] }],
      });

      assert.equal(result.reason, 'geometry_condition_unproven');
    });
  }

  for (const conditionText of [
    '(min-width: 0px)',
    '(max-width: -1px)',
  ]) {
    it(`accepts an exact adapter media sentinel: ${conditionText}`, () => {
      const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
        styleSheets: [{ cssRules: [{ conditionText, media: {}, cssRules: [] }] }],
      });

      assert.equal(result.status, 'ready');
    });
  }

  for (const conditionText of ['all', 'screen and (min-width:0px)', 'not (max-width:-1px)']) {
    it(`rejects non-adapter media syntax: ${conditionText}`, () => {
      const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
        styleSheets: [{ cssRules: [{ conditionText, media: {}, cssRules: [] }] }],
      });

      assert.equal(result.reason, 'geometry_condition_unproven');
    });
  }

  for (const conditionText of ['(20rem < block-size)', '(1500px < width)', 'scroll-state(stuck: top)']) {
    it(`fails closed for sender container condition on a document root: ${conditionText}`, () => {
    class CSSContainerRule {
      constructor() {
        this.conditionText = conditionText;
        this.cssRules = [];
      }
    }
    const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
      styleSheets: [{ cssRules: [new CSSContainerRule()] }],
    });

    assert.equal(result.reason, 'geometry_condition_unproven');
    });
  }

  it('falls back when an active sender pseudo-element generates visible text', () => {
    const element = domElement();
    element.matches = selector => selector === '.probe';
    const doc = documentWith([element]);
    doc.defaultView.getComputedStyle = (_element, pseudo) => (
      pseudo === '::before' ? { content: '"Generated label"' } : baseStyle
    );
    const styleSheets = [{ cssRules: [{ selectorText: '.probe::before' }] }];

    const result = analyzeEmailAppearance(doc, palette, { styleSheets });

    assert.deepEqual(
      { status: result.status, reason: result.reason },
      { status: 'fallback', reason: 'generated_content_unproven' },
    );
  });

  it('fails closed when an initially-empty generated pseudo can animate paint or content later', () => {
    const element = domElement();
    element.matches = selector => selector === '.probe';
    const doc = documentWith([element]);
    doc.defaultView.getComputedStyle = (_element, pseudo) => (
      pseudo === '::before'
        ? { ...baseStyle, content: '""', animationName: 'late-content' }
        : baseStyle
    );

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{ selectorText: '.probe::before' }] }],
    });

    assert.equal(result.reason, 'dynamic_paint_unproven');
  });

  for (const selector of [
    '#interactive:hover',
    '#interactive:focus-visible',
    '.parent:has(.child:focus)',
    'a:visited',
    'a:link',
    '#interactive:\\68 over',
  ]) {
    it(`fails closed for sender interaction state selector ${selector}`, () => {
      const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
        styleSheets: [{ cssRules: [{ selectorText: selector }] }],
      });

      assert.equal(result.reason, 'interaction_paint_unproven');
    });
  }

  it('does not mistake a pseudo-like attribute string for interaction state', () => {
    const element = domElement();
    element.matches = () => false;
    const result = analyzeEmailAppearance(documentWith([element]), palette, {
      styleSheets: [{ cssRules: [{ selectorText: '[data-label=":hover"]' }] }],
    });

    assert.equal(result.status, 'ready');
  });

  it('falls back for visible generated text from a bare pseudo selector', () => {
    const element = domElement();
    element.matches = selector => selector === '*';
    const doc = documentWith([element]);
    doc.defaultView.getComputedStyle = (_element, pseudo) => (
      pseudo === '::after' ? { content: '"Global generated label"' } : baseStyle
    );

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{ selectorText: '::after' }] }],
    });

    assert.equal(result.reason, 'generated_content_unproven');
  });

  it('falls back for visible generated text from a legacy single-colon pseudo selector', () => {
    const element = domElement();
    element.matches = selector => selector === '.probe';
    const doc = documentWith([element]);
    doc.defaultView.getComputedStyle = (_element, pseudo) => (
      pseudo === '::before' ? { content: '"Legacy generated label"' } : baseStyle
    );

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{ selectorText: '.probe:before' }] }],
    });

    assert.equal(result.reason, 'generated_content_unproven');
  });

  it('does not fall back for empty or whitespace-only clearfix pseudo content', () => {
    const element = domElement();
    element.matches = selector => selector === '.probe';
    const doc = documentWith([element]);
    doc.defaultView.getComputedStyle = (_element, pseudo) => (
      pseudo === '::before' ? { content: '"   "' } : baseStyle
    );
    const styleSheets = [{ cssRules: [{ selectorText: '.probe::before' }] }];

    assert.equal(analyzeEmailAppearance(doc, palette, { styleSheets }).status, 'ready');
  });

  it('bounds attacker-sized computed pseudo content before trimming it', () => {
    const element = domElement();
    const doc = documentWith([element]);
    doc.querySelectorAll = () => [element];
    doc.defaultView.getComputedStyle = (_element, pseudo) => (
      pseudo === '::before' ? { ...baseStyle, content: `"${' '.repeat(500_000)}"` } : baseStyle
    );

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{ selectorText: '.probe::before' }] }],
      maxComputedValueChars: 4096,
    });

    assert.equal(result.reason, 'generated_content_unproven');
  });

  for (const [pseudo, selector] of [
    ['marker', '.probe::marker'],
    ['first-line', '.probe:first-line'],
    ['first-letter', '.probe:first-letter'],
  ]) {
    it(`falls back for a matching sender ${pseudo} text pseudo`, () => {
      const element = domElement();
      element.matches = candidate => candidate === '.probe';

      const result = analyzeEmailAppearance(documentWith([element]), palette, {
        styleSheets: [{ cssRules: [{ selectorText: selector }] }],
      });

      assert.equal(result.reason, 'generated_content_unproven');
    });
  }

  it('does not fall back for a nonmatching sender text pseudo selector', () => {
    const element = domElement();
    element.matches = () => false;

    const result = analyzeEmailAppearance(documentWith([element]), palette, {
      styleSheets: [{ cssRules: [{ selectorText: '.missing::marker' }] }],
    });

    assert.equal(result.status, 'ready');
  });

  it('does not fall back for a text pseudo inside an inactive rewritten color-scheme sentinel', () => {
    const element = domElement();
    element.matches = selector => selector === '.probe';
    const doc = documentWith([element]);
    doc.defaultView.matchMedia = () => ({ matches: false });

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{
        conditionText: '(max-width: -1px)',
        media: {},
        cssRules: [{ selectorText: '.probe::marker' }],
      }] }],
    });

    assert.equal(result.status, 'ready');
  });

  it('fails closed at the sender rule prepass bound', () => {
    const styleSheets = [{ cssRules: [
      { selectorText: '.one::before' },
      { selectorText: '.two::after' },
    ] }];

    const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
      styleSheets, maxStyleRules: 1,
    });

    assert.equal(result.reason, 'pseudo_rule_limit');
  });

  it('fails closed on sender cascade work before reading computed styles', () => {
    const elements = Array.from({ length: 501 }, () => domElement());
    const result = analyzeEmailAppearance(documentWith(elements, { throwStyle: true }), palette, {
      styleSheets: [{ cssRules: Array.from({ length: 500 }, (_, index) => (
        { selectorText: `.rule-${index}` }
      )) }],
      maxAnalysisMs: Infinity,
    });

    assert.equal(result.reason, 'style_complexity_limit');
  });

  it('accepts sender cascade work exactly at the fixed bound', () => {
    const result = analyzeEmailAppearance(documentWith(
      Array.from({ length: 500 }, () => domElement()),
    ), palette, {
      styleSheets: [{ cssRules: Array.from({ length: 500 }, (_, index) => (
        { selectorText: `.rule-${index}` }
      )) }],
      maxAnalysisMs: Infinity,
    });

    assert.equal(result.status, 'ready');
  });

  it('bounds authored inline and rule declaration text before computed styles', () => {
    const element = domElement();
    const oversized = 'x'.repeat(65537);
    element.getAttribute = name => (name === 'style' ? oversized : null);
    const inline = analyzeEmailAppearance(documentWith([element], { throwStyle: true }), palette);
    element.getAttribute = () => null;
    const declaration = analyzeEmailAppearance(documentWith([element], { throwStyle: true }), palette, {
      styleSheets: [{ cssRules: [{ selectorText: '.x', style: { cssText: oversized } }] }],
    });

    assert.equal(inline.reason, 'style_complexity_limit');
    assert.equal(declaration.reason, 'style_complexity_limit');
  });

  it('samples the analysis deadline while scanning authored inline styles', () => {
    let reads = 0;
    const elements = Array.from({ length: 65 }, () => {
      const element = domElement();
      element.getAttribute = () => { reads += 1; return null; };
      return element;
    });

    const result = analyzeEmailAppearance(documentWith(elements), palette, {
      clock: () => (reads ? Infinity : 0),
      deadline: 1,
    });

    assert.equal(result.reason, 'analysis_deadline');
    assert.ok(reads <= 64);
  });

  it('bounds every captured computed property value', () => {
    const element = domElement();
    element.computed = { ...baseStyle, backgroundImage: 'x'.repeat(4097) };

    const result = analyzeEmailAppearance(documentWith([element]), palette);

    assert.equal(result.reason, 'style_complexity_limit');
  });

  it('fails closed at the combined pseudo-selector character bound', () => {
    const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
      styleSheets: [{ cssRules: [{ selectorText: '.probe::before' }] }],
      maxPseudoSelectorChars: 3,
    });

    assert.equal(result.reason, 'pseudo_selector_limit');
  });

  it('bounds every selector before dynamic-state scanning, even without a tracked pseudo', () => {
    const selectorText = `.probe${'.descendant'.repeat(500_000)}`;
    const startedAt = performance.now();
    const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
      styleSheets: [{ cssRules: [{ selectorText }] }],
    });

    assert.equal(result.reason, 'pseudo_selector_limit');
    assert.ok(performance.now() - startedAt < 100);
  });

  it('aggregates condition and cssText inputs under the CSSOM text budget', () => {
    const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
      maxPseudoSelectorChars: 12,
      styleSheets: [{ cssRules: [{
        constructor: null,
        conditionText: 'all and all', media: {}, cssRules: [], cssText: '@media all{}',
      }] }],
    });

    assert.equal(result.reason, 'pseudo_selector_limit');
  });

  it('queries each tracked pseudo selector at most once', () => {
    let queries = 0;
    const element = domElement();
    const doc = documentWith([element], {
      querySelectorAll() { queries += 1; return []; },
    });

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{ selectorText: '.missing::before' }] }],
    });

    assert.equal(result.status, 'ready');
    assert.equal(queries, 1);
  });

  it('fails closed before matching relational pseudo selectors', () => {
    let queries = 0;
    const doc = documentWith([domElement()], {
      querySelectorAll() { queries += 1; return []; },
    });

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{ selectorText: String.raw`.probe:h\61s(*)::before` }] }],
    });

    assert.equal(result.reason, 'style_complexity_limit');
    assert.equal(queries, 0);
  });

  it('fails closed before matching escaped functional structural pseudos', () => {
    let queries = 0;
    const doc = documentWith([domElement()], {
      querySelectorAll() { queries += 1; return []; },
    });

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{ selectorText: String.raw`:n\74h-child(2n)::before` }] }],
    });

    assert.equal(result.reason, 'style_complexity_limit');
    assert.equal(queries, 0);
  });

  it('fails closed before matching a six-digit escaped costly pseudo', () => {
    let queries = 0;
    const doc = documentWith([domElement()], {
      querySelectorAll() { queries += 1; return []; },
    });

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{ selectorText: String.raw`.probe:h\000061s(*)::before` }] }],
    });

    assert.equal(result.reason, 'style_complexity_limit');
    assert.equal(queries, 0);
  });

  it('fails closed before matching costly pseudos hidden by line continuations', () => {
    for (const newline of ['\n', '\r\n', '\r', '\f']) {
      let queries = 0;
      const doc = documentWith([domElement()], {
        querySelectorAll() { queries += 1; return []; },
      });
      const result = analyzeEmailAppearance(doc, palette, {
        styleSheets: [{ cssRules: [{ selectorText: `.probe:h\\${newline}as(*)::before` }] }],
      });
      assert.equal(result.reason, 'style_complexity_limit');
      assert.equal(queries, 0);
    }
  });

  it('fails closed before submitting an oversized combined pseudo query', () => {
    let queries = 0;
    const doc = documentWith([domElement()], {
      querySelectorAll() { queries += 1; return []; },
    });

    const result = analyzeEmailAppearance(doc, palette, {
      styleSheets: [{ cssRules: [{ selectorText: `${'.'.padEnd(258, 'x')}::before` }] }],
    });

    assert.equal(result.reason, 'pseudo_selector_limit');
    assert.equal(queries, 0);
  });

  it('applies the combined selector bound to text pseudos', () => {
    const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
      styleSheets: [{ cssRules: [{ selectorText: '.probe::marker' }] }],
      maxPseudoSelectorChars: 3,
    });

    assert.equal(result.reason, 'pseudo_selector_limit');
  });

  it('fails closed when sender rules are unreadable', () => {
    const unreadable = {};
    Object.defineProperty(unreadable, 'cssRules', {
      get() { throw new Error('blocked rules'); },
    });

    const result = analyzeEmailAppearance(documentWith([domElement()]), palette, {
      styleSheets: [unreadable],
    });

    assert.equal(result.reason, 'pseudo_rule_unreadable');
  });

  it('fails closed when a sender pseudo selector cannot be matched', () => {
    const element = domElement();
    element.matches = () => { throw new Error('invalid selector'); };

    const result = analyzeEmailAppearance(documentWith([element]), palette, {
      styleSheets: [{ cssRules: [{ selectorText: ':is(.broken::before' }] }],
    });

    assert.equal(result.reason, 'pseudo_selector_unproven');
  });

  it('fails closed when a sender text pseudo selector cannot be matched', () => {
    const element = domElement();
    element.matches = () => { throw new Error('invalid selector'); };

    const result = analyzeEmailAppearance(documentWith([element]), palette, {
      styleSheets: [{ cssRules: [{ selectorText: ':is(.broken::first-line' }] }],
    });

    assert.equal(result.reason, 'pseudo_selector_unproven');
  });
});

describe('commitEmailAppearance', () => {
  it('returns a rollback handle that restores exact inline state after success', () => {
    const first = fakeElement();
    const second = fakeElement();
    first.style.setProperty('color', 'red', 'important');
    const result = { status: 'ready', mutations: [
      { element: first, property: 'color', value: 'black' },
      { element: second, property: 'background-color', value: 'blue' },
    ] };

    const rollback = commitEmailAppearance(result, { deadline: Infinity });
    rollback();

    assert.equal(first.style.getPropertyValue('color'), 'red');
    assert.equal(first.style.getPropertyPriority('color'), 'important');
    assert.equal(second.style.getPropertyValue('background-color'), '');
    assert.equal(second.style.getPropertyPriority('background-color'), '');
  });

  it('rolls prior values and priorities back in reverse order on deadline', () => {
    const first = fakeElement();
    const second = fakeElement();
    first.style.setProperty('color', 'red', 'important');
    second.style.setProperty('background-color', 'white', '');
    const result = { status: 'ready', mutations: [
      { element: first, property: 'color', value: 'black' },
      { element: second, property: 'background-color', value: 'blue' },
    ] };
    let now = 0;
    assert.throws(() => commitEmailAppearance(result, { deadline: 3, clock: () => ++now }), /email_reveal_deadline/);
    assert.equal(first.style.getPropertyValue('color'), 'red');
    assert.equal(first.style.getPropertyPriority('color'), 'important');
    assert.equal(second.style.getPropertyValue('background-color'), 'white');
    assert.equal(second.style.getPropertyPriority('background-color'), '');
  });

  it('rejects an exact deadline even when there are no mutations', () => {
    assert.throws(() => commitEmailAppearance(
      { status: 'ready', mutations: [] },
      { deadline: 100, clock: () => 100 },
    ), /email_reveal_deadline/);
  });

  it('rolls exact inline state back when setProperty throws', () => {
    const first = fakeElement();
    const second = fakeElement();
    first.style.setProperty('color', 'red', 'important');
    const original = second.style.setProperty;
    second.style.setProperty = () => { throw new Error('write failed'); };
    const result = { status: 'ready', mutations: [
      { element: first, property: 'color', value: 'black' },
      { element: second, property: 'color', value: 'blue' },
    ] };
    assert.throws(() => commitEmailAppearance(result, { deadline: Infinity }), /write failed/);
    assert.equal(first.style.getPropertyValue('color'), 'red');
    assert.equal(first.style.getPropertyPriority('color'), 'important');
    second.style.setProperty = original;
  });

  it('marks rollbackFailed only when restoring an earlier write fails', () => {
    const first = fakeElement();
    const second = fakeElement();
    const restore = first.style.setProperty;
    first.style.setProperty('color', 'red');
    let firstWrites = 0;
    first.style.setProperty = (...args) => {
      firstWrites += 1;
      if (firstWrites > 1) throw new Error('rollback failed');
      restore(...args);
    };
    second.style.setProperty = () => { throw new Error('write failed'); };
    const result = { status: 'ready', mutations: [
      { element: first, property: 'color', value: 'black' },
      { element: second, property: 'color', value: 'blue' },
    ] };
    assert.throws(() => commitEmailAppearance(result, { deadline: Infinity }), error => (
      error.rollbackFailed === true && error.rollbackCause.message === 'rollback failed'
    ));
  });
});
