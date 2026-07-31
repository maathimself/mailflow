import {
  compositeColors,
  contrastRatio,
  formatCssColor,
  hslToRgb,
  isNeutralColor,
  mixColors,
  parseCssColor,
  relativeLuminance,
  repairColorContrast,
  rgbToHsl,
} from './emailColors.js';
import { cssControlText } from './cssControlText.js';

export const DEFAULT_EMAIL_APPEARANCE_BUDGETS = Object.freeze({
  maxNodes: 5000,
  maxAnalysisMs: 40,
  maxMutations: 10000,
  maxStyleRules: 5000,
  maxPseudoSelectorChars: 32768,
  maxComputedValueChars: 4096,
  deadline: Infinity,
  clock: () => performance.now(),
});

const RASTER_TAGS = new Set(['IMG', 'PICTURE', 'CANVAS', 'VIDEO']);
const LAYOUT_TAGS = new Set([
  'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH',
  'DIV', 'SPAN', 'CENTER', 'A', 'BR',
]);
const IMAGE_BACKING_TAGS = new Set(['TD', 'TH', 'DIV', 'TABLE', 'CENTER']);
const SNAPSHOT_PROPERTIES = [
  'color', 'webkitTextFillColor', 'backgroundColor', 'backgroundImage',
  'borderTopColor', 'borderTopWidth', 'borderTopStyle',
  'borderRightColor', 'borderRightWidth', 'borderRightStyle',
  'borderBottomColor', 'borderBottomWidth', 'borderBottomStyle',
  'borderLeftColor', 'borderLeftWidth', 'borderLeftStyle',
  'opacity', 'filter', 'backdropFilter', 'mixBlendMode', 'backgroundBlendMode',
];
const BORDER_SIDES = [
  ['Top', 'border-top-color'], ['Right', 'border-right-color'],
  ['Bottom', 'border-bottom-color'], ['Left', 'border-left-color'],
];

class EmailAppearanceFallback extends Error {
  constructor(reason, evidence = {}) {
    super(reason);
    this.reason = reason;
    Object.assign(this, evidence);
  }
}

function hasUnknownPixels(node) {
  const style = node.style;
  return RASTER_TAGS.has(node.tagName)
    || style.backgroundImage !== 'none'
    || Number(style.opacity) < 1
    || style.filter !== 'none'
    || style.backdropFilter !== 'none'
    || style.mixBlendMode !== 'normal'
    || style.backgroundBlendMode !== 'normal'
    || node.imageOnlyBacking;
}

function resolveBudget(overrides = {}) {
  return { ...DEFAULT_EMAIL_APPEARANCE_BUDGETS, ...overrides };
}

function elapsed(budget, startedAt) {
  return budget.clock() - startedAt;
}

function analysisBudgetExpired(budget, startedAt) {
  const now = budget.clock();
  return now >= budget.deadline || now - startedAt > budget.maxAnalysisMs;
}

function assertAnalysisBudget(budget, startedAt) {
  if (analysisBudgetExpired(budget, startedAt)) {
    throw new EmailAppearanceFallback('analysis_deadline');
  }
}

function assertWithinBudget(index, budget, startedAt) {
  if (index % 64 === 0) assertAnalysisBudget(budget, startedAt);
}

function aggregateSubtrees(snapshots) {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const node = snapshots[index];
    node.subtreeHasRaster ||= node.isRaster;
    node.subtreeHasText ||= node.hasOwnText;
    node.subtreeHasNonLayoutContent ||= node.isNonLayoutContent;
    node.imageOnlyBacking = IMAGE_BACKING_TAGS.has(node.tagName)
      && node.subtreeHasRaster && !node.subtreeHasText && !node.subtreeHasNonLayoutContent;
    if (node.parentIndex >= 0) {
      const parent = snapshots[node.parentIndex];
      parent.subtreeHasRaster ||= node.subtreeHasRaster;
      parent.subtreeHasText ||= node.subtreeHasText;
      parent.subtreeHasNonLayoutContent ||= node.subtreeHasNonLayoutContent;
    }
  }
}

