import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyCustomCss, applyTheme } from '../../src/themes.js';
import { emailBodyAppearanceToggleLabel } from '../../src/utils/emailBodyAppearance.js';
import { applyEmailMediaMode } from '../../src/utils/emailMediaMode.js';
import {
  buildForwardBodyContent,
  buildReplyBodyContent,
  cacheCanonicalEmailBody,
  emailBodyTextForAi,
} from '../../src/utils/emailBodyContent.js';
import {
  applyEmailDivGeometry,
  applyEmailIframeGeometry,
  attachEmailBodyLinkHandler,
  createEmailScrollExpander,
  handleEmailBodyLinkClick,
} from '../../src/utils/emailRenderRuntime.js';
import { printEmailWindow, writeEmailPrintDocument } from '../../src/utils/emailPrintRuntime.js';
import {
  buildEmailFrameDocument,
  createEmailFrameSourceToken,
  emailFrameDocumentMatchesSource,
} from '../../src/utils/emailFrameDocument.js';
import { setEmailAppearanceTestControls, useEmailAppearance } from '../../src/hooks/useEmailAppearance.js';
import { prepareEmailHtml } from '../../src/utils/scopeEmailCss.js';
import {
  getEmailStyleSheets,
  injectEmailStyles,
  removeEmailStyles,
} from '../../src/utils/emailStyleRegistry.js';
import nativeDarkHtml from './fixtures/native-dark.html?raw';
import plainHtml from './fixtures/plain.html?raw';
import malformedHtml from './fixtures/malformed.html?raw';
import marketingTableHtml from './fixtures/marketing-table.html?raw';
import protectedImageHtml from './fixtures/protected-image.html?raw';
import quotedHtml from './fixtures/quoted.html?raw';
import transactionalHtml from './fixtures/transactional.html?raw';
import wideHtml from './fixtures/wide.html?raw';
import animatedStatusSvg from './assets/animated-status.svg?raw';

const FIXTURES = {
  malformed: malformedHtml,
  'marketing-table': marketingTableHtml,
  'native-dark': nativeDarkHtml,
  plain: plainHtml,
  'protected-image': protectedImageHtml,
  quoted: quotedHtml,
  transactional: transactionalHtml,
  wide: wideHtml,
};

const customCssCases = {
  valid: `:root {
    --bg-secondary:#101828; --bg-elevated:#1d2939;
    --text-primary:#f2f4f7; --text-secondary:#d0d5dd;
    --accent:#84adff; --border:#98a2b3;
  }`,
  invalid: ':root { --bg-secondary:not-a-color; --accent:var(--missing); }',
  broad: '* { color: #ff00ff !important; }',
};

const PROTECTED_CASES = new Set([
  'gradient', 'opacity', 'filter', 'backdrop', 'blend',
  'inset-shadow', 'logo-backing', 'qr', 'remote-placeholder',
]);

function scopedRoot(root) {
  return root.nodeType === 9 ? root.documentElement : root;
}

function styleFor(root, element) {
  const view = root.nodeType === 9 ? root.defaultView : root.ownerDocument.defaultView;
  return view.getComputedStyle(element);
}

function rgba(value) {
  const match = value.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return { r: 0, g: 0, b: 0, a: 0 };
  const [r, g, b, a = 1] = match[1].split(',').map(Number);
  return { r, g, b, a };
}

function composite(front, back) {
  const alpha = front.a + back.a * (1 - front.a);
  if (!alpha) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (front.r * front.a + back.r * back.a * (1 - front.a)) / alpha,
    g: (front.g * front.a + back.g * back.a * (1 - front.a)) / alpha,
    b: (front.b * front.a + back.b * back.a * (1 - front.a)) / alpha,
    a: alpha,
  };
}

function effectiveBackgroundColor(root, element) {
  let color = rgba(styleFor(root, element).backgroundColor);
  let parent = element.parentElement;
  while (color.a < 1 && parent) {
    color = composite(color, rgba(styleFor(root, parent).backgroundColor));
    parent = parent.parentElement;
  }
  if (color.a < 1) color = composite(color, { r: 255, g: 255, b: 255, a: 1 });
  return color;
}

function effectiveBackground(root, element) {
  const color = effectiveBackgroundColor(root, element);
  return `rgb(${[color.r, color.g, color.b].map(channel => Math.round(channel)).join(', ')})`;
}

function luminance(color) {
  const channel = value => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function renderedContrast(root, mutation) {
  if (mutation.kind !== 'repair'
    || (mutation.property !== 'color' && !mutation.property.startsWith('border-'))) return null;
  const style = styleFor(root, mutation.element);
  const background = effectiveBackgroundColor(root, mutation.element);
  const foreground = composite(rgba(style.getPropertyValue(mutation.property)), background);
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function protectedColorSnapshot(root) {
  const scope = scopedRoot(root);
  return Object.fromEntries([...PROTECTED_CASES].map(name => {
    const element = scope.querySelector(`[data-case="${name}"]`);
    if (!element) return [name, null];
    const style = styleFor(root, element);
    return [name, { color: style.color, background: effectiveBackground(root, element) }];
  }));
}

function mutationPropertyValue(root, mutation) {
  return styleFor(root, mutation.element).getPropertyValue(mutation.property);
}

function mutationEvidence(root, mutations = [], before = []) {
  const scope = scopedRoot(root);
  return mutations.map((mutation, index) => {
    const closest = mutation.element.closest?.('[data-case]');
    const protectedCase = closest && PROTECTED_CASES.has(closest.dataset.case)
      ? closest.dataset.case
      : null;
    return {
      kind: mutation.kind,
      property: mutation.property,
      plannedValue: mutation.value,
      beforeValue: before[index]?.value ?? null,
      afterValue: mutationPropertyValue(root, mutation),
      targetContrast: mutation.targetContrast,
      renderedContrast: renderedContrast(root, mutation),
      protectedCase,
      insideProtected: Boolean(protectedCase),
      atProtectedRoot: Boolean(protectedCase && mutation.element === closest),
      compositingBoundary: mutation.element.dataset?.case === 'protected-boundary',
      connected: scope.contains(mutation.element),
    };
  });
}

function nestedVerticalScrollCount(root) {
  const scope = root.nodeType === 9 ? root : root;
  const view = root.nodeType === 9 ? root.defaultView : root.ownerDocument.defaultView;
  return [...scope.querySelectorAll('*')].filter(element => {
    const overflowY = view.getComputedStyle(element).overflowY;
    return (overflowY === 'auto' || overflowY === 'scroll')
      && element.scrollHeight > element.clientHeight + 2;
  }).length;
}

function snapshot(root) {
  const view = root.ownerDocument?.defaultView || root.defaultView;
  const getStyle = element => view.getComputedStyle(element);
  return {
    cardBackground: getStyle(root.querySelector('.native-card')).backgroundColor,
    responsive: getStyle(root.querySelector('.responsive-flag')).color,
  };
}

function hasMalformedSelector(styleSheets) {
  for (let sheetIndex = 0; sheetIndex < styleSheets.length; sheetIndex += 1) {
    const sheet = styleSheets.item ? styleSheets.item(sheetIndex) : styleSheets[sheetIndex];
    for (let ruleIndex = 0; ruleIndex < sheet.cssRules.length; ruleIndex += 1) {
      const rule = sheet.cssRules.item ? sheet.cssRules.item(ruleIndex) : sheet.cssRules[ruleIndex];
      if (/\.bad|\.also/.test(rule.selectorText || '')) return true;
    }
  }
  return false;
}

function mediaConditions(styleSheets) {
  const conditions = [];
  const visit = rules => {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules.item ? rules.item(index) : rules[index];
      if (typeof rule.conditionText === 'string') conditions.push(rule.conditionText);
      if (rule.cssRules) visit(rule.cssRules);
    }
  };
  for (let index = 0; index < styleSheets.length; index += 1) {
    const sheet = styleSheets.item ? styleSheets.item(index) : styleSheets[index];
    visit(sheet.cssRules);
  }
  return conditions;
}

function containerRuleCount(styleSheets) {
  let count = 0;
  const visit = rules => {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules.item ? rules.item(index) : rules[index];
      if (rule?.constructor?.name === 'CSSContainerRule') count += 1;
      if (rule.cssRules) visit(rule.cssRules);
    }
  };
  for (let index = 0; index < styleSheets.length; index += 1) {
    const sheet = styleSheets.item ? styleSheets.item(index) : styleSheets[index];
    visit(sheet.cssRules);
  }
  return count;
}

