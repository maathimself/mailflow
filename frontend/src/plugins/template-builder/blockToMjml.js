import { esc, safeUrl, isValidColor, isValidAlign, isValidLength } from './utils.js';

const HEADING_FONT_SIZES = { h1: '28px', h2: '22px', h3: '18px' };
const MJML_SOCIAL_NAMES  = new Set(['facebook', 'twitter', 'instagram', 'linkedin', 'youtube', 'google', 'pinterest', 'snapchat', 'tumblr', 'github', 'soundcloud', 'medium', 'web']);

function renderBlock(block) {
  const p = block.props ?? {};

  switch (block.type) {
    case 'text': {
      const blockType  = p.type || 'paragraph';
      const isHeading  = blockType !== 'paragraph';
      const fontSize   = isValidLength(p.fontSize) ? p.fontSize : (HEADING_FONT_SIZES[blockType] ?? '14px');
      const fontWeight = (p.bold || isHeading) ? 'bold' : 'normal';
      const fontStyle  = p.italic ? 'italic' : 'normal';
      const color      = isValidColor(p.color) ? p.color : '#000000';
      const align      = isValidAlign(p.align) ? p.align : 'left';
      return `<mj-section><mj-column><mj-text font-size="${fontSize}" color="${color}" align="${align}" font-weight="${fontWeight}" font-style="${fontStyle}">${esc(p.content ?? '')}</mj-text></mj-column></mj-section>`;
    }

    case 'image': {
      const width = isValidLength(p.width) ? p.width : '600px';
      const href  = p.href ? `href="${esc(safeUrl(p.href))}"` : '';
      return `<mj-section><mj-column><mj-image src="${esc(safeUrl(p.src))}" alt="${esc(p.alt ?? '')}" width="${width}" ${href} /></mj-column></mj-section>`;
    }

    case 'button': {
      const align = isValidAlign(p.align) ? p.align : 'center';
      const bg    = isValidColor(p.backgroundColor) ? p.backgroundColor : '#007bff';
      const color = isValidColor(p.color) ? p.color : '#ffffff';
      return `<mj-section><mj-column><mj-button href="${esc(safeUrl(p.href))}" background-color="${bg}" color="${color}" border-radius="4px" align="${align}">${esc(p.label ?? 'Click here')}</mj-button></mj-column></mj-section>`;
    }

    case 'divider': {
      const color = isValidColor(p.color) ? p.color : '#e0e0e0';
      const width = isValidLength(p.width) ? p.width : '1px';
      return `<mj-section><mj-column><mj-divider border-color="${color}" border-width="${width}" /></mj-column></mj-section>`;
    }

    case 'spacer': {
      const height = isValidLength(p.height) ? p.height : '24px';
      return `<mj-section padding="0"><mj-column><mj-spacer height="${height}" /></mj-column></mj-section>`;
    }

    case 'columns': {
      const cols = Array.isArray(p.columns) ? p.columns : [{ content: '' }, { content: '' }];
      const mjCols = cols.map(col =>
        `<mj-column><mj-text>${esc(col.content ?? '')}</mj-text></mj-column>`
      ).join('\n        ');
      return `<mj-section>\n        ${mjCols}\n      </mj-section>`;
    }

    case 'list': {
      const items = String(p.items ?? '').split('\n').filter(s => s.trim());
      if (!items.length) return '';
      const tag = p.listType === 'ol' ? 'ol' : 'ul';
      const lis = items.map(item => `<li>${esc(item)}</li>`).join('');
      return `<mj-section><mj-column><mj-text><${tag} style="padding-left:20px;margin:0">${lis}</${tag}></mj-text></mj-column></mj-section>`;
    }

    case 'social': {
      const items = Array.isArray(p.items) ? p.items.filter(it => it.href && it.href !== '#') : [];
      if (!items.length) return '';
      const elements = items.map(it => {
        const name  = (it.name === 'domain' || !MJML_SOCIAL_NAMES.has(it.name)) ? 'web' : it.name;
        const label = it.label || it.name;
        return `<mj-social-element name="${name}" href="${esc(safeUrl(it.href))}">${esc(label)}</mj-social-element>`;
      }).join('\n        ');
      return `<mj-section><mj-column><mj-social font-size="15px" icon-size="20px" mode="horizontal" align="center">\n        ${elements}\n      </mj-social></mj-column></mj-section>`;
    }

    default:
      return '';
  }
}

export function blocksToMjml(blocks) {
  const body = (Array.isArray(blocks) ? blocks : [])
    .map(renderBlock)
    .filter(Boolean)
    .join('\n      ');

  return `<mjml>
  <mj-body>
      ${body}
  </mj-body>
</mjml>`;
}
