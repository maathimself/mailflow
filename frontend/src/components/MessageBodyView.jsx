import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { useMobile } from '../hooks/useMobile.js';
import { fetchMessageBodyWithRetry } from '../utils/messageBody.js';

const USE_DIV_RENDER = import.meta.env.VITE_EMAIL_DIV_RENDER === 'true';

let prepareEmailHtml = null;
let injectEmailStyles = null;
let removeEmailStyles = null;
if (USE_DIV_RENDER) {
  ({ prepareEmailHtml } = await import('../utils/scopeEmailCss.js'));
  ({ injectEmailStyles, removeEmailStyles } = await import('../utils/emailStyleRegistry.js'));
}

const BODY_CACHE_LIMIT = 50;
const bodyCache = new Map();
const bodyCacheOrder = [];
const imagesRequested = new Set();

function cacheBody(messageId, body) {
  if (!body?.html && !body?.text) return;
  bodyCache.set(messageId, body);
  const previousIndex = bodyCacheOrder.indexOf(messageId);
  if (previousIndex >= 0) bodyCacheOrder.splice(previousIndex, 1);
  bodyCacheOrder.push(messageId);
  while (bodyCacheOrder.length > BODY_CACHE_LIMIT) {
    bodyCache.delete(bodyCacheOrder.shift());
  }
}

function evictBody(messageId) {
  bodyCache.delete(messageId);
  const index = bodyCacheOrder.indexOf(messageId);
  if (index >= 0) bodyCacheOrder.splice(index, 1);
}

function evictBodies(predicate, clearImageRequests = false) {
  for (const [id, body] of bodyCache) {
    if (!predicate(body)) continue;
    bodyCache.delete(id);
    if (clearImageRequests) imagesRequested.delete(id);
  }
  for (let index = bodyCacheOrder.length - 1; index >= 0; index -= 1) {
    if (!bodyCache.has(bodyCacheOrder[index])) bodyCacheOrder.splice(index, 1);
  }
}

