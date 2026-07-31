import { cssControlText } from './cssControlText.js';

const DEFAULTS = Object.freeze({
  maxSourceChars: 1048576,
  maxNodes: 5000,
  maxAttributeChars: 65536,
  maxSelectorChars: 1024,
  maxNestingDepth: 8,
  maxAuthoredStyleChars: 65536,
  maxAuthoredStyleTotalChars: 1048576,
  maxStyleWork: 250000,
});

const FUNCTIONAL_PSEUDO = /::?[-_a-z0-9]+\s*\(/i;
const TRACKED_PSEUDO = /::?\s*(?:before|after|marker|first-line|first-letter)\b/i;
const SPACE = /\s/;

function isCssNameChar(char) {
  if (!char) return false;
  const code = char.codePointAt(0);
  return code >= 0x80
    || code === 0x2d
    || code === 0x5f
    || (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a);
}

function skipCssTrivia(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (SPACE.test(source[cursor])) {
      cursor += 1;
    } else if (source[cursor] === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2);
      cursor = close < 0 ? source.length : close + 2;
    } else {
      break;
    }
  }
  return cursor;
}

function skipCssFunction(source, open) {
  let depth = 1;
  let cursor = open + 1;
  let quote = '';
  while (cursor < source.length && depth > 0) {
    if (quote) {
      if (source[cursor] === '\\') cursor = skipCssEscape(source, cursor);
      else {
        if (source[cursor] === quote) quote = '';
        cursor += 1;
      }
    } else if (source[cursor] === '"' || source[cursor] === "'") {
      quote = source[cursor];
      cursor += 1;
    } else if (source[cursor] === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2);
      cursor = close < 0 ? source.length : close + 2;
    } else {
      if (source[cursor] === '(') depth += 1;
      else if (source[cursor] === ')') depth -= 1;
      cursor += 1;
    }
  }
  return cursor;
}

function cssFunctionFacts(source) {
  const facts = { attr: false, env: false, vars: [] };
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] === '"' || source[cursor] === "'") {
      const quote = source[cursor++];
      while (cursor < source.length && source[cursor] !== quote) {
        cursor = source[cursor] === '\\' ? skipCssEscape(source, cursor) : cursor + 1;
      }
      if (source[cursor] === quote) cursor += 1;
      continue;
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      cursor = skipCssTrivia(source, cursor);
      continue;
    }
    if (!isCssNameChar(source[cursor])) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (isCssNameChar(source[cursor])) cursor += 1;
    if (source[cursor] !== '(') continue;
    const name = source.slice(start, cursor).toLowerCase();
    if (name === 'url') {
      cursor = skipCssFunction(source, cursor);
      continue;
    }
    if (name !== 'var' && name !== 'attr' && name !== 'env') {
      cursor += 1;
      continue;
    }
    const open = cursor;
    const end = skipCssFunction(source, open);
    if (end > source.length || source[end - 1] !== ')') return { ...facts, invalid: true };
    if (name === 'attr') facts.attr = true;
    else if (name === 'env') facts.env = true;
    else facts.vars.push(source.slice(open + 1, end - 1));
    cursor = end;
  }
  return facts;
}

function hasActiveCssEscape(source) {
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2);
      cursor = close < 0 ? source.length : close + 2;
      continue;
    }
    if (source[cursor] === '"' || source[cursor] === "'") {
      const quote = source[cursor++];
      while (cursor < source.length && source[cursor] !== quote) {
        cursor = source[cursor] === '\\' ? skipCssEscape(source, cursor) : cursor + 1;
      }
      if (source[cursor] === quote) cursor += 1;
      continue;
    }
    if (source[cursor] === '\\') return true;
    if (!isCssNameChar(source[cursor])) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (isCssNameChar(source[cursor])) cursor += 1;
    if (source.slice(start, cursor).toLowerCase() === 'url' && source[cursor] === '(') {
      cursor = skipCssFunction(source, cursor);
    }
  }
  return false;
}

function variableName(argument) {
  let cursor = skipCssTrivia(argument, 0);
  if (argument[cursor] !== '-' || argument[cursor + 1] !== '-') return '';
  const start = cursor;
  cursor += 2;
  const nameStart = cursor;
  while (isCssNameChar(argument[cursor])) cursor += 1;
  if (cursor === nameStart) return '';
  const nameEnd = cursor;
  cursor = skipCssTrivia(argument, cursor);
  return cursor === argument.length ? argument.slice(start, nameEnd) : '';
}