function textContrast(root, mutations = []) {
  const scopedRoot = root.nodeType === 9 ? root.documentElement : root;
  return mutations
    .filter(mutation => mutation.kind === 'repair'
      && mutation.property === 'color'
      && scopedRoot.contains(mutation.element))
    .map(mutation => mutation.targetContrast);
}

function snapshotMutationState(analysis) {
  return (analysis?.mutations || []).map(({ element, property }) => ({
    element,
    property,
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  }));
}

function survivingMutations(entries = []) {
  return entries.filter(entry => (
    entry.element.style.getPropertyValue(entry.property) !== entry.value
    || entry.element.style.getPropertyPriority(entry.property) !== entry.priority
  )).length;
}

function senderStyleCount(styleSheets) {
  return styleSheets.filter(sheet => {
    const owner = sheet.ownerNode;
    return owner?.isConnected && !owner.hasAttribute?.('data-mailflow-email-base');
  }).length;
}

function forcedLightEvidence(root, styleSheets) {
  const documentRoot = root.nodeType === 9;
  const canvas = documentRoot ? root.body : root;
  const view = canvas.ownerDocument.defaultView;
  const style = view.getComputedStyle(canvas);
  return {
    baseRetained: styleSheets.some(sheet => (
      sheet.ownerNode?.isConnected
      && sheet.ownerNode.hasAttribute?.('data-mailflow-email-base')
    )),
      senderStyleCount: senderStyleCount(styleSheets),
      senderContainerRuleCount: containerRuleCount(styleSheets),
    canvasBackground: style.backgroundColor,
    canvasColor: style.color,
  };
}

function resultFor(root, media, includeSecondPass) {
  const result = {
    media,
    colors: snapshot(root),
    root: {
      attributes: {
        ogsc: root.hasAttribute('data-ogsc'),
        ogsb: root.hasAttribute('data-ogsb'),
      },
      colorScheme: root.style.getPropertyValue('color-scheme'),
    },
  };
  if (includeSecondPass) {
    const second = applyEmailMediaMode(includeSecondPass);
    result.secondPass = { ...second, cardBackground: snapshot(root).cardBackground };
  }
  return result;
}

function createOwner(base = false) {
  const owner = document.createElement('style');
  if (base) owner.dataset.mailflowEmailBase = '';
  document.head.appendChild(owner);
  return owner;
}

function mediaRule({ throws = false } = {}) {
  const media = {};
  Object.defineProperty(media, 'mediaText', {
    get: () => '(prefers-color-scheme: dark)',
    set: () => { if (throws) throw new Error('blocked'); },
  });
  return { conditionText: '(prefers-color-scheme: dark)', media };
}

function writableMediaRule() {
  let value = '(prefers-color-scheme: dark)';
  const media = {};
  Object.defineProperty(media, 'mediaText', {
    get: () => value,
    set: next => { value = next; },
  });
  return { conditionText: '(prefers-color-scheme: dark)', media };
}

function installFailureHooks() {
  window.mailflowFixtureMediaFailure = () => {
    const sender = createOwner();
    const base = createOwner(true);
    const sheet = { ownerNode: sender, cssRules: [mediaRule({ throws: true })] };
    const automatic = applyEmailMediaMode({ root: document, styleSheets: [sheet, { ownerNode: base, cssRules: [] }], scheme: 'dark' });
    const original = applyEmailMediaMode({ root: document, styleSheets: [sheet, { ownerNode: base, cssRules: [] }], scheme: 'light', failClosed: true });
    const result = { automatic, original, baseRetained: base.isConnected };
    base.remove();
    return result;
  };

  window.mailflowFixturePartialMediaFailure = () => {
    const first = createOwner();
    const second = createOwner();
    const firstRule = writableMediaRule();
    const secondRule = mediaRule({ throws: true });
    const sheets = [
      { ownerNode: first, cssRules: [firstRule] },
      { ownerNode: second, cssRules: [secondRule] },
    ];
    const automatic = applyEmailMediaMode({ root: document, styleSheets: sheets, scheme: 'dark' });
    const fallback = applyEmailMediaMode({
      root: document, styleSheets: sheets, scheme: 'light', failClosed: true,
    });
    const result = {
      automatic,
      fallback,
      firstMediaText: firstRule.media.mediaText,
      secondRemoved: !second.isConnected,
    };
    first.remove();
    return result;
  };

  window.mailflowFixtureMediaBudgetFailure = () => {
    const first = createOwner();
    const second = createOwner();
    const base = createOwner(true);
    const rules = Array.from({ length: 5001 }, () => ({}));
    const sheets = [
      { ownerNode: first, cssRules: rules },
      { ownerNode: second, cssRules: [] },
      { ownerNode: base, cssRules: [] },
    ];
    const automatic = applyEmailMediaMode({ root: document, styleSheets: sheets, scheme: 'dark' });
    const original = applyEmailMediaMode({ root: document, styleSheets: sheets, scheme: 'light', failClosed: true });
    const result = {
      automatic,
      original,
      senderRetained: first.isConnected || second.isConnected,
      baseRetained: base.isConnected,
    };
    base.remove();
    return result;
  };

  window.mailflowFixtureMediaDeadlineFailure = () => {
    const first = createOwner();
    const second = createOwner();
    const base = createOwner(true);
    const sheets = [
      { ownerNode: first, cssRules: Array.from({ length: 64 }, () => ({})) },
      { ownerNode: second, cssRules: [] },
      { ownerNode: base, cssRules: [] },
    ];
    const options = { root: document, styleSheets: sheets, scheme: 'dark', deadline: 0, clock: () => 0 };
    const automatic = applyEmailMediaMode(options);
    const original = applyEmailMediaMode({ ...options, scheme: 'light', failClosed: true });
    const result = {
      automatic,
      original,
      senderRetained: first.isConnected || second.isConnected,
      baseRetained: base.isConnected,
    };
    base.remove();
    return result;
  };
}

