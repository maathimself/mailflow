import postcss from 'postcss';
import DOMPurify from 'dompurify';
import { stripOpeningTagStyleAttributes } from './htmlStyleSafety.js';

// Only grouping rules whose children can be selector-scoped belong in the div
// renderer. Every other at-rule is removed: registrations and ordering rules
// have document-global semantics even when their nested selectors are scoped.
const LOCAL_GROUPING_ATRULES = new Set(['media', 'supports']);

// Strips the leading browser-context selector token(s) from an email CSS selector.
// Handles whitespace-separated (html body) and combinator-separated (html > body)
// forms so the full prefix is removed in one pass.
const LEADING_BODY_RE = /^(?:html(?:[\s>+~]+(?:body|:root))?|body|:root)(?=[\s>+~]|$)/i;
const OUTLOOK_ROOT_RE = /^(?:\[(data-ogsc|data-ogsb)\]|(?:html|:root)\[(data-ogsc|data-ogsb)\](?:[\s>+~]+body)?|(?:html[\s>+~]+)?body\[(data-ogsc|data-ogsb)\])(?=$|[\s>+~.#:]|\[)/i;

function scopeSelector(selector, prefix) {
  let text = selector.trim();
  const outlook = text.match(OUTLOOK_ROOT_RE);
  if (outlook) {
    text = text.slice(outlook[0].length);
    const attribute = outlook.slice(1).find(Boolean).toLowerCase();
    return `.${prefix}[${attribute}]${text}`;
  }
  if (text.startsWith(`.${prefix}`)) return text;
  if (LEADING_BODY_RE.test(text)) text = text.replace(LEADING_BODY_RE, '').trimStart();
  return text ? `.${prefix} ${text}` : `.${prefix}`;
}

export function scopeEmailCss(cssText, prefix) {
  let root;
  try { root = postcss.parse(cssText); } catch { return ''; }

  // Pass 1 — keep only renderer-local grouping at-rules.
  // walkAtRules never returns false so the full tree is always visited.
  // PostCSS is mutation-safe during traversal: removing a node (and its subtree)
  // does not skip or re-process adjacent siblings.
  root.walkAtRules(atRule => {
    if (!LOCAL_GROUPING_ATRULES.has(atRule.name.toLowerCase()) || !atRule.nodes) atRule.remove();
  });

  // Pass 2 — scope every remaining rule.
  // walkRules recurses through @media / @supports automatically.
  // Keyframe selectors (from, to, 0%) are gone after pass 1, so no special
  // parent-check is needed here.
  root.walkRules(rule => {
    if (rule.selector.includes(',,')) {
      rule.remove();
      return;
    }
    rule.selectors = rule.selectors.map(sel => scopeSelector(sel, prefix));
  });

  return root.toResult().css;
}

export function prepareEmailHtml(rawHtml, uid, { recovery = false } = {}) {
  const prefix = `email-${uid}`;
  const styleBlocks = [];

  let stripped = rawHtml.replace(
    /<style[^>]*>([\s\S]*?)<\/style>/gi,
    (_, css) => {
      const scoped = recovery ? '' : scopeEmailCss(css, prefix);
      if (scoped) styleBlocks.push(scoped);
      return '';
    }
  );
  if (recovery) {
    stripped = stripOpeningTagStyleAttributes(stripped);
  }

  // Base normalize injected AFTER email CSS so our rules win the source-order
  // tiebreak for same-specificity declarations. The !important posture on
  // dangerous layout properties prevents hostile email body CSS (position, transform,
  // margin, width) from repositioning or overflowing the inner root div.
  // transform:none is safe here because the scale-to-fit effect targets a separate
  // scaleRef wrapper that does not carry the .email-* class.
  styleBlocks.push(`
    .${prefix} {
      position: static !important;
      top: auto !important;
      right: auto !important;
      bottom: auto !important;
      left: auto !important;
      z-index: auto !important;
      transform: none !important;
      width: auto !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      overflow: visible !important;
      float: none !important;
      margin: 0 !important;
      padding: 0;
      background-color: #ffffff;
      color-scheme: light;
      font-family: -apple-system, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #1a1a1a;
      overflow-wrap: break-word;
    }
    .${prefix} img { max-width: 100% !important; height: auto !important; }
    .${prefix} > table, .${prefix} > center > table,
    .${prefix} > div > table, .${prefix} > center > div > table { width: 100% !important; }
    .${prefix} td, .${prefix} th { min-width: 0 !important; }
    .${prefix} th { overflow-wrap: normal; word-break: normal; }
    .${prefix} td { word-break: break-word; }
    .${prefix} a { color: #6366f1; }
    .${prefix} pre, .${prefix} code { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
    .${prefix} blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
    .${prefix}, .${prefix} *, .${prefix}::before, .${prefix}::after,
    .${prefix} *::before, .${prefix} *::after {
      animation: none !important;
      transition: none !important;
    }
  `);

  // Mirror the iframe's rel="noopener noreferrer" injection on all links.
  const withRel = stripped.replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1');

  // Defense in depth: the div renderer injects this HTML into the app origin with
  // no iframe/CSP isolation, so sanitize on the client too. The server sanitizer is
  // the primary gate; this second pass neutralizes any sanitizer bypass / mutation
  // XSS or a legacy row stored before server sanitization existed.
  const safe = DOMPurify.sanitize(withRel, { ADD_ATTR: ['target'], FORBID_TAGS: ['style'] });

  return { prefix, styleBlocks, html: safe };
}
