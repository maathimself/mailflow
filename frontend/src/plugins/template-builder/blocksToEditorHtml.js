import { esc, safeUrl, isValidColor, isValidAlign, isValidLength } from './utils.js';
import { getSocialIconSvgString } from './socialIcons.js';

const HEADING_TAGS = { h1: 'h1', h2: 'h2', h3: 'h3', paragraph: 'p' };

export function blocksToEditorHtml(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.map(block => {
    const p = block.props ?? {};

    switch (block.type) {
      case 'text': {
        const blockType    = p.type || 'paragraph';
        const tag          = HEADING_TAGS[blockType] || 'p';
        const safeColor    = isValidColor(p.color) ? p.color : null;
        const safeFontSize = isValidLength(p.fontSize) ? p.fontSize : null;
        const safeAlign    = isValidAlign(p.align) ? p.align : 'left';

        let styles = `text-align:${safeAlign};`;
        if (safeColor && safeColor !== '#000000') styles += `color:${safeColor};`;
        if (safeFontSize) styles += `font-size:${safeFontSize};`;

        let inner = esc(p.content ?? '');
        if (p.italic) inner = `<em>${inner}</em>`;
        if (p.bold && blockType === 'paragraph') inner = `<strong>${inner}</strong>`;

        return `<${tag} style="${styles}">${inner}</${tag}>`;
      }

      case 'image': {
        const src = esc(safeUrl(p.src));
        const alt = esc(p.alt ?? '');
        const img = `<img src="${src}" alt="${alt}" style="max-width:100%;display:block">`;
        return p.href ? `<a href="${esc(safeUrl(p.href))}">${img}</a>` : img;
      }

      case 'button': {
        const href  = safeUrl(p.href);
        const label = p.label ?? 'Click here';
        const bg    = isValidColor(p.backgroundColor) ? p.backgroundColor : '#007bff';
        const color = isValidColor(p.color) ? p.color : '#ffffff';
        return `<div data-type="template-button" data-label="${esc(label)}" data-href="${esc(href)}" data-bg="${bg}" data-color="${color}" style="text-align:center;margin:8px 0;"><a href="${esc(href)}" style="display:inline-block;background:${bg};color:${color};padding:10px 24px;border-radius:4px;text-decoration:none;font-weight:500;font-size:14px;">${esc(label)}</a></div>`;
      }

      case 'divider': {
        const width = isValidLength(p.width) ? p.width : '1px';
        const color = isValidColor(p.color) ? p.color : '#e0e0e0';
        return `<hr style="border:none;border-top:${width} solid ${color};margin:16px 0">`;
      }

      case 'spacer': {
        const h = isValidLength(p.height) ? p.height : '24px';
        return `<div data-type="template-spacer" data-height="${h}" style="height:${h};line-height:${h};font-size:1px;">\u00a0</div>`;
      }

      case 'columns': {
        const cols  = Array.isArray(p.columns) ? p.columns : [{ content: '' }, { content: '' }];
        const width = Math.round(100 / cols.length);
        const cells = cols.map(col =>
          `<td style="padding:8px;vertical-align:top;width:${width}%">${esc(col.content ?? '')}</td>`
        ).join('');
        return `<table style="width:100%;border-collapse:collapse"><tbody><tr>${cells}</tr></tbody></table>`;
      }

      case 'list': {
        const items = String(p.items ?? '').split('\n').filter(s => s.trim());
        if (!items.length) return '';
        const tag = p.listType === 'ol' ? 'ol' : 'ul';
        const lis = items.map(item => `<li>${esc(item)}</li>`).join('');
        return `<${tag}>${lis}</${tag}>`;
      }

      case 'social': {
        const items = Array.isArray(p.items) ? p.items.filter(it => it.href && it.href !== '#') : [];
        if (!items.length) return '';
        const encoded = JSON.stringify(p.items ?? []).replace(/"/g, '&quot;');
        const links = items.map(it => {
          const icon  = getSocialIconSvgString(it.name, 15);
          const label = it.label ? `<span style="font-size:13px;vertical-align:middle;">${esc(it.label)}</span>` : '';
          return `<a href="${esc(safeUrl(it.href))}" style="display:inline-flex;align-items:center;gap:4px;margin:0 6px;color:#6366f1;text-decoration:none;">${icon}${label}</a>`;
        }).join('');
        return `<div data-type="template-social" data-items="${encoded}" style="text-align:center;margin:8px 0;">${links}</div>`;
      }

      default:
        return '';
    }
  }).filter(Boolean).join('\n');
}