function collectElements(root, budget, startedAt) {
  const doc = root.ownerDocument;
  const showElement = doc.defaultView?.NodeFilter?.SHOW_ELEMENT || globalThis.NodeFilter?.SHOW_ELEMENT || 1;
  const walker = doc.createTreeWalker(root, showElement);
  const elements = [root];
  let node;
  while ((node = walker.nextNode())) {
    elements.push(node);
    if (elements.length > budget.maxNodes) return { status: 'fallback', reason: 'node_limit', elements };
    assertWithinBudget(elements.length, budget, startedAt);
  }
  if (analysisBudgetExpired(budget, startedAt)) {
    return { status: 'fallback', reason: 'analysis_deadline', elements };
  }
  return { status: 'ready', elements };
}

function boundedComputedValue(value, budget, reason) {
  const text = String(value || '');
  if (text.length > budget.maxComputedValueChars) throw new EmailAppearanceFallback(reason);
  return text;
}

function hasDynamicPaint(style, budget) {
  const animationName = boundedComputedValue(style.animationName || 'none', budget, 'dynamic_paint_unproven');
  const transitionProperty = boundedComputedValue(style.transitionProperty || 'all', budget, 'dynamic_paint_unproven');
  const transitionDuration = boundedComputedValue(style.transitionDuration || '0s', budget, 'dynamic_paint_unproven');
  const transitionDelay = boundedComputedValue(style.transitionDelay || '0s', budget, 'dynamic_paint_unproven');
  const animationNames = animationName.split(',');
  const transitionHasTime = `${transitionDuration},${transitionDelay}`.split(',')
    .some(value => Number.parseFloat(value) > 0);
  return animationNames.some(name => name.trim().toLowerCase() !== 'none')
    || (transitionProperty.trim().toLowerCase() !== 'none'
      && transitionHasTime);
}

function nodeHasOwnText(element, budget) {
  return [...element.childNodes].some(child => {
    if (child.nodeType !== 3) return false;
    const text = String(child.textContent || '');
    return text.length > budget.maxComputedValueChars || /\S/.test(text);
  });
}

function readSnapshot(elements, canvas, budget, startedAt) {
  const indexes = new Map(elements.map((element, index) => [element, index]));
  const snapshots = elements.map((element, index) => {
    assertWithinBudget(index, budget, startedAt);
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    if (hasDynamicPaint(style, budget)) throw new EmailAppearanceFallback('dynamic_paint_unproven');
    const display = boundedComputedValue(style.display, budget, 'generated_content_unproven').trim().toLowerCase();
    const listStyleType = boundedComputedValue(style.listStyleType || 'none', budget, 'generated_content_unproven');
    const listStyleImage = boundedComputedValue(style.listStyleImage || 'none', budget, 'generated_content_unproven');
    const isListItem = /(?:^|\s)list-item(?:$|\s)/.test(display);
    if (isListItem && listStyleImage.trim().toLowerCase() !== 'none') {
      throw new EmailAppearanceFallback('generated_content_unproven');
    }
    return {
      element,
      parentIndex: indexes.get(element.parentElement) ?? -1,
      tagName: element.tagName,
      isCanvas: element === canvas,
      hasOwnText: nodeHasOwnText(element, budget)
        || (isListItem && listStyleType.trim().toLowerCase() !== 'none'),
      isRaster: RASTER_TAGS.has(element.tagName),
      isNonLayoutContent: !LAYOUT_TAGS.has(element.tagName) && !RASTER_TAGS.has(element.tagName),
      style: Object.fromEntries(SNAPSHOT_PROPERTIES.map(property => [
        property,
        boundedComputedValue(style[property], budget, 'style_complexity_limit'),
      ])),
    };
  });
  assertAnalysisBudget(budget, startedAt);
  aggregateSubtrees(snapshots);
  return snapshots;
}