function deadlineCommitClock() {
  let calls = 0;
  return () => (calls++ < 2 ? -Infinity : Infinity);
}

function blockOnce(boundary) {
  let blocked = false;
  return async (name, context) => {
    if (blocked || name !== boundary) return;
    blocked = true;
    window.mailflowFixtureBlocked = { boundary: name, generation: context.generation };
    await new Promise(resolve => {
      window.mailflowFixtureRelease = resolve;
    });
  };
}

function controlsFor(scenario, boundary) {
  if (scenario === 'analysis-style-complexity') {
    return { analysisOptions: { maxComputedValueChars: 8 } };
  }
  if (new Set([
    'complex-pseudo-selector', 'complex-structural-selector',
    'style-resolution-complexity', 'authored-style-complexity',
  ]).has(scenario)) {
    return { analysisOptions: { maxNodes: 6000 } };
  }
  if (scenario === 'nodes-5001' || scenario === 'paint-before-geometry') {
    return {
      clock: () => 0,
      analysisClock: () => 0,
      revealTimeoutMs: 5000,
      analysisOptions: { maxNodes: 5000 },
    };
  }
  if (scenario === 'mutations-10001') {
    return {
      clock: () => 0,
      analysisClock: () => 0,
      revealTimeoutMs: 5000,
      analysisOptions: { maxNodes: 5000, maxMutations: 10000, maxAnalysisMs: Infinity },
    };
  }
  if (scenario === 'elapsed-40') {
    return {
      clock: () => 0,
      analysisClock: (() => { let tick = 0; return () => (tick += 41); })(),
      revealTimeoutMs: 5000,
      analysisOptions: { maxAnalysisMs: 40 },
    };
  }
  if (scenario === 'remaining-analysis-budget') {
    let analysisCalls = 0;
    return {
      clock: () => 0,
      analysisClock: () => (analysisCalls++ === 0 ? 90 : 101),
      revealTimeoutMs: 5000,
      analysisOptions: { maxAnalysisMs: 40 },
    };
  }
  if (scenario === 'computed-style-throw') {
    return {
      clock: () => 0,
      analysisClock: () => 0,
      revealTimeoutMs: 5000,
      checkpoint: async (name, { root }) => {
        if (name !== 'before_analyze') return;
        const view = root.nodeType === 9 ? root.defaultView : root.ownerDocument.defaultView;
        const original = view.getComputedStyle;
        view.getComputedStyle = (...args) => {
          view.getComputedStyle = original;
          throw new Error(`injected computed style failure for ${args[0]?.tagName || 'node'}`);
        };
      },
    };
  }
  if (scenario === 'commit-throw' || scenario === 'rollback-failure') {
    return {
      clock: () => 0,
      analysisClock: () => 0,
      revealTimeoutMs: 5000,
      commitClock: deadlineCommitClock(),
      checkpoint: async (name, { analysis }) => {
        if (name !== 'before_commit') return;
        const entries = snapshotMutationState(analysis);
        window.mailflowFixtureCommitBaseline = entries;
        if (scenario !== 'rollback-failure') return;
        const target = entries.find(entry => !entry.value);
        if (!target) throw new Error('rollback fixture has no empty inline property');
        const style = target.element.style;
        const original = style.removeProperty.bind(style);
        Object.defineProperty(style, 'removeProperty', {
          configurable: true,
          value(property) {
            if (property === target.property) throw new Error('injected rollback failure');
            return original(property);
          },
        });
      },
    };
  }
  if (scenario === 'deadline-exact') {
    let now = 0;
    return {
      clock: () => now,
      analysisClock: () => 0,
      commitClock: () => 0,
      revealTimeoutMs: 5000,
      checkpoint: async name => {
        if (name === 'before_commit') now = 100;
      },
    };
  }
  if (scenario === 'deadline-zero-mutation') {
    let now = 0;
    return {
      clock: () => now,
      analysisClock: () => 0,
      commitClock: () => { now = 101; return 0; },
      revealTimeoutMs: 5000,
      checkpoint: async (name, { analysis }) => {
        if (name === 'before_commit') analysis.mutations.length = 0;
      },
    };
  }
  if (scenario === 'deadline-post-commit') {
    let now = 0;
    return {
      clock: () => now,
      analysisClock: () => 0,
      commitClock: () => { now = 101; return 0; },
      revealTimeoutMs: 5000,
    };
  }
  if (scenario === 'reveal-100ms') {
    return {
      checkpoint: blockOnce('before_engine'),
      onRevealScheduled: delay => { window.mailflowFixtureRevealDelayMs = delay; },
    };
  }
  if (scenario === 'reveal-early-timer') {
    return {
      checkpoint: blockOnce('before_engine'),
      clock: () => 0,
      analysisClock: () => 0,
      commitClock: () => 0,
      revealTimeoutMs: 0,
    };
  }
  if (scenario === 'deadline-stale') return { checkpoint: blockOnce('before_engine') };
  if (scenario === 'delayed-reveal') {
    return {
      checkpoint: async name => {
        if (name === 'before_engine') await new Promise(resolve => setTimeout(resolve, 150));
      },
    };
  }
  if (scenario === 'functional-delay') {
    return {
      checkpoint: async name => {
        if (name === 'before_engine') await new Promise(resolve => setTimeout(resolve, 150));
      },
    };
  }
  if (scenario === 'race') {
    return {
      checkpoint: blockOnce(boundary),
      clock: () => 0,
      analysisClock: () => 0,
      commitClock: () => 0,
      revealTimeoutMs: 5000,
    };
  }
  return null;
}

function acceptanceControlsFor(scenario, boundary) {
  const scenarioControls = controlsFor(scenario, boundary) || {};
  const scenarioCheckpoint = scenarioControls.checkpoint;
  const usesRealDeadline = new Set([
    'reveal-100ms', 'deadline-stale', 'delayed-reveal',
  ]).has(scenario);
  return {
    ...(!usesRealDeadline ? {
      clock: () => 0,
      analysisClock: () => 0,
      commitClock: () => 0,
      revealTimeoutMs: 5000,
    } : {}),
    ...scenarioControls,
    async checkpoint(name, context) {
      if (name === 'before_analyze') {
        window.mailflowFixtureDraftEvidence = {
          paletteFingerprint: context.palette.fingerprint,
          protectedColors: protectedColorSnapshot(context.root),
        };
      } else if (name === 'before_commit') {
        window.mailflowFixtureDraftEvidence ||= {};
        window.mailflowFixtureDraftEvidence.mutationBefore = context.analysis.mutations
          .map(mutation => ({ value: mutationPropertyValue(context.root, mutation) }));
      }
      if (scenarioCheckpoint) await scenarioCheckpoint(name, context);
    },
  };
}

