export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (/^(javascript|vbscript|data):/i.test(s)) return '#';
  return s;
}

export const isValidColor  = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v);
export const isValidAlign  = (v) => ['left', 'center', 'right', 'justify'].includes(v);
export const isValidLength = (v) => typeof v === 'string' && /^[\d.]+(px|em|rem|%|vh|vw|pt|pc|in|mm|cm|ch|ex)$/.test(v);
