import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  sniffPreview, nextZoom, fitScale, canvasPixelRatio, printDocumentHtml,
} from '../utils/attachmentPreview.js';

// Full-screen preview of a message's PDF and image attachments, with Download and Print, so a
// boleto or a photo can be read without saving a copy to the computer first.
//
// The file is fetched through the same endpoint as a download and checked by its bytes before
// anything renders it (see attachmentPreview.js). Images go in an <img>; PDFs are drawn by pdf.js
// (pdfDocument.js), loaded only when the first PDF is opened. While the viewer is open it keeps
// every keystroke to itself, because the mail shortcuts underneath would otherwise archive or
// delete a message the user can no longer see.

const loadPdfModule = () => import('../utils/pdfDocument.js');

const CHROME = {
  bar: 'rgba(18, 18, 22, 0.94)',
  text: '#f2f2f5',
  muted: 'rgba(242, 242, 245, 0.62)',
  hover: 'rgba(255, 255, 255, 0.12)',
  backdrop: 'rgba(8, 8, 12, 0.9)',
};

export default function AttachmentViewer({ messageId, attachments, startIndex = 0, onClose, onDownloadFallback }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(attachments.length - 1, 0)));
  const att = attachments[index];
  const part = att?.part;
  const [file, setFile] = useState({ status: 'loading' });
  const [zoom, setZoom] = useState(1);
  const [printing, setPrinting] = useState(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [pdf, setPdf] = useState(null);
  const contentRef = useRef(null);

  useEffect(() => {
    if (part === undefined) return undefined;
    const controller = new AbortController();
    let url = null;
    setPdf(null);
    setFile({ status: 'loading' });
    setZoom(1);
    (async () => {
      try {
        const res = await fetch(`/api/mail/messages/${messageId}/attachments/${encodeURIComponent(part)}`, {
          credentials: 'include', signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (controller.signal.aborted) return;
        const preview = sniffPreview(bytes);
        if (!preview) { setFile({ status: 'error', reason: 'unsupported', bytes }); return; }
        if (preview.kind === 'image') url = URL.createObjectURL(new Blob([bytes], { type: preview.type }));
        setFile({ status: 'ready', bytes, preview, url });
      } catch {
        if (!controller.signal.aborted) setFile({ status: 'error', reason: 'failed' });
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [messageId, part]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return undefined;
    const measure = () => setArea({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const returnTo = document.activeElement;
    contentRef.current?.focus({ preventScroll: true });
    return () => returnTo?.focus?.({ preventScroll: true });
  }, []);

  const go = useCallback(step => {
    const target = index + step;
    if (target < 0 || target >= attachments.length) return false;
    setIndex(target);
    return true;
  }, [index, attachments.length]);

  const download = useCallback(() => {
    if (!att) return;
    if (file.bytes) saveBytes(file.bytes, att.filename, file.preview?.type);
    else onDownloadFallback?.(att);
  }, [att, file, onDownloadFallback]);

  const print = useCallback(async () => {
    if (file.status !== 'ready' || printing || !att) return;
    if (file.preview.kind === 'image') {
      await printImages([file.url], att.filename);
      return;
    }
    if (!pdf) return;
    let urls = [];
    setPrinting({ done: 0, total: pdf.doc.numPages });
    try {
      const { renderPagesForPrint } = await loadPdfModule();
      urls = await renderPagesForPrint(pdf, { onProgress: (done, total) => setPrinting({ done, total }) });
      await printImages(urls, att.filename);
    } catch (err) {
      console.error('Print failed:', err);
    } finally {
      urls.forEach(url => URL.revokeObjectURL(url));
      setPrinting(null);
    }
  }, [att, file, pdf, printing]);

  // Refs keep the capture-phase listener installed once for the viewer's lifetime.
  const actions = useRef({});
  actions.current = { onClose, go, print };
  useEffect(() => {
    const onKey = e => {
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (e.key === 'Escape') {
        e.preventDefault();
        actions.current.onClose();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        actions.current.print();
      } else if (plain && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (actions.current.go(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const narrow = area.width > 0 && area.width < 640;
  const ready = file.status === 'ready';
  const errorText = file.reason === 'unsupported' ? t('message.preview.unsupported')
    : file.reason === 'password' ? t('message.preview.password')
      : t('message.preview.failed');

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('message.preview.label', { name: att?.filename ?? '' })}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000, display: 'flex', flexDirection: 'column',
        background: CHROME.backdrop, color: CHROME.text,
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: narrow ? '8px 8px 8px 12px' : '10px 12px 10px 18px',
        background: CHROME.bar, borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div title={att?.filename} style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {att?.filename}
          </div>
          {attachments.length > 1 && (
            <div style={{ fontSize: 11, color: CHROME.muted }}>
              {t('message.preview.position', { current: index + 1, total: attachments.length })}
            </div>
          )}
        </div>
        {ready && (
          <>
            <ToolbarButton label={t('message.preview.zoomOut')} onClick={() => setZoom(z => nextZoom(z, -1))}>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </ToolbarButton>
            <button
              type="button"
              onClick={() => setZoom(1)}
              title={t('message.preview.fit')}
              aria-label={t('message.preview.fit')}
              style={{ ...buttonStyle, minWidth: 48, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
              onMouseEnter={hoverIn} onMouseLeave={hoverOut}
            >
              {Math.round(zoom * 100)}%
            </button>
            <ToolbarButton label={t('message.preview.zoomIn')} onClick={() => setZoom(z => nextZoom(z, 1))}>
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </ToolbarButton>
            <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.14)', margin: '0 4px' }} />
            <ToolbarButton
              label={printing ? t('message.preview.preparingPrint', printing) : t('message.preview.print')}
              text={narrow ? null : (printing ? t('message.preview.preparingPrint', printing) : t('message.preview.print'))}
              onClick={print}
              disabled={!!printing || (file.preview.kind === 'pdf' && !pdf)}
            >
              <polyline points="6 9 6 2 18 2 18 9"/>
              <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </ToolbarButton>
          </>
        )}
        <ToolbarButton label={t('message.preview.download')} text={narrow ? null : t('message.preview.download')} onClick={download} disabled={!att}>
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </ToolbarButton>
        <ToolbarButton label={t('message.preview.close')} onClick={onClose}>
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </ToolbarButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        <div ref={contentRef} tabIndex={0} style={{ flex: 1, minWidth: 0, overflow: 'auto', outline: 'none' }}>
          {file.status === 'loading' && <Centered>{t('common.loading')}</Centered>}
          {file.status === 'error' && (
            <Centered>
              <div style={{
                maxWidth: 380, textAlign: 'center', padding: '20px 22px', borderRadius: 12,
                background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>{errorText}</div>
                <button type="button" onClick={download} style={{
                  padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 500,
                }}>
                  {t('message.preview.download')}
                </button>
              </div>
            </Centered>
          )}
          {ready && file.preview.kind === 'image' && (
            <ImageView
              key={part}
              url={file.url}
              alt={att?.filename ?? ''}
              zoom={zoom}
              area={area}
              padding={narrow ? 12 : 28}
              onToggleZoom={() => setZoom(z => (z === 1 ? 2 : 1))}
            />
          )}
          {ready && file.preview.kind === 'pdf' && (
            <PdfView
              key={part}
              bytes={file.bytes}
              zoom={zoom}
              area={area}
              padding={narrow ? 8 : 24}
              scrollRoot={contentRef}
              loadingLabel={t('common.loading')}
              onOpen={setPdf}
              onError={err => setFile(f => ({ ...f, status: 'error', reason: err?.name === 'PasswordException' ? 'password' : 'failed' }))}
            />
          )}
        </div>
        {attachments.length > 1 && (
          <>
            <SideButton side="left" label={t('message.preview.previous')} disabled={index === 0} onClick={() => go(-1)} />
            <SideButton side="right" label={t('message.preview.next')} disabled={index === attachments.length - 1} onClick={() => go(1)} />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

const buttonStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  height: 34, padding: '0 9px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'transparent', color: CHROME.text, fontSize: 13, flexShrink: 0,
};
const hoverIn = e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = CHROME.hover; };
const hoverOut = e => { e.currentTarget.style.background = 'transparent'; };

function ToolbarButton({ label, text = null, onClick, disabled = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{ ...buttonStyle, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' }}
      onMouseEnter={hoverIn}
      onMouseLeave={hoverOut}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
      {text && <span>{text}</span>}
    </button>
  );
}

function SideButton({ side, label, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      style={{
        position: 'absolute', top: '50%', [side]: 12, transform: 'translateY(-50%)',
        width: 40, height: 40, borderRadius: '50%', border: 'none',
        display: disabled ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center',
        background: CHROME.bar, color: CHROME.text, cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {side === 'left' ? <polyline points="15 18 9 12 15 6"/> : <polyline points="9 18 15 12 9 6"/>}
      </svg>
    </button>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box', fontSize: 13, color: CHROME.muted }}>
      {children}
    </div>
  );
}

function ImageView({ url, alt, zoom, area, padding, onToggleZoom }) {
  const [natural, setNatural] = useState(null);
  const fit = natural
    ? Math.min((area.width - 2 * padding) / natural.width, (area.height - 2 * padding) / natural.height, 1)
    : 1;
  const sized = natural && fit > 0;
  return (
    <div style={{ minHeight: '100%', display: 'flex', padding, boxSizing: 'border-box' }}>
      <img
        src={url}
        alt={alt}
        draggable={false}
        onLoad={e => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        onDoubleClick={onToggleZoom}
        style={{
          margin: 'auto', display: 'block', flexShrink: 0,
          width: sized ? natural.width * fit * zoom : undefined,
          height: sized ? natural.height * fit * zoom : undefined,
          maxWidth: sized ? 'none' : '100%',
          maxHeight: sized ? 'none' : '100%',
          boxShadow: '0 4px 28px rgba(0,0,0,0.45)',
          cursor: zoom === 1 ? 'zoom-in' : 'zoom-out',
        }}
      />
    </div>
  );
}

function PdfView({ bytes, zoom, area, padding, scrollRoot, loadingLabel, onOpen, onError }) {
  const [pdf, setPdf] = useState(null);
  const [sizes, setSizes] = useState(null);
  const callbacks = useRef({});
  callbacks.current = { onOpen, onError };

  useEffect(() => {
    let cancelled = false;
    let handle = null;
    (async () => {
      try {
        const { openPdf } = await loadPdfModule();
        const opened = await openPdf(bytes);
        if (cancelled) { opened.destroy(); return; }
        handle = opened;
        const list = [];
        for (let n = 1; n <= opened.doc.numPages; n++) {
          const page = await opened.doc.getPage(n);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1 });
          list.push({ width: viewport.width, height: viewport.height });
        }
        setPdf(opened);
        setSizes(list);
        callbacks.current.onOpen(opened);
      } catch (err) {
        if (!cancelled) callbacks.current.onError(err);
      }
    })();
    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [bytes]);

  // Waits for the first measurement too, or every page would be drawn once at the wrong size.
  if (!pdf || !sizes || !(area.width > 0)) return <Centered>{loadingLabel}</Centered>;
  const widest = Math.max(...sizes.map(s => s.width));
  const scale = fitScale(area.width - 2 * padding, widest) * zoom;
  return (
    <div style={{
      width: 'fit-content', minWidth: '100%', margin: '0 auto', padding, boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
    }}>
      {sizes.map((size, i) => (
        <PdfPage key={i} pdf={pdf} number={i + 1} size={size} scale={scale} scrollRoot={scrollRoot} />
      ))}
    </div>
  );
}

function PdfPage({ pdf, number, size, scale, scrollRoot }) {
  const pageRef = useRef(null);
  const canvasHostRef = useRef(null);
  const textRef = useRef(null);
  const [near, setNear] = useState(number <= 2);

  // Pages are drawn as they come near the viewport, so a long PDF opens as fast as a short one.
  useEffect(() => {
    if (near) return undefined;
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return undefined; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setNear(true);
    }, { root: scrollRoot.current, rootMargin: '800px 0px' });
    observer.observe(pageRef.current);
    return () => observer.disconnect();
  }, [near, scrollRoot]);

  useEffect(() => {
    if (!near) return undefined;
    let cancelled = false;
    const cssWidth = size.width * scale;
    const cssHeight = size.height * scale;
    // Drawn off to the side and swapped in when finished, so zooming never flashes a blank page.
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    const job = loadPdfModule().then(({ renderPage }) => {
      if (cancelled) return null;
      return renderPage(pdf, number, {
        canvas, textContainer: textRef.current, scale,
        pixelRatio: canvasPixelRatio(cssWidth, cssHeight, window.devicePixelRatio),
      });
    });
    job.then(task => task?.done).then(() => {
      if (!cancelled) canvasHostRef.current?.replaceChildren(canvas);
    }).catch(err => console.warn(`PDF page ${number} failed to render:`, err));
    return () => {
      cancelled = true;
      job.then(task => task?.cancel());
    };
  }, [pdf, number, near, scale, size.width, size.height]);

  return (
    <div
      ref={pageRef}
      className="mf-pdf-page"
      style={{
        position: 'relative', flexShrink: 0, width: size.width * scale, height: size.height * scale,
        background: '#fff', boxShadow: '0 2px 14px rgba(0,0,0,0.45)',
      }}
    >
      <div ref={canvasHostRef} style={{ position: 'absolute', inset: 0 }} />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}

function saveBytes(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Prints the given images, one per sheet, from a hidden same-origin frame: no pop-up to be
// blocked, and nothing of the app around them on paper.
function printImages(urls, title) {
  return new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Moved off-screen rather than display:none, which some browsers decline to print.
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      frame.remove();
      resolve();
    };
    frame.addEventListener('load', () => {
      const win = frame.contentWindow;
      if (!win) { finish(); return; }
      win.addEventListener('afterprint', () => setTimeout(finish, 0), { once: true });
      win.focus();
      win.print();
      // Chrome blocks inside print() until the dialog closes; a browser that never fires
      // afterprint still gets its frame removed.
      setTimeout(finish, 60_000);
    }, { once: true });
    frame.srcdoc = printDocumentHtml(title, urls);
    document.body.appendChild(frame);
  });
}
