import postcss from 'postcss';
import DOMPurify from 'dompurify';

// At-rules stripped entirely before scoping. @import/@charset are semantically
// wrong inside an inlined style block. @font-face and @keyframes are injected
// into the global document.head by emailStyleRegistry, so keeping them would let
// an email silently redefine app-level fonts (DM Sans) or animations (spin, etc.)
// while the message is open.
const REMOVE_ATRULES = new Set([
  'charset', 'import', 'font-face', 'keyframes', '-webkit-keyframes',
]);

// Strips the leading browser-context selector token(s) from an email CSS selector.
// Handles whitespace-separated (html body) and combinator-separated (html > body)
// forms so the full prefix is removed in one pass.
const LEADING_BODY_RE = /^(?:html(?:[\s>+~]+(?:body|:root))?|body|:root)(?=[\s>+~]|$)/i;

export function scopeEmailCss(cssText, prefix) {
  let root;
  try { root = postcss.parse(cssText); } catch { return ''; }

  // Pass 1 — remove unsafe at-rules.
  // walkAtRules never returns false so the full tree is always visited.
  // PostCSS is mutation-safe during traversal: removing a node (and its subtree)
  // does not skip or re-process adjacent siblings.
  root.walkAtRules(atRule => {
    if (REMOVE_ATRULES.has(atRule.name.toLowerCase())) atRule.remove();
  });

  // Pass 2 — scope every remaining rule.
  // walkRules recurses through @media / @supports / @layer automatically.
  // Keyframe selectors (from, to, 0%) are gone after pass 1, so no special
  // parent-check is needed here.
  root.walkRules(rule => {
    rule.selectors = rule.selectors.map(sel => {
      let t = sel.trim();
      if (t.startsWith(`.${prefix}`)) return t; // avoid double-prefix
      if (LEADING_BODY_RE.test(t)) t = t.replace(LEADING_BODY_RE, '').trimStart();
      if (!t) return `.${prefix}`;
      return `.${prefix} ${t}`;
    });
  });

  return root.toResult().css;
}

export function prepareEmailHtml(rawHtml, uid) {
  const prefix = `email-${uid}`;
  const styleBlocks = [];

  const stripped = rawHtml.replace(
    /<style[^>]*>([\s\S]*?)<\/style>/gi,
    (_, css) => {
      const scoped = scopeEmailCss(css, prefix);
      if (scoped) styleBlocks.push(scoped);
      return '';
    }
  );

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
