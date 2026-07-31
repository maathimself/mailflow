export function handleEmailBodyLinkClick(event, openWindow = window.open.bind(window)) {
  const anchor = event.target.closest?.('a[href]');
  if (!anchor) return false;
  event.preventDefault();
  let raw = anchor.getAttribute('href') || '';
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!/^https?:\/\//i.test(raw) && !/^mailto:/i.test(raw)) return false;
  openWindow(raw, '_blank', 'noopener,noreferrer');
  return true;
}

export function attachEmailBodyLinkHandler(root, openWindow) {
  const handler = event => handleEmailBodyLinkClick(event, openWindow);
  root.addEventListener('click', handler);
  return () => root.removeEventListener('click', handler);
}

export function createEmailScrollExpander(root) {
  const expanded = new Set();
  return () => {
    if (!root) return;
    const view = root.nodeType === 9 ? root.defaultView : root.ownerDocument?.defaultView;
    if (!view) return;
    [...root.querySelectorAll('*')].reverse().forEach(element => {
      const overflowY = view.getComputedStyle(element).overflowY;
      const scrolls = (overflowY === 'auto' || overflowY === 'scroll')
        && element.scrollHeight > element.clientHeight + 2;
      const grew = expanded.has(element) && element.scrollHeight > element.clientHeight + 2;
      if (!scrolls && !grew) return;
      expanded.add(element);
      element.style.setProperty('overflow-y', 'hidden', 'important');
      element.style.setProperty('max-height', 'none', 'important');
      element.style.setProperty('height', `${element.scrollHeight}px`, 'important');
    });
  };
}

export function applyEmailDivGeometry({ inner, outer, scaler, expandScrollContainers }) {
  if (!inner || !outer || !scaler) return null;
  scaler.style.transform = '';
  scaler.style.transformOrigin = '';
  scaler.style.width = '';
  outer.style.height = '';
  outer.style.overflowX = '';
  outer.style.overflowY = '';
  expandScrollContainers?.();

  const viewportWidth = outer.clientWidth;
  const naturalWidth = inner.scrollWidth;
  const naturalHeight = inner.scrollHeight;
  const scale = viewportWidth > 0 && naturalWidth > viewportWidth + 2
    ? viewportWidth / naturalWidth
    : 1;
  if (scale < 1) {
    scaler.style.width = `${naturalWidth}px`;
    scaler.style.transform = `scale(${scale})`;
    scaler.style.transformOrigin = 'top left';
    outer.style.height = `${Math.round(naturalHeight * scale)}px`;
    outer.style.overflowX = 'hidden';
    outer.style.overflowY = 'hidden';
  }
  return { scale, viewportWidth, naturalWidth, naturalHeight };
}

export function applyEmailIframeGeometry({ document: frameDocument, iframe, expandScrollContainers }) {
  const body = frameDocument?.body;
  const root = frameDocument?.documentElement;
  if (!body || !root || !iframe) return null;
  for (const element of [body, root]) {
    element.style.setProperty('height', 'auto', 'important');
    element.style.setProperty('min-height', '0', 'important');
    element.style.setProperty('overflow-y', 'hidden', 'important');
  }
  const viewportWidth = iframe.offsetWidth || iframe.clientWidth;
  body.style.setProperty('overflow-x', 'visible', 'important');
  root.style.setProperty('overflow-x', 'visible', 'important');
  const naturalWidth = Math.max(root.scrollWidth, body.scrollWidth);
  body.style.removeProperty('overflow-x');
  root.style.removeProperty('overflow-x');
  const scale = viewportWidth > 0 && naturalWidth > viewportWidth + 2
    ? viewportWidth / naturalWidth
    : 1;
  const wrapper = frameDocument.getElementById('mf-scale-wrapper');
  if (wrapper && scale < 1) {
    wrapper.style.transform = `scale(${scale})`;
    wrapper.style.transformOrigin = 'top left';
    wrapper.style.width = `${naturalWidth}px`;
  }
  expandScrollContainers?.();
  return {
    scale,
    viewportWidth,
    naturalWidth,
    naturalHeight: Math.max(root.scrollHeight, body.scrollHeight),
  };
}