function htmlForScenario(scenario) {
  if (scenario === 'dom-parsed-no-load') {
    return '<style>.dom-ready-copy{width:2000px;color:#111;background:#fff}</style><p class="dom-ready-copy">DOM parsed</p><img src="/e2e/email-appearance/never-resolves.png" alt="">';
  }
  if (scenario === 'analysis-style-complexity') {
    return '<style>.analysis-complexity{color:#111;background:#fff}</style><p class="analysis-complexity">body</p>';
  }
  if (scenario === 'complexity-baseline-persistent') {
    return '<style>.copy::before{content:"x"}</style><p class="copy">body</p>';
  }
  if (scenario === 'nodes-5001') return `<main>${'<span>node</span>'.repeat(5001)}</main>`;
  if (scenario === 'safe-preflight-style') return '<style>.safe-copy{color:#111}</style><p class="safe-copy" style="background:#fff">body</p>';
  if (scenario === 'paint-before-geometry') return `<main>${'<span>node</span>'.repeat(20_000)}</main>`;
  if (scenario === 'complex-pseudo-selector') {
    return '<style>.probe:has(*)::before{content:""}</style><main class="probe"><span>node</span></main>';
  }
  if (scenario === 'complex-structural-selector') {
    return '<style>.probe:nth-child(2n)::before{content:""}</style><main><span class="probe">node</span></main>';
  }
  if (scenario === 'escaped-continuation-selector') {
    return `<style>.probe:h\\\nas(*){color:red}</style><p class="probe">body</p>`;
  }
  if (scenario === 'variable-amplification') {
    return '<style>:root{--seed:red;--branch:[var(--seed)var(--seed)]}.copy{grid-template-columns:var(--branch)}</style><p class="copy">body</p>';
  }
  if (scenario === 'escaped-variable-delimiter') {
    return String.raw`<style>:root{--seed:red\3b var(--branch)var(--branch);--branch:red}.copy{color:var(--seed)}</style><p class="copy">body</p>`;
  }
  if (scenario === 'attribute-expansion') {
    return `<style>.copy{content:attr(data-copy)}</style><p class="copy" data-copy="${'x'.repeat(70_000)}">body</p>`;
  }
  if (scenario === 'long-selector') {
    return `<style>.${'a'.repeat(2000)}{color:red}</style><p>body</p>`;
  }
  if (scenario === 'nesting-depth') {
    return `<style>${'.x{'.repeat(9)}color:red;${'}'.repeat(9)}</style><p class="x">body</p>`;
  }
  if (scenario === 'tracked-pseudo') {
    return '<style>.copy::before{content:"x"}</style><p class="copy">body</p>';
  }
  if (scenario === 'recovery-style-text') {
    return '<p data-hostile-inline style="color:var(--unknown)">My style="bold" today</p>';
  }
  if (scenario === 'style-resolution-complexity') {
    const rules = '.x{color:black}'.repeat(5001);
    return `<style>${rules}</style><main>${'<span class="x">node</span>'.repeat(64)}</main>`;
  }
  if (scenario === 'authored-style-complexity') {
    return `<main><span data-hostile-inline style="background-image:url(data:image/svg+xml,${'a'.repeat(2_000_000)})">node</span></main>`;
  }
  if (scenario === 'mutations-10001') {
    const node = '<span style="display:block;background:#fff;color:#1a1a2e;border:1px solid #ddd">node</span>';
    return `<main>${node.repeat(2501)}</main>`;
  }
  if (scenario === 'script-probe') {
    return `${plainHtml}<script>parent.mailflowFixtureProbeExecuted = true<\/script>`;
  }
  if (scenario === 'animated-image') {
    return `<style>
      @keyframes sender-color-pulse { from { color:#111; } to { color:#777; } }
      [data-case="animated-text"] { animation:sender-color-pulse 10s infinite;transition:color 10s; }
    </style>
    <p data-case="animated-text">Stable animated color text</p>
    <img data-case="animated-image" src="./assets/animated-status.svg" alt="Generic animated image asset">`;
  }
  if (scenario === 'remote-image-stability') {
    return '<p>Stable body</p><img id="tracking-probe" src="/e2e/email-appearance/tracking-probe.svg" alt="Tracking probe">';
  }
  if (scenario === 'responsive-color-scheme') {
    return `<style>
      .responsive-flag { color:rgb(1, 2, 3); }
      @media (max-width: 500px) and (prefers-color-scheme: dark) {
        .responsive-flag { color:rgb(7, 8, 9); }
      }
    </style><p class="responsive-flag">Responsive sender rule</p>`;
  }
  if (scenario === 'inset-shadow') {
    return '<div data-case="inset-shadow" style="background:#fff;color:#111;box-shadow:inset 0 0 0 9999px #fff">Inset-shadow text</div>';
  }
  if (scenario === 'important-paint-animation') {
    return `<style>
      @keyframes sender-paint-shift { from { color:#0055aa; } to { color:#111111; } }
      #mailflow-motion-owner #important-paint-animation {
        color:#0055aa;background:#ffffff;
        animation:sender-paint-shift 500ms linear 100ms forwards !important;
      }
    </style>
    <div id="mailflow-motion-owner"><p id="important-paint-animation">Delayed paint</p></div>`;
  }
  if (scenario === 'custom-list-marker') {
    return `<style>.marker-item{display:list-item;list-style-type:"Generated label";color:#000;background:#fff}</style>
      <div class="marker-item"></div>`;
  }
  if (scenario === 'image-list-marker') {
    return `<style>.marker-item{display:list-item;list-style-type:none;list-style-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='black'/%3E%3C/svg%3E");color:#000;background:#fff}</style>
      <div class="marker-item"></div>`;
  }
  if (scenario === 'important-interaction-paint') {
    return `<style>
      #mailflow-interaction-owner #interactive-paint { color:#0055aa;background:#ffffff; }
      #mailflow-interaction-owner #interactive-paint:hover,
      #mailflow-interaction-owner #interactive-paint:focus { color:#111111 !important; }
    </style>
    <div id="mailflow-interaction-owner"><a id="interactive-paint" href="https://example.invalid/">Interactive paint</a></div>`;
  }
  if (scenario === 'important-pseudo-animation') {
    return `<style>
      @keyframes late-generated-content {
        from { content:"";color:#0055aa; }
        to { content:"Late";color:#111111; }
      }
      #mailflow-pseudo-owner #late-pseudo::before {
        content:"";background:#ffffff;
        animation:late-generated-content 500ms linear 100ms forwards !important;
      }
    </style>
    <div id="mailflow-pseudo-owner"><p id="late-pseudo">Stable body</p></div>`;
  }
  if (scenario === 'post-geometry-height-media') {
    return `<style>
      .geometry-paint { color:#0055aa;background:#ffffff; }
      @media (min-height:600px) { .geometry-paint { color:#111111; } }
    </style>
    <p class="geometry-paint">Height-dependent paint</p><div style="height:650px">Spacer</div>`;
  }
  if (scenario === 'post-terminal-width-media') {
    return `<style>
      .resize-paint { color:#0055aa;background:#ffffff; }
      @media (max-width:600px) { .resize-paint { color:#111111 !important; } }
    </style><p class="resize-paint">Viewport-dependent paint</p>`;
  }
  if (scenario === 'color-scheme-only-media') {
    return `<style>
      .native-card { color:#111111;background:#ffffff; }
      @media (prefers-color-scheme:dark) {
        .native-card { color:#f4f7fb;background:#121826; }
      }
    </style><main class="native-card"><p class="copy">Color-scheme paint</p><p class="responsive-flag">Static media sentinel</p></main>`;
  }
  if (scenario === 'post-geometry-container') {
    return `<style>
      .geometry-container { container-type:size; height:650px; }
      .container-paint { color:#0055aa;background:#ffffff; }
      @container (min-block-size:600px) { .container-paint { color:#111111; } }
    </style>
    <div class="geometry-container"><p class="container-paint">Container-dependent paint</p></div>`;
  }
  if (scenario === 'post-geometry-container-inline') {
    return `<style>
      .geometry-container { container-type:inline-size; width:2000px; }
      .container-paint { color:#0055aa;background:#ffffff; }
      @container (1500px < width) { .container-paint { color:#111111; } }
    </style>
    <div class="geometry-container"><p class="container-paint">Inline-size-dependent paint</p></div>`;
  }
  if (scenario === 'generated-double') {
    return '<style>.generated::before{content:"Generated label";color:#777}</style><p class="generated">Body</p>';
  }
  if (scenario === 'generated-legacy') {
    return '<style>.generated:after{content:"Legacy label";color:#777}</style><p class="generated">Body</p>';
  }
  if (scenario === 'generated-media') {
    return '<style>@media(prefers-color-scheme:dark){.generated::before{content:"Dark label";color:#777}}</style><p class="generated">Body</p>';
  }
  if (scenario === 'generated-empty') {
    return '<style>.clearfix::before{content:"";display:table}.clearfix:after{content:"   ";display:table}</style><p class="clearfix">Body</p>';
  }
  if (scenario === 'pseudo-marker') {
    return '<style>.marker::marker{content:"Marker";color:#000}</style><ul><li class="marker">Marker body</li></ul>';
  }
  if (scenario === 'pseudo-first-line') {
    return '<style>.line:first-line{color:#000}</style><p class="line">First line body</p>';
  }
  if (scenario === 'pseudo-first-letter') {
    return '<style>.letter:first-letter{color:#000}</style><p class="letter">Letter body</p>';
  }
  if (scenario === 'pseudo-inactive-nonmatching') {
    return '<style>@media(prefers-color-scheme:light){.marker::marker{content:"Inactive";color:#000}}.missing::first-line{color:#000}</style><ul><li class="marker">Safe body</li></ul>';
  }
  if (scenario === 'divergent-text-fill') {
    return '<style>.fill{color:#111;-webkit-text-fill-color:#000;background:#fff}</style><p class="fill">Painted text fill</p>';
  }
  if (scenario === 'equal-text-fill') {
    return '<style>.fill{color:#000;-webkit-text-fill-color:#000;background:#fff}</style><p class="fill">Paired text fill</p>';
  }
  if (scenario === 'scoped-global-at-rule') {
    return '<style>@media(prefers-color-scheme:dark){@property --mailflow-global-probe{syntax:"<color>";inherits:true;initial-value:rgb(255, 0, 0)}}.local{color:blue}</style><p class="local">Body</p>';
  }
  return null;
}

