// Copying text, in a way that works on a self-hosted install.
//
// navigator.clipboard only exists in a SECURE CONTEXT: https, or localhost/127.0.0.1.
// Reached over plain http on a LAN address or a Tailscale 100.x address, the whole
// clipboard object is undefined, so `navigator.clipboard.writeText(...)` throws
// "Cannot read properties of undefined (reading 'writeText')" and the button does
// nothing (#416). Tailscale's CGNAT range is not a trustworthy origin: only loopback
// gets that exemption. The bundled Caddy service is Let's Encrypt only and needs a
// public domain with ports 80/443 open, so a secure context is not something every
// self-hoster can reach. The app has to work without one.
//
// Feature-detecting rather than sniffing the protocol also means this holds up if the
// API is missing for some other reason, such as a disabled browser pref.

// Legacy synchronous copy. Deprecated, but it still works in non-secure contexts in
// every current browser, and removing it would break a large part of the web. Kept as
// tier 2 rather than tier 1 so we use the modern API wherever it is actually available.
function execCommandCopy(value) {
  const doc = globalThis.document;
  if (!doc?.body || typeof doc.execCommand !== 'function') return false;

  const el = doc.createElement('textarea');
  el.value = value;
  el.setAttribute('readonly', '');
  // Positioned off-screen rather than display:none or hidden, because a non-rendered
  // element cannot hold a selection and the copy would silently do nothing.
  el.style.position = 'fixed';
  el.style.top = '0';
  el.style.left = '-9999px';
  el.style.opacity = '0';
  doc.body.appendChild(el);

  const previouslyFocused = doc.activeElement;
  try {
    // Focus explicitly. execCommand('copy') acts on the focused element, and select()
    // alone does not reliably move focus, so without this the copy can target whatever
    // the user had focused instead of the scratch field.
    el.focus();
    if (/ipad|iphone|ipod/i.test(globalThis.navigator?.userAgent || '')) {
      // iOS Safari ignores textarea.select() on a readonly field. It needs a real
      // range over editable content plus an explicit selection range.
      el.contentEditable = 'true';
      el.readOnly = false;
      const range = doc.createRange();
      range.selectNodeContents(el);
      const selection = globalThis.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(range);
      el.setSelectionRange?.(0, value.length);
    } else {
      el.select();
    }
    return doc.execCommand('copy') === true;
  } finally {
    el.remove();
    // Copying should not steal focus from whatever the user was working in.
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try { previouslyFocused.focus(); } catch { /* element went away */ }
    }
  }
}

/**
 * Copy `text`, trying the modern API first and falling back to the legacy one.
 *
 * Returns { ok, method }. Callers MUST act on `ok`: the original bug was not only that
 * copying failed but that every call site assumed it could not, so the button gave no
 * feedback at all. `method` is 'async' or 'execCommand' on success, null on failure.
 */
export async function copyToClipboard(text) {
  const value = text == null ? '' : String(text);

  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value);
      return { ok: true, method: 'async' };
    }
  } catch {
    // Permission denied, document not focused, or a rejected write. Try the legacy path
    // rather than giving up: it succeeds in several cases where the async API refuses.
  }

  try {
    if (execCommandCopy(value)) return { ok: true, method: 'execCommand' };
  } catch { /* fall through to the failure result */ }

  return { ok: false, method: null };
}

/**
 * Select an element's text so the user can copy it by hand.
 *
 * The last resort when both copy paths fail. Leaves the value selected on screen and
 * lets the caller tell the user to press the copy shortcut, which degrades to one extra
 * keystroke instead of a dead button. Returns whether a selection was made.
 */
export function selectElementText(el) {
  const doc = el?.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || !win || typeof doc.createRange !== 'function') return false;
  try {
    const range = doc.createRange();
    range.selectNodeContents(el);
    const selection = win.getSelection?.();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}