function linkifyText(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(
    /https?:\/\/[^\s<>"']+/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:inherit">${url}</a>`,
  );
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ type }) {
  const normalized = (type || '').toLowerCase();
  const props = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75 };
  if (normalized.startsWith('image/')) return <svg {...props}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>;
  if (normalized === 'application/pdf' || normalized.includes('word') || normalized.includes('document')) return <svg {...props}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>;
  if (normalized.includes('sheet') || normalized.includes('excel') || normalized.includes('csv')) return <svg {...props}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="10" y1="13" x2="10" y2="17"/><line x1="8" y1="15" x2="12" y2="15"/></svg>;
  if (normalized.includes('zip') || normalized.includes('compressed') || normalized.includes('archive')) return <svg {...props}><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="11" x2="16" y2="11"/></svg>;
  if (normalized.startsWith('video/')) return <svg {...props}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>;
  if (normalized.startsWith('audio/')) return <svg {...props}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>;
  return <svg {...props}><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>;
}

export default function MessageBodyView({ message, eager = true, onBodyLoaded, beforeContent = null, banner = null, inset = true, framed = true }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const { imageWhitelist, addToImageWhitelist, blockRemoteImages, addNotification } = useStore();
  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [downloadingPart, setDownloadingPart] = useState(null);
  const [savingAllow, setSavingAllow] = useState(false);
  const iframeRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const emailScaleRef = useRef(1);
  const outerRef = useRef(null);
  const scaleRef = useRef(null);
  const innerRef = useRef(null);
  const previousBlockingPolicyRef = useRef(null);

  const messageId = message?.id;
  const prepared = useMemo(() => {
    if (!USE_DIV_RENDER || !body?.html) return null;
    return prepareEmailHtml(body.html, String(messageId ?? 'preview'));
  }, [body?.html, messageId]);

  useEffect(() => {
    onBodyLoaded?.(body);
  }, [body, onBodyLoaded]);

  useEffect(() => {
    const previous = previousBlockingPolicyRef.current;
    const current = {
      blockRemoteImages,
      addressCount: (imageWhitelist?.addresses || []).length,
      domainCount: (imageWhitelist?.domains || []).length,
    };
    previousBlockingPolicyRef.current = current;
    if (!previous) return;

    const tightened = (!previous.blockRemoteImages && current.blockRemoteImages)
      || previous.addressCount > current.addressCount
      || previous.domainCount > current.domainCount;
    const loosened = (previous.blockRemoteImages && !current.blockRemoteImages)
      || (!tightened && (current.addressCount > previous.addressCount || current.domainCount > previous.domainCount));

    if (tightened) evictBodies(cached => !cached?.hasBlockedRemoteImages, true);
    if (loosened) evictBodies(cached => cached?.hasBlockedRemoteImages);
    if (tightened || loosened) setRetryKey(key => key + 1);
  }, [blockRemoteImages, imageWhitelist]);

  useLayoutEffect(() => {
    if (!messageId) {
      setBody(null);
      setBodyError(null);
      setLoadingBody(false);
      return;
    }

    const wantsImages = imagesRequested.has(messageId);
    const cached = bodyCache.get(messageId);
    if (cached && (!wantsImages || !cached.hasBlockedRemoteImages)) {
      setBody(cached);
      setBodyError(null);
      setLoadingBody(false);
      return;
    }
    if (!eager) {
      setBody(null);
      setBodyError(null);
      setLoadingBody(false);
      return;
    }
    if (cached) evictBody(messageId);

    let cancelled = false;
    setBody(null);
    setBodyError(null);
    setLoadingBody(true);

    fetchMessageBodyWithRetry(messageId, {
      load: api.getMessageBody,
      remoteImages: wantsImages,
      isCancelled: () => cancelled,
    })
      .then(data => {
        if (cancelled) return;
        cacheBody(messageId, data);
        setBody(data);
      })
      .catch(error => {
        if (!cancelled) setBodyError(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingBody(false);
      });

    return () => { cancelled = true; };
  }, [eager, messageId, retryKey]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !body?.html) return;
    let animationFrame;
    let lastHeight = 0;

    const setHeight = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const html = doc.documentElement;
      const emailBody = doc.body;
      const height = Math.max(
        html?.scrollHeight || 0,
        html?.offsetHeight || 0,
        emailBody?.scrollHeight || 0,
        emailBody?.offsetHeight || 0,
      );
      const scaledHeight = Math.round(height * emailScaleRef.current);
      if (scaledHeight > lastHeight) {
        lastHeight = scaledHeight;
        iframe.style.height = `${scaledHeight}px`;
      }
    };

    const onLoaded = () => {
      emailScaleRef.current = 1;
      const doc = iframe.contentDocument;
      if (!doc) return;
      const emailBody = doc.body;
      const html = doc.documentElement;
      for (const element of [emailBody, html]) {
        if (!element) continue;
        element.style.setProperty('height', 'auto', 'important');
        element.style.setProperty('min-height', '0', 'important');
        element.style.setProperty('overflow-y', 'hidden', 'important');
      }

      const iframeWidth = iframe.offsetWidth;
      if (iframeWidth > 0) {
        emailBody?.style.setProperty('overflow-x', 'visible', 'important');
        html?.style.setProperty('overflow-x', 'visible', 'important');
        const contentWidth = Math.max(html?.scrollWidth || 0, emailBody?.scrollWidth || 0);
        emailBody?.style.removeProperty('overflow-x');
        html?.style.removeProperty('overflow-x');
        const wrapper = doc.getElementById('mf-scale-wrapper');
        if (contentWidth > iframeWidth + 2 && wrapper) {
          const scale = iframeWidth / contentWidth;
          emailScaleRef.current = scale;
          wrapper.style.transform = `scale(${scale})`;
          wrapper.style.transformOrigin = 'top left';
          wrapper.style.width = `${contentWidth}px`;
        }
      }

      const expandedElements = new Set();
      const view = doc.defaultView;
      const expandScrollContainers = () => {
        if (!view) return;
        Array.from(doc.querySelectorAll('*')).reverse().forEach(element => {
          const overflowY = view.getComputedStyle(element).overflowY;
          const isScrollable = (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 2;
          const grew = expandedElements.has(element) && element.scrollHeight > element.clientHeight + 2;
          if (!isScrollable && !grew) return;
          expandedElements.add(element);
          element.style.setProperty('overflow-y', 'hidden', 'important');
          element.style.setProperty('max-height', 'none', 'important');
          element.style.setProperty('height', `${element.scrollHeight}px`, 'important');
        });
      };

      expandScrollContainers();
      lastHeight = 0;
      setHeight();
      animationFrame = requestAnimationFrame(setHeight);
      doc.addEventListener('click', event => {
        const anchor = event.target.closest('a[href]');
        if (!anchor) return;
        event.preventDefault();
        let href = anchor.getAttribute('href') || '';
        if (href.startsWith('//')) href = `https:${href}`;
        if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
      });
      doc.querySelectorAll('img').forEach(image => {
        if (image.complete) return;
        image.addEventListener('load', () => { expandScrollContainers(); requestAnimationFrame(setHeight); }, { once: true });
        image.addEventListener('error', () => requestAnimationFrame(setHeight), { once: true });
      });
      const root = doc.body || doc.documentElement;
      if (window.ResizeObserver && root) {
        resizeObserverRef.current = new ResizeObserver(() => requestAnimationFrame(setHeight));
        resizeObserverRef.current.observe(root);
      }
    };

    iframe.addEventListener('load', onLoaded, { once: true });
    if (iframe.contentDocument?.readyState === 'complete') onLoaded();
    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      iframe.removeEventListener('load', onLoaded);
      emailScaleRef.current = 1;
    };
  }, [body?.html, messageId]);

  useLayoutEffect(() => {
    if (!prepared) return;
    injectEmailStyles(prepared.prefix, prepared.styleBlocks);
    return () => removeEmailStyles(prepared.prefix);
  }, [prepared]);

  useEffect(() => {
    if (!USE_DIV_RENDER || !prepared) return;
    let animationFrame = null;
    const expandedElements = new Set();
    const expandScrollContainers = root => {
      if (!root) return;
      Array.from(root.querySelectorAll('*')).reverse().forEach(element => {
        const overflowY = window.getComputedStyle(element).overflowY;
        const isScrollable = (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 2;
        const grew = expandedElements.has(element) && element.scrollHeight > element.clientHeight + 2;
        if (!isScrollable && !grew) return;
        expandedElements.add(element);
        element.style.setProperty('overflow-y', 'hidden', 'important');
        element.style.setProperty('max-height', 'none', 'important');
        element.style.setProperty('height', `${element.scrollHeight}px`, 'important');
      });
    };
    const applyScale = () => {
      const inner = innerRef.current;
      const outer = outerRef.current;
      const scaler = scaleRef.current;
      if (!inner || !outer || !scaler) return;
      scaler.style.transform = '';
      scaler.style.transformOrigin = '';
      scaler.style.width = '';
      outer.style.height = '';
      outer.style.overflowX = '';
      outer.style.overflowY = '';
      expandScrollContainers(inner);
      const containerWidth = outer.clientWidth;
      const contentWidth = inner.scrollWidth;
      if (containerWidth > 0 && contentWidth > containerWidth + 2) {
        const scale = containerWidth / contentWidth;
        scaler.style.width = `${contentWidth}px`;
        scaler.style.transform = `scale(${scale})`;
        scaler.style.transformOrigin = 'top left';
        outer.style.height = `${Math.round(inner.scrollHeight * scale)}px`;
        outer.style.overflowX = 'hidden';
        outer.style.overflowY = 'hidden';
      }
    };
    const scheduleScale = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => { animationFrame = null; applyScale(); });
    };
    const imageListeners = [];
    innerRef.current?.querySelectorAll('img').forEach(image => {
      if (image.complete) return;
      const handler = () => scheduleScale();
      image.addEventListener('load', handler, { once: true });
      imageListeners.push({ image, handler });
    });
    let observer;
    if (window.ResizeObserver && innerRef.current) {
      observer = new ResizeObserver(scheduleScale);
      observer.observe(innerRef.current);
    }
    scheduleScale();
    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      imageListeners.forEach(({ image, handler }) => image.removeEventListener('load', handler));
    };
  }, [prepared]);

  const retry = () => {
    if (messageId) evictBody(messageId);
    setRetryKey(key => key + 1);
  };

  const loadImages = () => {
    imagesRequested.add(messageId);
    retry();
  };

  const allowRemoteImages = async (type, value) => {
    if (!value) return;
    setSavingAllow(true);
    try {
      await addToImageWhitelist({ type, value });
      evictBodies(cached => cached?.hasBlockedRemoteImages);
      setRetryKey(key => key + 1);
    } catch {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSavingAllow(false);
    }
  };

  const downloadAttachment = async attachment => {
    setDownloadingPart(attachment.part);
    try {
      const response = await fetch(`/api/mail/messages/${messageId}/attachments/${encodeURIComponent(attachment.part)}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Download failed');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = attachment.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download error:', error);
    } finally {
      setDownloadingPart(null);
    }
  };

  const handleEmailClick = event => {
    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    event.preventDefault();
    let href = anchor.getAttribute('href') || '';
    if (href.startsWith('//')) href = `https:${href}`;
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
  };

  const attachments = body?.attachments || [];
  const senderEmail = message?.from_email?.toLowerCase() || '';
  const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';
  const horizontalPadding = inset && !isMobile ? '0 28px 24px' : '0 0 16px';

  return (
    <>
      {attachments.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('message.attachment', { count: attachments.length })}</div>
            {attachments.length > 1 && <a href={`/api/mail/messages/${messageId}/attachments.zip`} download style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}><span aria-hidden="true">↓</span>{t('message.downloadAll')}</a>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {attachments.map((attachment, index) => (
              <button key={`${attachment.part}-${index}`} onClick={() => downloadAttachment(attachment)} disabled={downloadingPart === attachment.part} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', cursor: downloadingPart === attachment.part ? 'wait' : 'pointer', color: 'var(--text-primary)', maxWidth: 240 }}>
                <span style={{ display: 'flex', flexShrink: 0, color: 'var(--text-secondary)' }}><FileIcon type={attachment.type}/></span>
                <span style={{ minWidth: 0, textAlign: 'left' }}><span style={{ display: 'block', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.filename}</span><span style={{ display: 'block', fontSize: 10, color: 'var(--text-tertiary)', marginTop: 1 }}>{downloadingPart === attachment.part ? t('message.downloading') : formatBytes(attachment.size)}</span></span>
                <span aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}>↓</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {beforeContent}

      {loadingBody && <div style={{ padding: '20px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>{['62%', '88%', '75%', '50%', '82%', '68%', '90%', '58%'].map((width, index) => <div key={width} className="skeleton-line" style={{ height: 13, width, borderRadius: 4, marginBottom: index === 3 ? 8 : 0 }}/>)}</div>}

      {!loadingBody && bodyError && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '20px 0' }}><div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 20px', maxWidth: 480 }}><div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{t('message.loadingError')}</div><div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{bodyError}</div></div><button onClick={retry} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13 }}>{t('common.retry')}</button></div>}

      {!loadingBody && !bodyError && body && !body.html && !body.text && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '20px 0' }}><div style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>{t('message.noContent')}</div><button onClick={retry} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13 }}>{t('common.retry')}</button></div>}

      {!loadingBody && !bodyError && body?.html && (
        <div style={{ padding: horizontalPadding }}>
          {banner}
          {body.hasBlockedRemoteImages && <div style={{ marginBottom: 10, padding: '9px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)' }}><span>{t('message.remoteImagesBlocked')}</span><div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>{[
            { label: t('message.loadImages'), handler: loadImages },
            senderEmail && { label: t('message.allowSender', { email: senderEmail }), handler: () => allowRemoteImages('address', senderEmail) },
            senderDomain && { label: t('message.allowDomain', { domain: senderDomain }), handler: () => allowRemoteImages('domain', senderDomain) },
          ].filter(Boolean).map(action => <button key={action.label} onClick={action.handler} disabled={savingAllow} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 5, padding: '3px 9px', cursor: savingAllow ? 'default' : 'pointer', color: 'var(--accent)', fontSize: 11, fontWeight: 500, opacity: savingAllow ? 0.5 : 1 }}>{action.label}</button>)}</div></div>}
          <div style={{ position: 'relative', padding: '14px 16px 12px', background: 'white', borderRadius: isMobile || !framed ? 0 : 8, border: isMobile || !framed ? 'none' : '1px solid var(--border-subtle)', overflow: 'hidden', contain: 'layout' }}>
            {USE_DIV_RENDER ? <div ref={outerRef} style={{ position: 'relative', width: '100%' }} onClick={handleEmailClick}><div ref={scaleRef}><div ref={innerRef} data-mailflow-email={prepared?.prefix} className={prepared?.prefix ?? ''} dangerouslySetInnerHTML={prepared ? { __html: prepared.html } : undefined}/></div></div> : <iframe ref={iframeRef} srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="only light"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';"><base target="_blank"></head><body><div id="mf-scale-wrapper">${body.html.replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1')}</div><style>html,body{height:auto!important;min-height:0!important;overflow:hidden!important}body{margin:0!important;padding:0!important;background-color:#fff!important;color-scheme:light;font-family:-apple-system,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;word-wrap:break-word;overflow-wrap:break-word}img{max-width:100%!important;height:auto!important}body>table,body>center>table,body>div>table,body>center>div>table,#mf-scale-wrapper>table,#mf-scale-wrapper>center>table,#mf-scale-wrapper>div>table,#mf-scale-wrapper>center>div>table{width:100%!important}td,th{min-width:0!important}td{word-break:break-word}th{overflow-wrap:normal;word-break:normal}a{color:#6366f1}pre,code{overflow-x:auto;white-space:pre-wrap;word-break:break-all}blockquote{border-left:3px solid #ddd;margin:0;padding-left:12px;color:#555}</style></body></html>`} scrolling="no" style={{ width: '1px', minWidth: '100%', border: 'none', display: 'block', height: '300px' }} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title={t('message.emailFrameTitle')}/>}
          </div>
        </div>
      )}

      {!loadingBody && !bodyError && body?.text && !body.html && <div style={{ padding: horizontalPadding }}>{banner}<div style={{ margin: 0, padding: '14px 16px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14, color: '#1a1a1a', lineHeight: 1.7, fontFamily: 'DM Sans, sans-serif', background: 'white', borderRadius: isMobile || !framed ? 0 : 8, border: isMobile || !framed ? 'none' : '1px solid var(--border-subtle)', overflow: 'hidden' }} dangerouslySetInnerHTML={{ __html: linkifyText(body.text) }}/></div>}
    </>
  );
}
