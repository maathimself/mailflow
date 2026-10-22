// Keyboard shortcuts after clicking into an email, where the frame cannot pass keys on (#537).
//
// MessageBodyView forwards key presses from the email frame to the page with a listener inside the
// frame. WebKit (Safari, and every browser on iOS) runs no listener inside a sandboxed frame
// without scripts, not even one the page registered, so in Safari a click on the email kept every
// shortcut (j, k, r, e, ...) dead until the reader clicked outside it. Giving the frame scripts
// would undo its strongest protection against a malicious email, so the page works around it from
// its own side instead: it sees focus enter the frame (its own window loses focus), and unless the
// reader is selecting text, it gives focus back to the page, where the shortcuts listen.
//
// Left alone: a selection in the email (Copy works natively while focus stays there; focus
// returns once the selection is cleared) and focus that arrived by Tab (keyboard navigation of the
// email's links). Right-clicking the email shows Safari's own menu for the same reason, and that
// one cannot be changed from outside: MailFlow's menu still opens anywhere around the email.

let listenersRun = null;

// Whether listeners the page adds inside a sandboxed email frame run in this browser: an event
// dispatched in the frame's document, heard or not. One answer per browser, kept after the first.
export function frameListenersRun(doc) {
  if (listenersRun !== null || !doc?.defaultView) return listenersRun ?? true;
  let heard = false;
  const probe = () => { heard = true; };
  try {
    doc.addEventListener('mailflow-listener-probe', probe);
    doc.dispatchEvent(new doc.defaultView.Event('mailflow-listener-probe'));
    doc.removeEventListener('mailflow-listener-probe', probe);
  } catch { /* treat as not running */ }
  listenersRun = heard;
  return heard;
}

export const RETURN_AFTER_MS = 250; // a click, not the start of a selection
export const RECHECK_MS = 150; // while a selection is kept
const TAB_GRACE_MS = 600;

function hasSelection(iframe) {
  try {
    const sel = iframe.contentDocument?.getSelection?.();
    return Boolean(sel && !sel.isCollapsed && String(sel).trim());
  } catch {
    return false;
  }
}

// Somewhere in the page to put focus when what had it is gone: invisible, out of the tab order.
function focusSink(doc) {
  let sink = doc.getElementById('mf-focus-sink');
  if (!sink) {
    sink = doc.createElement('div');
    sink.id = 'mf-focus-sink';
    sink.tabIndex = -1;
    sink.setAttribute('aria-hidden', 'true');
    sink.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;outline:none';
    doc.body.appendChild(sink);
  }
  return sink;
}

// Gives focus back to the page when it goes into `iframe` without a selection being made there:
// to what had it before (the message list, whose arrow keys then keep working), or else to an
// invisible spot in the page. Blurring the frame is not enough: WebKit keeps focus in it.
// Returns the cleanup.
// The email frames being watched, each with the call that starts its return. Focus that moves from
// one email straight into another (two open cards in a conversation) blurs the page's window only
// once, for the first, so the frame it lands in hears nothing; the first one's watcher hands over.
const watchers = new Map();

export function returnFocusFromFrame(iframe) {
  const doc = iframe.ownerDocument;
  const win = doc.defaultView;
  let timer = null;
  let lastTab = 0;
  // What had focus in the page before the email took it: what has it now, then whatever focus
  // moves to or leaves (a click on the email takes it from the list, as a focusout says).
  // Never a text field: given back to the search box or the composer, the next shortcut key would be
  // typed there instead, the very thing this is for. The list, or the invisible spot, takes it.
  const editable = (el) => el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const inPage = (el) => el && el !== iframe && el !== doc.body && el.tagName !== 'IFRAME' && !editable(el);
  let lastFocused = inPage(doc.activeElement) ? doc.activeElement : null;
  const onFocusIn = (e) => { if (inPage(e.target)) lastFocused = e.target; };
  const onKeyDown = (e) => { if (e.key === 'Tab') lastTab = Date.now(); };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(check, RETURN_AFTER_MS);
  };
  const check = () => {
    timer = null;
    if (doc.activeElement !== iframe) {
      // Focus has left the email: for the page, or for another email, whose watcher takes over.
      watchers.get(doc.activeElement)?.();
      return;
    }
    if (hasSelection(iframe)) { timer = setTimeout(check, RECHECK_MS); return; }
    if (lastFocused?.isConnected) lastFocused.focus({ preventScroll: true });
    if (doc.activeElement === iframe) focusSink(doc).focus({ preventScroll: true });
  };
  const onBlur = () => {
    // The page's window lost focus. Into this email? activeElement says so once the move is done.
    setTimeout(() => {
      if (doc.activeElement !== iframe || Date.now() - lastTab < TAB_GRACE_MS) return;
      arm();
    }, 0);
  };
  watchers.set(iframe, arm);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusIn, true);
  return () => {
    clearTimeout(timer);
    if (watchers.get(iframe) === arm) watchers.delete(iframe);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusIn, true);
  };
}