function poisonBaseline(root) {
  const scopedRoot = root.nodeType === 9 ? root.documentElement : root;
  const original = scopedRoot.style.setProperty.bind(scopedRoot.style);
  Object.defineProperty(scopedRoot.style, 'setProperty', {
    configurable: true,
    value(property, ...rest) {
      if (property === 'color-scheme') throw new Error('injected baseline failure');
      return original(property, ...rest);
    },
  });
}

function Harness() {
  const params = new URLSearchParams(location.search);
  const renderer = params.get('renderer') || 'iframe';
  const fixture = params.get('fixture') || 'plain';
  const theme = params.get('theme') || 'dark';
  const mode = params.get('mode') || 'auto';
  const scenario = params.get('scenario');
  const initialHtml = htmlForScenario(scenario) || FIXTURES[fixture] || plainHtml;
  const [html, setHtml] = useState(initialHtml);
  const [messageId, setMessageId] = useState(fixture);
  const [draftToken, setDraftToken] = useState(0);
  const iframeRef = useRef(null);
  const outerRef = useRef(null);
  const scaleRef = useRef(null);
  const divRef = useRef(null);
  const immutableSourceRef = useRef(initialHtml);
  const draftRef = useRef(null);
  const acceptedFrameDocumentRef = useRef(null);
  const acceptedFrameSourceRef = useRef(null);
  const staleShortcutInjectedRef = useRef(false);
  const rootsRef = useRef(new WeakSet());
  const countsRef = useRef({ roots: 0, parses: 0, processCalls: 0, geometryPasses: 0, startedAt: 0, firstStartedAt: 0 });
  const appearance = useEmailAppearance({
    messageId,
    html,
    preference: mode,
    themeName: theme,
  });
  const frameSourceToken = useMemo(createEmailFrameSourceToken, [html]);
  const frameDocumentHtml = useMemo(() => buildEmailFrameDocument(html, {
    recovery: appearance.recovery,
    sourceToken: frameSourceToken,
  }), [appearance.recovery, frameSourceToken, html]);
  const prefix = `email-fixture-${appearance.rootKey}`;
  const prepared = useMemo(() => (
    html && renderer === 'div'
      ? prepareEmailHtml(html, prefix, { recovery: appearance.recovery })
      : null
  ), [appearance.recovery, html, prefix, renderer]);

  useEffect(() => {
    installFailureHooks();
    return () => applyCustomCss('');
  }, []);

  useEffect(() => {
    window.mailflowFixtureToggle = appearance.toggleViewMode;
  }, [appearance.toggleViewMode]);

  useEffect(() => {
    window.mailflowFixtureState = {
      generation: appearance.generation,
      status: appearance.status,
      visibility: appearance.visibility,
      renderMode: appearance.renderMode,
      desiredMode: appearance.desiredMode,
      sourceRevision: appearance.sourceRevision,
    };
    window.mailflowFixtureAction = action => {
      if (action === 'message') setMessageId(value => `${value}-next`);
      else if (action === 'theme') applyTheme('light');
      else if (action === 'custom') applyCustomCss(':root { --accent: #008000; }');
      else if (action === 'custom-remove') applyCustomCss('');
      else if (action === 'view') appearance.toggleViewMode();
    };
  }, [appearance]);

  useEffect(() => {
    window.mailflowFixtureReplaceHtml = nextHtml => setHtml(nextHtml);
    window.mailflowFixtureReplaceScenario = nextScenario => setHtml(htmlForScenario(nextScenario) || plainHtml);
    window.mailflowFixtureReplaceMessageScenario = nextScenario => {
      setMessageId(value => `${value}-hostile`);
      setHtml(htmlForScenario(nextScenario));
    };
  }, []);

  useLayoutEffect(() => {
    if (!prepared) return undefined;
    injectEmailStyles(prepared.prefix, prepared.styleBlocks);
    return () => removeEmailStyles(prepared.prefix);
  }, [prepared]);

  const complete = (root, styleSheets) => {
    const resolvedRoot = root.nodeType === 9 ? root.documentElement : root;
    const canvas = root.nodeType === 9 ? root.body : root;
    const canvasStyle = styleFor(root, canvas);
    const paletteFingerprint = appearance.evidence?.paletteFingerprint
      || window.mailflowFixtureDraftEvidence?.paletteFingerprint;
    const [background, elevated, text, mutedText, accent, border] = (paletteFingerprint || '').split('|');
    const mutations = mutationEvidence(
      root,
      appearance.evidence?.mutations,
      window.mailflowFixtureDraftEvidence?.mutationBefore,
    );
    const canonicalBody = { html, text: '' };
    const cache = {};
    const cacheOrder = [];
    cacheCanonicalEmailBody(cache, cacheOrder, 'fixture-message', canonicalBody);
    const replyContent = buildReplyBodyContent({
      body: canonicalBody, date: 'Generic date', from: 'sender@example.invalid',
    });
    const forwardContent = buildForwardBodyContent({
      body: canonicalBody,
      date: 'Generic date',
      from: 'sender@example.invalid',
      subject: 'Generic subject',
      to: 'recipient@example.invalid',
      cc: '',
    });
    const aiText = emailBodyTextForAi(canonicalBody);
    const rootChanged = Boolean(
      (window.mailflowFixtureRoot && window.mailflowFixtureRoot !== resolvedRoot)
      || (window.mailflowFixtureResult?.rootKey === appearance.rootKey
        && window.mailflowFixtureResult.rootChanged),
    );
    window.mailflowFixtureRoot = resolvedRoot;
    const result = {
      status: appearance.status,
      renderer, fixture, theme, mode, messageId,
      visibility: appearance.visibility,
      renderKey: appearance.renderKey,
      rootKey: appearance.rootKey,
      renderMode: appearance.renderMode,
      desiredMode: appearance.desiredMode,
      recovery: appearance.recovery,
      generation: appearance.generation,
      sourceRevision: appearance.sourceRevision,
      rootChanged,
      analyzerLoaded: appearance.instrumentation.engineLoads > 0,
      analyzerCalls: appearance.instrumentation.analyses,
      commitCalls: appearance.instrumentation.commits,
      changedTextContrast: textContrast(root, appearance.evidence?.mutations),
      changedPairs: mutations.filter(mutation => (
        mutation.kind === 'repair'
        && mutation.property !== 'background-color'
        && (mutation.property === 'color' || mutation.property.startsWith('border-'))
        && Number.isFinite(mutation.targetContrast)
      )),
      mutations,
      paletteFingerprint,
      paletteColors: { background, elevated, text, mutedText, accent, border },
      rootColors: {
        background: canvasStyle.backgroundColor,
        color: resolvedRoot.querySelector('h1')
          ? styleFor(root, resolvedRoot.querySelector('h1')).color
          : canvasStyle.color,
      },
      protectedColors: {
        before: window.mailflowFixtureDraftEvidence?.protectedColors || {},
        after: protectedColorSnapshot(root),
      },
      reason: appearance.evidence?.reason,
      nodeCount: appearance.evidence?.nodeCount,
      mutationCount: appearance.evidence?.mutationCount,
      attemptedMutationCount: appearance.evidence?.attemptedMutationCount,
      styleRuleCount: appearance.evidence?.styleRuleCount,
      styleWork: appearance.evidence?.styleWork,
      senderInlineStylePresent: Boolean(resolvedRoot.querySelector('[data-hostile-inline][style]')),
      senderStyleRuleCount: [...(styleSheets || [])].reduce((count, sheet) => {
        const base = sheet?.ownerNode?.hasAttribute?.('data-mailflow-email-base')
          || sheet?.ownerNode?.dataset?.mailflowEmailBase !== undefined;
        if (base) return count;
        try { return count + (sheet.cssRules?.length || 0); } catch { return count + 1; }
      }, 0),
      terminalThemeName: appearance.evidence?.themeName,
      toggleLabelKey: emailBodyAppearanceToggleLabel(appearance.desiredMode),
      rootCount: countsRef.current.roots,
      parseCount: countsRef.current.parses,
      processCalls: countsRef.current.processCalls,
      geometryPasses: countsRef.current.geometryPasses,
      terminalElapsedMs: countsRef.current.startedAt
        ? performance.now() - countsRef.current.startedAt
        : 0,
      revealDelayMs: window.mailflowFixtureRevealDelayMs,
      totalElapsedMs: countsRef.current.firstStartedAt
        ? performance.now() - countsRef.current.firstStartedAt
        : 0,
      survivingThemedMutations: survivingMutations(window.mailflowFixtureCommitBaseline),
      geometry: draftRef.current?.geometry,
      immutableBody: {
        cache: cache['fixture-message'] === canonicalBody
          && cache['fixture-message'].html === immutableSourceRef.current,
        reply: replyContent.html?.split(html).length === 2
          && canonicalBody.html === immutableSourceRef.current,
        forward: forwardContent.html?.split(html).length === 2
          && canonicalBody.html === immutableSourceRef.current,
        ai: aiText === html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          && canonicalBody.html === immutableSourceRef.current,
      },
      security: {
        allowScripts: Boolean(iframeRef.current?.sandbox?.contains('allow-scripts')),
        csp: root.nodeType === 9
          ? root.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ''
          : null,
        probeExecuted: Boolean(window.mailflowFixtureProbeExecuted),
      },
      ...forcedLightEvidence(root, styleSheets),
    };
    const remotePlaceholder = resolvedRoot.querySelector('[data-case="remote-placeholder"]');
    if (remotePlaceholder) {
      result.remotePlaceholder = {
        protected: !mutations.some(mutation => (
          mutation.protectedCase === 'remote-placeholder' && mutation.kind === 'repair'
        )),
        sourceProtocol: new URL(remotePlaceholder.src, location.href).protocol,
      };
    }
    const animatedText = resolvedRoot.querySelector('[data-case="animated-text"]');
    const animatedImage = resolvedRoot.querySelector('[data-case="animated-image"]');
    if (animatedText && animatedImage) {
      const textStyle = styleFor(root, animatedText);
      const imageStyle = styleFor(root, animatedImage);
      result.motion = {
        textAnimation: textStyle.animationName,
        textTransition: textStyle.transitionProperty,
        imageElementAnimation: imageStyle.animationName,
        imageSourceIntact: animatedImage.getAttribute('src') === './assets/animated-status.svg',
        imageAssetAnimated: /<animate\b[^>]*repeatCount="indefinite"/i.test(animatedStatusSvg),
      };
    }
    if (fixture === 'native-dark') {
      const media = applyEmailMediaMode({ root, styleSheets, scheme: theme === 'dark' ? 'dark' : 'light' });
      result.malformedSelectorPresent = hasMalformedSelector(styleSheets);
      result.mediaConditions = mediaConditions(styleSheets);
      Object.assign(result, resultFor(resolvedRoot, media, theme === 'dark'
        ? { root, styleSheets, scheme: 'light' }
        : null));
    } else if (scenario === 'responsive-color-scheme') {
      const media = applyEmailMediaMode({ root, styleSheets, scheme: 'dark' });
      result.media = media;
      result.mediaConditions = mediaConditions(styleSheets);
    }
    window.mailflowFixtureResult = result;
    window.mailflowFixtureHistory ||= [];
    window.mailflowFixtureHistory.push(result);
    document.body.dataset.status = result.status;
    document.body.dataset.geometryReady = String(Boolean(draftRef.current?.geometryReady));

    window.mailflowFixturePrintEvidence = async (printScenario = '') => {
      const analysesBefore = window.mailflowFixtureResult.analyzerCalls;
      const printFrame = document.createElement('iframe');
      printFrame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0';
      printFrame.setAttribute('sandbox', 'allow-same-origin');
      document.body.appendChild(printFrame);
      const oversized = printScenario === 'over-budget' || printScenario === 'unwritable-owner';
      const printHtml = oversized
        ? `${[0, 2600].map(offset => `<style>${Array.from({ length: 2600 }, (_, index) => `.rule-${offset + index}{color:#111}`).join('')}</style>`).join('')}<p data-print-copy>Readable print body</p>`
        : html;
      let printCalls = 0;
      let closed = false;
      const targetWindow = {
        document: printFrame.contentDocument,
        focus() {},
        print() { printCalls += 1; },
        close() { closed = true; },
      };
      if (printScenario === 'unwritable-owner') {
        const nativeClose = targetWindow.document.close.bind(targetWindow.document);
        targetWindow.document.close = () => {
          nativeClose();
          const sender = targetWindow.document.querySelector('style[data-mailflow-email-print-sender]');
          sender.remove = () => { throw new Error('injected print owner removal failure'); };
        };
      }
      const payload = {
        message: {
          subject: 'Generic subject',
          from_email: 'sender@example.invalid',
          to_addresses: [{ email: 'recipient@example.invalid' }],
          cc_addresses: [],
        },
        body: { html: printHtml },
      };
      const media = printScenario === 'unwritable-owner'
        ? printEmailWindow(targetWindow, payload)
        : writeEmailPrintDocument(targetWindow, payload);
      const printDocument = printFrame.contentDocument;
      const card = printDocument.querySelector('.native-card');
      const cardBackground = card
        ? printDocument.defaultView.getComputedStyle(card).backgroundColor
        : null;
      const evidence = {
        mediaStatus: media.status,
        mediaReason: media.reason,
        cardBackground,
        senderStyleCount: printDocument.querySelectorAll('style[data-mailflow-email-print-sender]').length,
        finalBaseRetained: Boolean(printDocument.querySelector('style[data-mailflow-email-print-base][data-mailflow-email-base]')),
        printShellBaseRetained: Boolean(printDocument.querySelector('style[data-mailflow-email-print-shell][data-mailflow-email-base]')),
        printCalls,
        printWindowClosed: closed,
        bodyColor: printDocument.defaultView.getComputedStyle(printDocument.body).color,
        bodyBackground: printDocument.defaultView.getComputedStyle(printDocument.body).backgroundColor,
        printRootBackground: printDocument.defaultView.getComputedStyle(printDocument.querySelector('.email-print')).backgroundColor,
        analyzerDelta: window.mailflowFixtureResult.analyzerCalls - analysesBefore,
        htmlUnchanged: html === immutableSourceRef.current,
      };
      printFrame.remove();
      return evidence;
    };
  };

  useEffect(() => {
    if (appearance.status === 'pending') {
      document.body.dataset.status = 'pending';
      document.body.dataset.geometryReady = 'false';
      return;
    }
    const recoveryDeadlineFinishedBeforeGeometry = scenario === 'reveal-100ms'
      && appearance.status === 'fallback';
    if (!draftRef.current?.geometryReady && !recoveryDeadlineFinishedBeforeGeometry) {
      document.body.dataset.status = 'pending';
      document.body.dataset.geometryReady = 'false';
      return;
    }
    complete(draftRef.current.root, draftRef.current.styleSheets);
  }, [appearance.readyToken, appearance.status, draftToken, scenario]);

  const process = (root, styleSheets) => {
    const generation = appearance.generation;
    const resolvedRoot = root.nodeType === 9 ? root.documentElement : root;
    const newRoot = !rootsRef.current.has(resolvedRoot);
    if (newRoot) {
      rootsRef.current.add(resolvedRoot);
      countsRef.current.roots += 1;
      countsRef.current.parses += 1;
    }
    countsRef.current.processCalls += 1;
    countsRef.current.startedAt = performance.now();
    countsRef.current.firstStartedAt ||= countsRef.current.startedAt;
    window.mailflowFixtureProcessedRoots ||= [];
    window.mailflowFixtureProcessedRoots.push({
      generation,
      newRoot,
      senderInlineStylePresent: Boolean(resolvedRoot.querySelector('[style]')),
      senderStyleRuleCount: [...(styleSheets || [])].reduce((count, sheet) => {
        const base = sheet?.ownerNode?.hasAttribute?.('data-mailflow-email-base')
          || sheet?.ownerNode?.dataset?.mailflowEmailBase !== undefined;
        if (base) return count;
        try { return count + (sheet.cssRules?.length || 0); } catch { return count + 1; }
      }, 0),
    });
    if (scenario === 'baseline-persistent' || scenario === 'complexity-baseline-persistent') {
      poisonBaseline(root);
    }
    draftRef.current = { root, styleSheets, geometryReady: false, geometry: null };
    return appearance.processDraft({
      root, styleSheets, recoverySafe: appearance.recovery, rootKey: appearance.rootKey,
    }).then(ready => {
      window.mailflowFixtureProcessResults ||= [];
      window.mailflowFixtureProcessResults.push({ generation, ready });
      return ready;
    });
  };

  const finishGeometry = (root, geometry) => {
    if (draftRef.current?.root !== root) return;
    countsRef.current.geometryPasses += 1;
    draftRef.current = {
      ...draftRef.current,
      geometryReady: true,
      geometry,
    };
    setDraftToken(token => token + 1);
  };

  const setupDivGeometry = root => {
    const outer = outerRef.current;
    const scaler = scaleRef.current;
    const expandScrollContainers = createEmailScrollExpander(root);
    const geometry = applyEmailDivGeometry({
      inner: root, outer, scaler, expandScrollContainers,
    });
    return {
      nestedVerticalScrolls: nestedVerticalScrollCount(root),
      viewportWidth: geometry.viewportWidth,
      contentWidth: geometry.naturalWidth * geometry.scale,
      contentHeight: geometry.naturalHeight * geometry.scale,
      scale: geometry.scale,
    };
  };

  const setupIframeGeometry = (frameDocument, iframe) => {
    attachEmailBodyLinkHandler(frameDocument);
    const expandScrollContainers = createEmailScrollExpander(frameDocument);
    const geometry = applyEmailIframeGeometry({
      document: frameDocument, iframe, expandScrollContainers,
    });
    iframe.style.height = `${Math.ceil(geometry.naturalHeight * geometry.scale)}px`;
    return {
      nestedVerticalScrolls: nestedVerticalScrollCount(frameDocument),
      viewportWidth: geometry.viewportWidth,
      contentWidth: geometry.naturalWidth * geometry.scale,
      contentHeight: geometry.naturalHeight * geometry.scale,
      scale: geometry.scale,
    };
  };

  useEffect(() => {
    if (!prepared || !divRef.current) return;
    const root = divRef.current;
    const styleSheets = getEmailStyleSheets(prepared.prefix);
    // Preserve the draft root before processing: a deadline fallback is a
    // valid terminal result and must be observable by the harness too.
    void process(root, styleSheets).then(ready => {
      if (ready) finishGeometry(root, setupDivGeometry(root));
    });
  }, [appearance.processDraft, appearance.processToken, appearance.recovery, appearance.rootKey, prepared, scenario]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !html || renderer !== 'iframe') return undefined;
    const previousDocument = acceptedFrameDocumentRef.current;
    const previousSource = acceptedFrameSourceRef.current;
    let processedDocument = null;
    let cancelled = false;
    let frameScale = 1;

    const afterNextPaint = () => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    const processFrameDocument = async frameDocument => {
      if (!frameDocument || processedDocument === frameDocument) return false;
      if (!emailFrameDocumentMatchesSource(frameDocument, frameSourceToken)) {
        window.mailflowFixtureIframeLifecycle.rejectedSources += 1;
        return false;
      }
      frameScale = 1;
      processedDocument = frameDocument;
      if (scenario === 'stale-ready-state'
        && previousDocument
        && previousSource !== frameSourceToken
        && frameDocument !== previousDocument) {
        window.mailflowFixtureIframeLifecycle.currentSourceBlocked = true;
        await new Promise(resolve => {
          window.mailflowFixtureReleaseCurrentSource = resolve;
        });
      }
      const ready = await process(frameDocument, [...frameDocument.styleSheets]);
      if (!ready
        || iframe.contentDocument !== frameDocument
        || !emailFrameDocumentMatchesSource(frameDocument, frameSourceToken)) return false;
      if (scenario === 'paint-before-geometry') {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.mailflowFixtureFirstVisibleAt = performance.now();
        }));
        window.mailflowFixtureGeometryStartedAt = performance.now();
      }
      await afterNextPaint();
      if (cancelled
        || iframe.contentDocument !== frameDocument
        || !emailFrameDocumentMatchesSource(frameDocument, frameSourceToken)) return false;
      if (scenario === 'paint-before-geometry') {
        window.mailflowFixturePaintObservedBeforeGeometry = Boolean(window.mailflowFixtureFirstVisibleAt);
        window.mailflowFixtureGeometryStartedAt = performance.now();
      }
      acceptedFrameDocumentRef.current = frameDocument;
      acceptedFrameSourceRef.current = frameSourceToken;
      const geometry = setupIframeGeometry(frameDocument, iframe);
      frameScale = geometry.scale;
      finishGeometry(frameDocument, geometry);
      if (scenario === 'paint-before-geometry') {
        window.mailflowFixtureGeometryFinishedAt = performance.now();
      }
      window.mailflowFixtureIframeLifecycle.geometryPasses += 1;
      return true;
    };

    const onLoaded = () => {
      window.mailflowFixtureIframeLifecycle.loads += 1;
      void processFrameDocument(iframe.contentDocument).then(() => {
        window.mailflowFixtureIframeLifecycle.scaleAfterLoad = frameScale;
      });
    };
    iframe.addEventListener('load', onLoaded, { once: true });
    if (scenario === 'stale-ready-state'
      && !staleShortcutInjectedRef.current
      && previousDocument?.readyState === 'complete'
      && previousSource !== frameSourceToken) {
      staleShortcutInjectedRef.current = true;
      window.mailflowFixtureIframeLifecycle.staleShortcutAttempts += 1;
      void processFrameDocument(previousDocument).finally(() => {
        window.mailflowFixtureIframeLifecycle.staleShortcutComplete = true;
      });
    }
    if (iframe.contentDocument?.readyState === 'complete') {
      window.mailflowFixtureIframeLifecycle.readyStateShortcuts += 1;
      void processFrameDocument(iframe.contentDocument);
    }
    let domReadyRafId = 0;
    if (!scenario || scenario === 'dom-parsed-no-load') {
      const revealWhenParsed = () => {
        const doc = iframe.contentDocument;
        if (doc && doc.readyState !== 'loading'
          && emailFrameDocumentMatchesSource(doc, frameSourceToken)) {
          void processFrameDocument(doc);
          return;
        }
        domReadyRafId = requestAnimationFrame(revealWhenParsed);
      };
      revealWhenParsed();
    }
    return () => {
      cancelled = true;
      if (domReadyRafId) cancelAnimationFrame(domReadyRafId);
      iframe.removeEventListener('load', onLoaded);
    };
  }, [appearance.processDraft, appearance.processToken, appearance.recovery, appearance.rootKey, frameSourceToken, html, renderer, scenario]);

  if (!html) return <div>Loading fixture</div>;
  return renderer === 'iframe'
    ? <iframe key={`${messageId}:${appearance.renderKey}`} ref={iframeRef} title="Email fixture" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={frameDocumentHtml} scrolling="no" style={{ width: 1, minWidth: '100%', border: 0, display: 'block', visibility: appearance.visibility }} />
    : <div ref={outerRef} style={{ position: 'relative', width: '100%', visibility: appearance.visibility }} onClick={handleEmailBodyLinkClick}>
      <div ref={scaleRef}>
        <div
          key={appearance.rootKey}
          ref={divRef}
          data-fixture-root
          className={prepared?.prefix ?? ''}
          dangerouslySetInnerHTML={prepared ? { __html: prepared.html } : undefined}
        />
      </div>
    </div>;
}