function visibleGeneratedContent(content, budget) {
  const raw = boundedComputedValue(content, budget, 'generated_content_unproven');
  const value = raw.trim();
  if (!value || value === 'none' || value === 'normal') return false;
  return value.replace(/[\s"']/g, '').length > 0;
}

const CONTENT_PSEUDOS = ['before', 'after'];
const TEXT_PSEUDOS = ['marker', 'first-line', 'first-letter'];
const TRACKED_PSEUDOS = [...CONTENT_PSEUDOS, ...TEXT_PSEUDOS];
const TRACKED_PSEUDO_PATTERN = /:{1,2}(?:before|after|marker|first-line|first-letter)\b/gi;

function nestedRulesActive(rule, parentActive, view, conditionText) {
  if (!parentActive) return false;
  if (rule?.media && conditionText && typeof view?.matchMedia === 'function') {
    try { return view.matchMedia(conditionText).matches; } catch { return true; }
  }
  if (rule?.constructor?.name === 'CSSSupportsRule'
    && conditionText
    && typeof view?.CSS?.supports === 'function') {
    try { return view.CSS.supports(conditionText); } catch { return true; }
  }
  // Container and unknown grouping rules cannot be proved inactive without
  // layout-specific evaluation, so they remain conservatively active.
  return true;
}

function isEmailBaseSheet(sheet) {
  return sheet?.ownerNode?.hasAttribute?.('data-mailflow-email-base')
    || sheet?.ownerNode?.dataset?.mailflowEmailBase !== undefined;
}

const DYNAMIC_STATE_PSEUDO = /:(?:hover|focus(?:-visible|-within)?|active|target|visited|link)(?![\w-])/i;
const FUNCTIONAL_SELECTOR_PSEUDO = /:[\w-]+\s*\(/i;
const COSTLY_STYLE_SELECTOR = /:(?:has|nth-(?:child|last-child|of-type|last-of-type))\s*\(/i;

function assertAuthoredStyleBudget(elements, styleSheets, budget, startedAt) {
  let total = 0;
  const count = value => {
    const text = String(value || '');
    if (text.length > 65536) {
      throw new EmailAppearanceFallback('style_complexity_limit');
    }
    total += text.length;
    if (total > 1048576) {
      throw new EmailAppearanceFallback('style_complexity_limit');
    }
  };
  let index = 0;
  for (; index < (styleSheets?.length || 0); index += 1) {
    assertWithinBudget(index, budget, startedAt);
  }
  for (const element of elements) {
    assertWithinBudget(index, budget, startedAt);
    count(element.getAttribute?.('style'));
    index += 1;
  }
  assertAnalysisBudget(budget, startedAt);
  return count;
}

function pseudoSelectors(styleSheets, view, budget, startedAt, documentRoot, authoredStyle) {
  const selectors = Object.fromEntries(TRACKED_PSEUDOS.map(pseudo => [pseudo, new Set()]));
  const stack = [...(styleSheets || [])].filter(sheet => (
    !isEmailBaseSheet(sheet)
  )).map(owner => ({ owner, active: true })).reverse();
  let ruleCount = 0;
  let scannedChars = 0;
  let queryChars = 0;
  const countScannedText = value => {
    scannedChars += value.length;
    if (scannedChars > budget.maxPseudoSelectorChars) {
      throw new EmailAppearanceFallback('pseudo_selector_limit');
    }
  };
  while (stack.length) {
    const { owner, active } = stack.pop();
    let rules;
    try { rules = owner?.cssRules; } catch { throw new EmailAppearanceFallback('pseudo_rule_unreadable'); }
    if (!rules) continue;
    for (let index = 0; index < rules.length; index += 1) {
      ruleCount += 1;
      if (ruleCount > budget.maxStyleRules) throw new EmailAppearanceFallback('pseudo_rule_limit');
      assertWithinBudget(ruleCount, budget, startedAt);
      const rule = rules[index];
      authoredStyle(rule?.style?.cssText);
      const selectorText = typeof rule?.selectorText === 'string' ? rule.selectorText : '';
      countScannedText(selectorText);
      const controlText = selectorText && cssControlText(selectorText);
      if (controlText && DYNAMIC_STATE_PSEUDO.test(controlText)) {
        throw new EmailAppearanceFallback('interaction_paint_unproven');
      }
      if (controlText && COSTLY_STYLE_SELECTOR.test(controlText)) {
        throw new EmailAppearanceFallback('style_complexity_limit');
      }
      const ruleType = rule?.constructor?.name;
      const condition = typeof rule?.conditionText === 'string' ? rule.conditionText : '';
      countScannedText(condition);
      const isMediaRule = ruleType === 'CSSMediaRule' || Boolean(rule?.media);
      let isContainerRule = ruleType === 'CSSContainerRule';
      if (!isContainerRule && documentRoot && !ruleType) {
        const cssText = typeof rule?.cssText === 'string' ? rule.cssText : '';
        countScannedText(cssText);
        isContainerRule = /^\s*@container\b/i.test(cssText);
      }
      if ((isMediaRule && condition !== '(min-width: 0px)' && condition !== '(max-width: -1px)')
        || (documentRoot && isContainerRule)) {
        throw new EmailAppearanceFallback('geometry_condition_unproven');
      }
      stack.push({ owner: rule, active: nestedRulesActive(rule, active, view, condition) });
      TRACKED_PSEUDO_PATTERN.lastIndex = 0;
      if (!active || !selectorText || !TRACKED_PSEUDO_PATTERN.test(selectorText)) continue;
      if (FUNCTIONAL_SELECTOR_PSEUDO.test(controlText)) {
        throw new EmailAppearanceFallback('pseudo_selector_unproven');
      }
      TRACKED_PSEUDO_PATTERN.lastIndex = 0;
      const localSelector = selectorText.replace(TRACKED_PSEUDO_PATTERN, '').trim() || '*';
      for (const pseudo of TRACKED_PSEUDOS) {
        if (!new RegExp(`:{1,2}${pseudo}\\b`, 'i').test(selectorText)) continue;
        if (selectors[pseudo].has(localSelector)) continue;
        queryChars += localSelector.length + Number(selectors[pseudo].size > 0);
        if (queryChars > 256) {
          throw new EmailAppearanceFallback('pseudo_selector_limit');
        }
        selectors[pseudo].add(localSelector);
      }
    }
  }
  return { ruleCount, selectors };
}

function assertGeneratedContentSafe(elements, styleSheets, budget, startedAt, documentRoot) {
  const view = elements[0]?.ownerDocument?.defaultView;
  const countAuthoredStyle = assertAuthoredStyleBudget(elements, styleSheets, budget, startedAt);
  const prepass = pseudoSelectors(styleSheets, view, budget, startedAt, documentRoot, countAuthoredStyle);
  const styleWork = elements.length * prepass.ruleCount;
  if (styleWork > 250000) {
    throw new EmailAppearanceFallback('style_complexity_limit');
  }
  const doc = elements[0]?.ownerDocument;
  const scope = documentRoot ? doc : elements[0];
  for (const pseudo of TRACKED_PSEUDOS) {
    const values = prepass.selectors[pseudo];
    if (!values.size) continue;
    const selector = [...values].join(',');
    assertAnalysisBudget(budget, startedAt);
    let matches;
    try {
      matches = new Set(scope.querySelectorAll(selector));
      if (!documentRoot && elements[0].matches(selector)) matches.add(elements[0]);
    } catch {
      throw new EmailAppearanceFallback('pseudo_selector_unproven');
    }
    assertAnalysisBudget(budget, startedAt);
    if (TEXT_PSEUDOS.includes(pseudo) && matches.size) {
      throw new EmailAppearanceFallback('generated_content_unproven');
    }
    let index = 0;
    for (const element of matches) {
      assertWithinBudget(index, budget, startedAt);
      const style = element.ownerDocument.defaultView.getComputedStyle(element, `::${pseudo}`);
      if (hasDynamicPaint(style, budget)) throw new EmailAppearanceFallback('dynamic_paint_unproven');
      if (visibleGeneratedContent(style.content, budget)) {
        throw new EmailAppearanceFallback('generated_content_unproven');
      }
      index += 1;
    }
  }
  assertAnalysisBudget(budget, startedAt);
}

function sourceBackgrounds(snapshots, budget, startedAt) {
  const backgrounds = [];
  const colors = [];
  const pairedTextFills = new Set();
  const protectedRoots = new Set();
  const protectedNodes = new Set();
  for (let index = 0; index < snapshots.length; index += 1) {
    assertWithinBudget(index, budget, startedAt);
    const node = snapshots[index];
    const parentBackground = node.parentIndex >= 0 ? backgrounds[node.parentIndex] : null;
    const rawBackground = parseCssColor(node.style.backgroundColor);
    if (!rawBackground) throw new EmailAppearanceFallback('contrast_unproven');
    backgrounds[index] = rawBackground.a < 1 && parentBackground
      ? compositeColors(rawBackground, parentBackground)
      : rawBackground;
    const color = parseCssColor(node.style.color);
    if (!color) throw new EmailAppearanceFallback('contrast_unproven');
    colors[index] = color;
    if (node.hasOwnText) {
      const rawTextFill = String(node.style.webkitTextFillColor || '').trim();
      // Computed style resolves default, inherited, and currentColor fills to
      // the element color in supporting engines. Empty is an unsupported/no-op
      // channel; retaining currentColor also keeps synthetic snapshots safe.
      if (rawTextFill && rawTextFill.toLowerCase() !== 'currentcolor') {
        const textFill = parseCssColor(rawTextFill);
        const samePaint = textFill && ['r', 'g', 'b', 'a'].every(channel => (
          Math.abs(textFill[channel] - color[channel]) < 0.01
        ));
        if (!samePaint) throw new EmailAppearanceFallback('text_fill_unproven');
        pairedTextFills.add(index);
      }
    }
    const parentProtected = node.parentIndex >= 0 && protectedNodes.has(node.parentIndex);
    if (parentProtected) protectedNodes.add(index);
    else if (hasUnknownPixels(node)) {
      protectedRoots.add(index);
      protectedNodes.add(index);
    }
  }
  assertAnalysisBudget(budget, startedAt);
  return { backgrounds, colors, pairedTextFills, protectedRoots, protectedNodes };
}

function mutation(state, entry, budget) {
  if (state.mutations.length >= budget.maxMutations) {
    throw new EmailAppearanceFallback('mutation_limit', {
      mutationCount: state.mutations.length,
      attemptedMutationCount: state.mutations.length + 1,
    });
  }
  state.mutations.push(entry);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function representedAlpha(value) {
  const byte = Math.round(clamp(Number(value), 0, 1) * 255);
  const exact = byte / 255;
  for (let decimals = 0; decimals <= 3; decimals += 1) {
    const scale = 10 ** decimals;
    const candidate = Math.round(exact * scale) / scale;
    if (Math.round(candidate * 255) === byte) return candidate;
  }
  return exact;
}

function representedColor(color) {
  return {
    r: Math.round(clamp(Number(color.r), 0, 255)),
    g: Math.round(clamp(Number(color.g), 0, 255)),
    b: Math.round(clamp(Number(color.b), 0, 255)),
    a: representedAlpha(color.a),
  };
}

function addRepair(state, node, property, value, sourceContrast, targetContrast, budget) {
  mutation(state, {
    kind: 'repair', element: node.element, property, value: formatCssColor(value), sourceContrast, targetContrast,
  }, budget);
}

function addPreserve(state, node, property, color, budget) {
  mutation(state, {
    kind: 'preserve', element: node.element, property, value: formatCssColor(color), sourceContrast: null, targetContrast: null,
  }, budget);
}

function repaired(color, background, minimum) {
  if (!repairColorContrast(color, background, minimum)) {
    throw new EmailAppearanceFallback('contrast_unproven');
  }
  const source = rgbToHsl(color);
  const opacity = representedAlpha(color.a);
  const representedSource = representedColor({ ...color, a: opacity });
  if (contrastRatio(representedSource, background) >= minimum) return representedSource;
  const candidates = [];
  for (const extreme of [0, 1]) {
    let passing = extreme;
    let passingColor = representedColor({ ...hslToRgb({ ...source, l: extreme }), a: opacity });
    if (contrastRatio(passingColor, background) < minimum) continue;
    let failing = source.l;
    for (let iteration = 0; iteration < 24; iteration += 1) {
      const lightness = (failing + passing) / 2;
      const candidate = representedColor({ ...hslToRgb({ ...source, l: lightness }), a: opacity });
      if (contrastRatio(candidate, background) >= minimum) {
        passing = lightness;
        passingColor = candidate;
      } else {
        failing = lightness;
      }
    }
    candidates.push({ color: passingColor, distance: Math.abs(passing - source.l) });
  }
  candidates.sort((first, second) => first.distance - second.distance);
  if (!candidates.length) throw new EmailAppearanceFallback('contrast_unproven');
  return candidates[0].color;
}

function cachedTarget(state, source, role, sourceBackground, background, palette, build) {
  const rgbaKey = color => `${color.r},${color.g},${color.b},${color.a}`;
  const key = `${rgbaKey(source)}|${role}|${rgbaKey(sourceBackground)}|${rgbaKey(background)}|${palette.fingerprint}`;
  if (!state.cache.has(key)) state.cache.set(key, build());
  return state.cache.get(key);
}

function paletteBackground(source, palette) {
  const first = relativeLuminance(palette.background) <= relativeLuminance(palette.elevated)
    ? palette.background : palette.elevated;
  const second = first === palette.background ? palette.elevated : palette.background;
  return mixColors(first, second, relativeLuminance(source));
}

function isInjectedDefault(node, color) {
  return Math.abs(color.r - 26) < 0.01 && Math.abs(color.g - 26) < 0.01 && Math.abs(color.b - 26) < 0.01
    && color.a === 1 && node.tagName !== 'A';
}

function isInjectedLink(node, color) {
  return node.tagName === 'A' && Math.abs(color.r - 99) < 0.01
    && Math.abs(color.g - 102) < 0.01 && Math.abs(color.b - 241) < 0.01 && color.a === 1;
}

function foregroundRole(node, color) {
  if (isInjectedDefault(node, color)) return 'default-foreground';
  return isInjectedLink(node, color) ? 'default-link' : 'foreground';
}

function mapForeground(node, source, sourceBackground, background, palette) {
  const sourceContrast = contrastRatio(source, sourceBackground);
  let target;
  if (isInjectedDefault(node, source)) target = repaired(palette.text, background, 4.5);
  else if (isInjectedLink(node, source)) target = repaired(palette.accent, background, 4.5);
  else if (isNeutralColor(source, 'foreground')) {
    const strength = (Math.min(sourceContrast, 21) - 1) / 20;
    target = mixColors(palette.mutedText, palette.text, strength);
    target = repaired(target, background, 4.5);
  } else if (contrastRatio(source, background) < 4.5) target = repaired(source, background, 4.5);
  else return null;
  const targetContrast = contrastRatio(target, background);
  if (targetContrast < 4.5) throw new EmailAppearanceFallback('contrast_unproven');
  return { target, sourceContrast, targetContrast };
}

function mapBorder(source, sourceBackground, background, palette) {
  const sourceContrast = contrastRatio(source, sourceBackground);
  let target;
  if (isNeutralColor(source, 'foreground')) target = repaired(palette.border, background, 3);
  else if (contrastRatio(source, background) < 3) target = repaired(source, background, 3);
  else return null;
  const targetContrast = contrastRatio(target, background);
  if (targetContrast < 3) throw new EmailAppearanceFallback('contrast_unproven');
  return { target, sourceContrast, targetContrast };
}

function preservationPlan(snapshots, source, budget, startedAt) {
  const rootLocal = new Map();
  const boundaries = new Map();
  let processedRoots = 0;
  for (const index of source.protectedRoots) {
    processedRoots += 1;
    assertWithinBudget(processedRoots, budget, startedAt);
    const node = snapshots[index];
    const style = node.style;
    const hasCompositingEffect = Number(style.opacity) < 1 || style.filter !== 'none'
      || style.backdropFilter !== 'none' || style.mixBlendMode !== 'normal' || style.backgroundBlendMode !== 'normal';
    if (hasCompositingEffect) {
      let boundary = node.parentIndex;
      while (boundary >= 0 && source.protectedNodes.has(boundary)) boundary = snapshots[boundary].parentIndex;
      if (boundary < 0) throw new EmailAppearanceFallback('protected_backdrop_unpreservable');
      boundaries.set(boundary, source.backgrounds[node.parentIndex]);
    } else if (parseCssColor(style.backgroundColor)?.a < 1) {
      rootLocal.set(index, source.backgrounds[index]);
    }
  }
  assertAnalysisBudget(budget, startedAt);
  return { rootLocal, boundaries };
}

function plannedBackground(node, sourceColor, parentBackground, palette) {
  if (node.isCanvas) {
    const target = representedColor(palette.background);
    return { effective: target, repair: target };
  }
  if (sourceColor.a < 1) {
    return { effective: compositeColors(sourceColor, parentBackground), repair: null };
  }
  if (!isNeutralColor(sourceColor, 'background')) return { effective: sourceColor, repair: null };
  const target = representedColor(paletteBackground(sourceColor, palette));
  return { effective: target, repair: target };
}

export function planEmailAppearance(snapshots, palette, overrides = {}) {
  const budget = resolveBudget(overrides);
  const startedAt = overrides.startedAt ?? budget.clock();
  const state = { mutations: [], cache: new Map() };
  try {
    const source = sourceBackgrounds(snapshots, budget, startedAt);
    const preservation = preservationPlan(snapshots, source, budget, startedAt);
    const planned = [];
    for (let index = 0; index < snapshots.length; index += 1) {
      assertWithinBudget(index, budget, startedAt);
      const node = snapshots[index];
      const parentBackground = node.parentIndex >= 0 ? planned[node.parentIndex] : palette.background;
      if (source.protectedNodes.has(index)) {
        planned[index] = source.backgrounds[index];
        if (source.protectedRoots.has(index)) {
          addPreserve(state, node, 'color', source.colors[index], budget);
          const backing = preservation.rootLocal.get(index);
          if (backing) addPreserve(state, node, 'background-color', backing, budget);
        }
        continue;
      }
      const boundary = preservation.boundaries.get(index);
      if (boundary) {
        const writtenBoundary = representedColor(boundary);
        planned[index] = writtenBoundary;
        addPreserve(state, node, 'background-color', writtenBoundary, budget);
      } else {
        const background = plannedBackground(node, parseCssColor(node.style.backgroundColor), parentBackground, palette);
        planned[index] = background.effective;
        if (background.repair) {
          const sourceBackground = source.backgrounds[index];
          const sourceContrast = contrastRatio(sourceBackground, parentBackground);
          addRepair(state, node, 'background-color', background.repair, sourceContrast,
            contrastRatio(background.repair, parentBackground), budget);
        }
      }
      if (node.hasOwnText) {
        const sourceColor = source.colors[index];
        const foreground = cachedTarget(state, sourceColor, foregroundRole(node, sourceColor),
          source.backgrounds[index], planned[index], palette,
          () => mapForeground(node, sourceColor, source.backgrounds[index], planned[index], palette));
        if (foreground) {
          addRepair(state, node, 'color', foreground.target, foreground.sourceContrast, foreground.targetContrast, budget);
          if (source.pairedTextFills.has(index)) {
            addRepair(state, node, '-webkit-text-fill-color', foreground.target,
              foreground.sourceContrast, foreground.targetContrast, budget);
          }
        }
      }
      for (const [side, property] of BORDER_SIDES) {
        if (!(Number.parseFloat(node.style[`border${side}Width`]) > 0)
          || ['none', 'hidden'].includes(node.style[`border${side}Style`])) continue;
        const sourceColor = parseCssColor(node.style[`border${side}Color`]);
        if (!sourceColor) throw new EmailAppearanceFallback('contrast_unproven');
        const border = cachedTarget(state, sourceColor, 'border', source.backgrounds[index], planned[index], palette,
          () => mapBorder(sourceColor, source.backgrounds[index], planned[index], palette));
        if (border) addRepair(state, node, property, border.target, border.sourceContrast, border.targetContrast, budget);
      }
    }
    assertAnalysisBudget(budget, startedAt);
    return { status: 'ready', mutations: state.mutations, nodeCount: snapshots.length, elapsedMs: elapsed(budget, startedAt) };
  } catch (error) {
    if (error instanceof EmailAppearanceFallback) {
      return {
        status: 'fallback',
        reason: error.reason,
        nodeCount: snapshots.length,
        mutationCount: error.mutationCount,
        attemptedMutationCount: error.attemptedMutationCount,
        elapsedMs: elapsed(budget, startedAt),
      };
    }
    throw error;
  }
}

export function analyzeEmailAppearance(rootOrDocument, palette, overrides = {}) {
  const budget = resolveBudget(overrides);
  const startedAt = budget.clock();
  const isDocument = rootOrDocument?.nodeType === 9;
  const root = isDocument ? rootOrDocument.documentElement : rootOrDocument;
  const canvas = isDocument ? rootOrDocument.body : root;
  let elements = [];
  try {
    assertAnalysisBudget(budget, startedAt);
    const collected = collectElements(root, budget, startedAt);
    elements = collected.elements || [];
    if (collected.status === 'fallback') {
      return { status: 'fallback', reason: collected.reason, nodeCount: elements.length, elapsedMs: elapsed(budget, startedAt) };
    }
    assertGeneratedContentSafe(elements, overrides.styleSheets, budget, startedAt, isDocument);
    const snapshots = readSnapshot(elements, canvas, budget, startedAt);
    return planEmailAppearance(snapshots, palette, { ...budget, startedAt });
  } catch (error) {
    return {
      status: 'fallback',
      reason: error instanceof EmailAppearanceFallback ? error.reason : 'computed_style_error',
      nodeCount: elements.length,
      elapsedMs: elapsed(budget, startedAt),
    };
  }
}

export function commitEmailAppearance(result, { deadline, clock = () => performance.now() }) {
  if (result.status !== 'ready') return false;
  const undo = [];
  let rolledBack = false;
  const rollback = cause => {
    if (rolledBack) return;
    let rollbackCause = null;
    for (let index = undo.length - 1; index >= 0; index -= 1) {
      const previous = undo[index];
      try {
        if (previous.value) previous.style.setProperty(previous.property, previous.value, previous.priority);
        else previous.style.removeProperty(previous.property);
      } catch (error) {
        rollbackCause ||= error;
      }
    }
    if (rollbackCause) {
      const error = new Error('email_appearance_rollback_failed', { cause });
      error.rollbackFailed = true;
      error.rollbackCause = rollbackCause;
      throw error;
    }
    rolledBack = true;
  };
  try {
    if (clock() >= deadline) throw new Error('email_reveal_deadline');
    for (let index = 0; index < result.mutations.length; index += 1) {
      if (index % 64 === 0 && clock() >= deadline) throw new Error('email_reveal_deadline');
      const entry = result.mutations[index];
      undo.push({
        style: entry.element.style,
        property: entry.property,
        value: entry.element.style.getPropertyValue(entry.property),
        priority: entry.element.style.getPropertyPriority(entry.property),
      });
      entry.element.style.setProperty(entry.property, entry.value, 'important');
    }
    if (clock() >= deadline) throw new Error('email_reveal_deadline');
    return () => rollback(new Error('email_appearance_rollback_requested'));
  } catch (cause) {
    rollback(cause);
    throw cause;
  }
}
