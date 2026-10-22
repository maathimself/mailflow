// Dark email bodies (#228): whether a message's body is shown dark.
//
// The body route sends a sender's own dark design (their @media (prefers-color-scheme: dark) CSS)
// as `darkCss`, apart from the email's HTML, and `lightOnly` when the sender asked to stay light
// (backend emailSanitizer.js splitDarkScheme). The HTML itself is the sanitized email, so replies,
// forwards and print reuse it as it is.
//
// Plain text is drawn by MailFlow itself, in the theme's colors. HTML is shown dark in its frame
// (utils/darkBody.js): with the sender's own dark design when it has one, otherwise recolored, and
// left as sent whenever either would make text unreadable. A sender that asks to stay light
// (color-scheme: only light) is recolored like any other: senders mark every email that way to
// stop Apple Mail's blunt inversion (Intercom's template does), which MailFlow's recoloring, with
// its readability check, is not. Gmail and Outlook darken them too. The reader can still switch
// one back to its original colors.
import { THEMES, resolveEffectiveTheme } from '../themes.js';

// A theme is dark when its background is: several themes besides "light" have light backgrounds
// (catppuccin_latte, parchment, winxp, win9x).
export function isDarkTheme(themeKey) {
  const vars = THEMES[resolveEffectiveTheme(themeKey)]?.vars || THEMES.dark.vars;
  const rgb = /^#([0-9a-f]{6})$/i.exec(String(vars['--bg-primary'] || '').trim());
  if (!rgb) return true;
  const n = Number.parseInt(rgb[1], 16);
  const luminance = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return luminance < 0.5;
}

// Whether this body can be shown dark at all.
export function canShowDark(body) {
  if (!body) return false;
  return Boolean(body.html || body.text);
}

// Whether to show it dark now, in a dark theme and for a body that can be. `override` is this
// message's own choice from its toggle: 'dark', 'original', or undefined. Plain text follows the
// theme unless switched back; HTML follows the "Dark email bodies" setting.
export function showDark({ body, themeKey, setting, override }) {
  if (!isDarkTheme(themeKey) || !canShowDark(body)) return false;
  if (override === 'original') return false;
  if (override === 'dark') return true;
  return body.html ? Boolean(setting) : true;
}