const initialParams = new URLSearchParams(location.search);
applyTheme(initialParams.get('theme') || 'dark');
applyCustomCss(customCssCases[initialParams.get('custom')] || '');
window.mailflowFixtureProbeExecuted = false;
setEmailAppearanceTestControls(acceptanceControlsFor(
  initialParams.get('scenario'), initialParams.get('boundary'),
));
const mount = document.getElementById('root');
const iframeLifecycle = {
  insertions: 0, removals: 0, navigationAttempts: 0, loads: 0,
  readyStateShortcuts: 0, staleShortcutAttempts: 0, staleShortcutComplete: false,
  currentSourceBlocked: false, rejectedSources: 0, geometryPasses: 0,
};
const countIframes = node => {
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  return Number(node.matches('iframe')) + node.querySelectorAll('iframe').length;
};
new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'attributes') iframeLifecycle.navigationAttempts += 1;
    for (const node of record.addedNodes) iframeLifecycle.insertions += countIframes(node);
    for (const node of record.removedNodes) iframeLifecycle.removals += countIframes(node);
  }
}).observe(mount, {
  attributes: true, attributeFilter: ['srcdoc'], childList: true, subtree: true,
});
window.mailflowFixtureIframeLifecycle = iframeLifecycle;
createRoot(mount).render(<Harness />);