function inspectAuthoredDeclarations(source, inline, variables) {
  const control = cssControlText(source, { preserveBrackets: true, preserveStrings: true });
  let declarationStart = inline;
  for (let cursor = 0; cursor < control.length;) {
    if (control[cursor] === '/' && control[cursor + 1] === '*') {
      cursor = skipCssTrivia(control, cursor);
      continue;
    }
    if (control[cursor] === '{' || control[cursor] === ';' || control[cursor] === '}') {
      declarationStart = true;
      cursor += 1;
      continue;
    }
    if (!declarationStart) {
      cursor += 1;
      continue;
    }
    cursor = skipCssTrivia(control, cursor);
    const propertyStart = cursor;
    while (isCssNameChar(control[cursor])) cursor += 1;
    if (cursor === propertyStart) {
      declarationStart = false;
      cursor += 1;
      continue;
    }
    const property = control.slice(propertyStart, cursor);
    cursor = skipCssTrivia(control, cursor);
    if (control[cursor] !== ':') {
      declarationStart = false;
      continue;
    }
    const valueStart = cursor + 1;
    cursor = valueStart;
    let parentheses = 0;
    let quote = '';
    while (cursor < control.length) {
      if (quote) {
        if (control[cursor] === '\\') cursor = skipCssEscape(control, cursor);
        else {
          if (control[cursor] === quote) quote = '';
          cursor += 1;
        }
        continue;
      }
      if (control[cursor] === '"' || control[cursor] === "'") {
        quote = control[cursor];
        cursor += 1;
      } else if (control[cursor] === '/' && control[cursor + 1] === '*') {
        cursor = skipCssTrivia(control, cursor);
        continue;
      } else if (control[cursor] === '(') parentheses += 1;
      else if (control[cursor] === ')') parentheses = Math.max(0, parentheses - 1);
      else if (!parentheses && (control[cursor] === ';' || control[cursor] === '}' || control[cursor] === '{')) break;
      cursor += 1;
    }
    const value = control.slice(valueStart, cursor);
    const functions = cssFunctionFacts(value);
    if (functions.invalid || functions.attr) return false;
    if (property.startsWith('--')) {
      if (value.length > 256 || /["']/.test(value) || functions.vars.length || functions.env) return false;
      variables.definitions.add(property);
    } else if (functions.vars.length) {
      if (functions.vars.length !== 1) return false;
      const referenced = variableName(functions.vars[0]);
      if (!referenced) return false;
      variables.references.add(referenced);
    }
    declarationStart = false;
  }
  return true;
}

function withoutCssComments(source) {
  let visible = '';
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('/*', cursor);
    if (open < 0) return visible + source.slice(cursor);
    visible += source.slice(cursor, open);
    const close = source.indexOf('*/', open + 2);
    if (close < 0) return visible;
    cursor = close + 2;
  }
  return visible;
}

function isUnconditionalRootPrelude(prelude) {
  const arms = withoutCssComments(prelude).split(',').map(arm => arm.trim()).filter(Boolean);
  return arms.length > 0 && arms.every(arm => /^(?::root|html|body)$/i.test(arm));
}

function cssBlockEnd(source, open) {
  let depth = 1;
  let cursor = open + 1;
  let quote = '';
  while (cursor < source.length && depth > 0) {
    const char = source[cursor];
    if (quote) {
      if (char === '\\') cursor = skipCssEscape(source, cursor);
      else {
        if (char === quote) quote = '';
        cursor += 1;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      cursor += 1;
    } else if (char === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2);
      cursor = close < 0 ? source.length : close + 2;
    } else {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      cursor += 1;
    }
  }
  return depth === 0 ? cursor - 1 : -1;
}

function unconditionalRootDefinitions(source) {
  const control = cssControlText(source, { preserveBrackets: true, preserveStrings: true });
  const definitions = new Set();
  let statementStart = 0;
  for (let cursor = 0, quote = ''; cursor < control.length;) {
    const char = control[cursor];
    if (quote) {
      if (char === '\\') cursor = skipCssEscape(control, cursor);
      else {
        if (char === quote) quote = '';
        cursor += 1;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      cursor += 1;
    } else if (char === '/' && control[cursor + 1] === '*') {
      const close = control.indexOf('*/', cursor + 2);
      cursor = close < 0 ? control.length : close + 2;
    } else if (char === ';') {
      statementStart = cursor + 1;
      cursor += 1;
    } else if (char === '{') {
      const close = cssBlockEnd(control, cursor);
      if (close < 0) break;
      if (isUnconditionalRootPrelude(control.slice(statementStart, cursor))) {
        const rootFacts = { definitions: new Set(), references: new Set() };
        inspectAuthoredDeclarations(control.slice(cursor + 1, close), true, rootFacts);
        for (const definition of rootFacts.definitions) definitions.add(definition);
      }
      cursor = close + 1;
      statementStart = cursor;
    } else {
      cursor += 1;
    }
  }
  return definitions;
}

function skipCssEscape(source, start) {
  let cursor = start + 1;
  let digits = 0;
  while (cursor < source.length && digits < 6 && /[\da-f]/i.test(source[cursor])) {
    cursor += 1;
    digits += 1;
  }
  if (digits && /[\t\n\f\r ]/.test(source[cursor] || '')) cursor += 1;
  else if (!digits && source[cursor]) cursor += 1;
  return cursor;
}

function inspectSelectorPrelude(prelude, limit) {
  if (prelude.length > limit) return { safe: false, arms: 0 };
  let armStart = 0;
  let arms = prelude.trim() ? 1 : 0;
  let parentheses = 0;
  let brackets = 0;
  for (let cursor = 0, quote = ''; cursor < prelude.length;) {
    const char = prelude[cursor];
    if (char === '\\') {
      cursor = skipCssEscape(prelude, cursor);
    } else if (quote) {
      if (char === quote) quote = '';
      cursor += 1;
    } else if (char === '"' || char === "'") {
      quote = char;
      cursor += 1;
    } else if (char === '/' && prelude[cursor + 1] === '*') {
      const close = prelude.indexOf('*/', cursor + 2);
      cursor = close < 0 ? prelude.length : close + 2;
    } else {
      if (char === '(') parentheses += 1;
      else if (char === ')') parentheses = Math.max(0, parentheses - 1);
      else if (char === '[') brackets += 1;
      else if (char === ']') brackets = Math.max(0, brackets - 1);
      else if (char === ',' && !parentheses && !brackets) {
        if (cursor - armStart > limit) return { safe: false, arms: 0 };
        arms += 1;
        armStart = cursor + 1;
      }
      cursor += 1;
    }
  }
  if (prelude.length - armStart > limit) return { safe: false, arms: 0 };
  const control = cssControlText(prelude);
  return { safe: !FUNCTIONAL_PSEUDO.test(control) && !TRACKED_PSEUDO.test(control), arms };
}

function inspectSelectors(source, limit, maxNestingDepth) {
  let statementStart = 0;
  let ruleCount = 0;
  let nestingDepth = 0;
  let parentheses = 0;
  let brackets = 0;
  for (let cursor = 0, quote = ''; cursor < source.length;) {
    const char = source[cursor];
    if (char === '\\') {
      cursor = skipCssEscape(source, cursor);
    } else if (quote) {
      if (char === quote) quote = '';
      cursor += 1;
    } else if (char === '"' || char === "'") {
      quote = char;
      cursor += 1;
    } else if (char === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2);
      cursor = close < 0 ? source.length : close + 2;
    } else {
      if (char === '(') parentheses += 1;
      else if (char === ')') parentheses = Math.max(0, parentheses - 1);
      else if (char === '[') brackets += 1;
      else if (char === ']') brackets = Math.max(0, brackets - 1);
      else if (!parentheses && !brackets && char === '{') {
        const inspected = inspectSelectorPrelude(source.slice(statementStart, cursor), limit);
        if (!inspected.safe) return { safe: false, ruleCount: 0 };
        nestingDepth += 1;
        if (nestingDepth > maxNestingDepth) return { safe: false, ruleCount: 0 };
        ruleCount += inspected.arms;
        statementStart = cursor + 1;
      } else if (!parentheses && !brackets && char === '}') {
        nestingDepth = Math.max(0, nestingDepth - 1);
        statementStart = cursor + 1;
      } else if (!parentheses && !brackets && char === ';') {
        statementStart = cursor + 1;
      }
      cursor += 1;
    }
  }
  return { safe: true, ruleCount };
}

function startsAsciiCaseInsensitive(source, index, token) {
  if (index + token.length > source.length) return false;
  for (let offset = 0; offset < token.length; offset += 1) {
    if (source[index + offset].toLowerCase() !== token[offset]) return false;
  }
  return true;
}

export function preflightEmailStyles(html, overrides = {}) {
  const budget = { ...DEFAULTS, ...overrides };
  const source = String(html || '');
  if (source.length > budget.maxSourceChars) {
    return { status: 'fallback', reason: 'style_complexity_limit' };
  }
  let authoredStyleChars = 0;
  let nodeCount = 0;
  let ruleCount = 0;
  let declined = false;
  const variables = {
    rootDefinitions: new Set(),
    stylesheetReferences: new Set(),
    inlineGroups: [],
  };
  const countStyle = length => {
    if (length > budget.maxAuthoredStyleChars) return false;
    authoredStyleChars += length;
    return authoredStyleChars <= budget.maxAuthoredStyleTotalChars;
  };
  const scanTag = start => {
    let cursor = start + 1;
    const closing = source[cursor] === '/';
    if (closing) cursor += 1;
    while (cursor < source.length && SPACE.test(source[cursor])) cursor += 1;
    const nameStart = cursor;
    while (cursor < source.length && /[\w:-]/.test(source[cursor])) cursor += 1;
    if (cursor === nameStart) return { end: start, closing, style: false };
    const style = startsAsciiCaseInsensitive(source, nameStart, 'style')
      && cursor === nameStart + 5;
    if (!closing) {
      nodeCount += 1;
      if (nodeCount > budget.maxNodes) declined = true;
    }
    while (cursor < source.length) {
      while (cursor < source.length && SPACE.test(source[cursor])) cursor += 1;
      if (source[cursor] === '>') return { end: cursor, closing, style };
      if (source[cursor] === '/') { cursor += 1; continue; }
      const attributeStart = cursor;
      while (cursor < source.length && !/[\s=>]/.test(source[cursor])) cursor += 1;
      const inlineStyle = cursor === attributeStart + 5
        && startsAsciiCaseInsensitive(source, attributeStart, 'style');
      while (cursor < source.length && SPACE.test(source[cursor])) cursor += 1;
      if (source[cursor] !== '=') continue;
      cursor += 1;
      while (cursor < source.length && SPACE.test(source[cursor])) cursor += 1;
      const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor++] : '';
      const valueStart = cursor;
      if (quote) while (cursor < source.length && source[cursor] !== quote) cursor += 1;
      else while (cursor < source.length && !/[\s>]/.test(source[cursor])) cursor += 1;
      const valueLength = cursor - valueStart;
      if (inlineStyle) {
        const inlineVariables = { definitions: new Set(), references: new Set() };
        if (!countStyle(valueLength)
          || hasActiveCssEscape(source.slice(valueStart, cursor))
          || !inspectAuthoredDeclarations(source.slice(valueStart, cursor), true, inlineVariables)) declined = true;
        variables.inlineGroups.push(inlineVariables);
      } else if (valueLength > budget.maxAttributeChars) {
        declined = true;
      }
      if (quote && source[cursor] === quote) cursor += 1;
    }
    return { end: source.length, closing, style };
  };

  for (let cursor = 0; cursor < source.length && !declined;) {
    const open = source.indexOf('<', cursor);
    if (open < 0) break;
    const tag = scanTag(open);
    if (tag.end === open) { cursor = open + 1; continue; }
    cursor = tag.end + 1;
    if (tag.closing || !tag.style) continue;
    const cssStart = cursor;
    let close = -1;
    while (cursor < source.length) {
      const candidate = source.indexOf('<', cursor);
      if (candidate < 0) break;
      if (startsAsciiCaseInsensitive(source, candidate, '</style')
        && /[\s>]/.test(source[candidate + 7] || '>')) {
        close = candidate;
        break;
      }
      cursor = candidate + 1;
    }
    const cssEnd = close < 0 ? source.length : close;
    if (!countStyle(cssEnd - cssStart)) { declined = true; break; }
    const css = source.slice(cssStart, cssEnd);
    const selectors = inspectSelectors(css, budget.maxSelectorChars, budget.maxNestingDepth);
    const stylesheetVariables = { definitions: new Set(), references: new Set() };
    if (hasActiveCssEscape(css)
      || !selectors.safe
      || !inspectAuthoredDeclarations(css, false, stylesheetVariables)) {
      declined = true;
      break;
    }
    for (const reference of stylesheetVariables.references) variables.stylesheetReferences.add(reference);
    for (const definition of unconditionalRootDefinitions(css)) variables.rootDefinitions.add(definition);
    ruleCount += selectors.ruleCount;
    if (close < 0) break;
    const closingTag = scanTag(close);
    cursor = Math.max(close + 1, closingTag.end + 1);
  }

  const styleWork = nodeCount * ruleCount;
  const unresolvedVariable = [...variables.stylesheetReferences]
    .some(reference => !variables.rootDefinitions.has(reference))
    || variables.inlineGroups.some(group => [...group.references].some(reference => (
      !group.definitions.has(reference) && !variables.rootDefinitions.has(reference)
    )));
  if (declined || unresolvedVariable || styleWork > budget.maxStyleWork) {
    return { status: 'fallback', reason: 'style_complexity_limit' };
  }
  return { status: 'ready', nodeCount, ruleCount, styleWork, authoredStyleChars };
}
