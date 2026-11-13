// A viewport-relative CSS length (`85vh`, `100vh - 8px`) converted into the font-size
// wrapper's layout space (see hooks/useUiScale.js). Viewport units are not scaled by the
// wrapper's transform, so inside it `85vh` renders as 85vh times the scale and a modal capped
// at it runs off the screen at 130% (#777). MailApp sets --ui-scale on the wrapper; anything
// portaled outside it is not scaled and falls back to 1.
export function descaleCss(expr) {
  return `calc((${expr}) / var(--ui-scale, 1))`;
}
