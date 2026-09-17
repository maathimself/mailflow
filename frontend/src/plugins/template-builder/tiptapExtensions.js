import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { createElement } from 'react';
import { SocialIcon } from './socialIcons.js';
import { safeUrl } from './utils.js';

function ButtonNodeView({ node }) {
  const { label, href, backgroundColor, color } = node.attrs;
  return createElement(
    NodeViewWrapper,
    { as: 'p', style: { textAlign: 'center', margin: '8px 0' }, contentEditable: false },
    createElement(
      'a',
      {
        href: safeUrl(href),
        style: {
          display: 'inline-block',
          background: backgroundColor || '#007bff',
          color: color || '#ffffff',
          padding: '10px 24px',
          borderRadius: 4,
          textDecoration: 'none',
          fontWeight: 500,
          fontSize: 14,
        },
      },
      label || 'Click here'
    )
  );
}

export const TemplateButton = Node.create({
  name: 'templateButton',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      label:           { default: 'Click here', parseHTML: el => el.getAttribute('data-label') },
      href:            { default: '#',           parseHTML: el => el.getAttribute('data-href') },
      backgroundColor: { default: '#007bff',    parseHTML: el => el.getAttribute('data-bg') },
      color:           { default: '#ffffff',     parseHTML: el => el.getAttribute('data-color') },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="template-button"]' }];
  },

  renderHTML({ node }) {
    const { label, href, backgroundColor, color } = node.attrs;
    const safeHref = safeUrl(href);
    const bg = backgroundColor || '#007bff';
    const fg = color || '#ffffff';
    return ['div', {
      'data-type': 'template-button',
      'data-label': label,
      'data-href': safeHref,
      'data-bg': bg,
      'data-color': fg,
      style: 'text-align:center;margin:8px 0;',
    }, ['a', {
      href: safeHref,
      style: `display:inline-block;background:${bg};color:${fg};padding:10px 24px;border-radius:4px;text-decoration:none;font-weight:500;font-size:14px;`,
    }, label || 'Click here']];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ButtonNodeView);
  },
});



function SpacerNodeView({ node }) {
  const h = node.attrs.height || '24px';
  return createElement(
    NodeViewWrapper,
    {
      as: 'div',
      contentEditable: false,
      style: {
        height: h,
        background: 'repeating-linear-gradient(45deg,var(--border,#e0e0e0) 0,var(--border,#e0e0e0) 1px,transparent 1px,transparent 8px)',
        cursor: 'default',
        opacity: 0.5,
      },
    }
  );
}

export const TemplateSpacer = Node.create({
  name: 'templateSpacer',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      height: { default: '24px', parseHTML: el => el.getAttribute('data-height') || '24px' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="template-spacer"]' }];
  },

  renderHTML({ node }) {
    const h = node.attrs.height || '24px';
    return ['div', {
      'data-type': 'template-spacer',
      'data-height': h,
      style: `height:${h};line-height:${h};font-size:1px;`,
    }, '\u00a0'];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SpacerNodeView);
  },
});



function SocialNodeView({ node }) {
  const items = Array.isArray(node.attrs.items) ? node.attrs.items : [];
  return createElement(
    NodeViewWrapper,
    { as: 'p', style: { textAlign: 'center', margin: '8px 0', display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 12 }, contentEditable: false },
    ...items.filter(it => it.href && it.href !== '#').map((it, i) =>
      createElement('a', {
        key: i,
        href: safeUrl(it.href),
        style: { display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent, #6366f1)', textDecoration: 'none' },
      },
        createElement(SocialIcon, { name: it.name, size: 15 }),
        it.label ? createElement('span', { style: { fontSize: 13 } }, it.label) : null,
      )
    )
  );
}

export const TemplateSocial = Node.create({
  name: 'templateSocial',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      items: {
        default: [],
        parseHTML: el => {
          try { return JSON.parse(el.getAttribute('data-items') || '[]'); } catch { return []; }
        },
        renderHTML: attrs => ({ 'data-items': JSON.stringify(attrs.items || []) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="template-social"]' }];
  },

  renderHTML({ node }) {
    const items = Array.isArray(node.attrs.items) ? node.attrs.items : [];
    const validItems = items.filter(it => it.href && it.href !== '#');
    return ['div', {
      'data-type': 'template-social',
      'data-items': JSON.stringify(items),
      style: 'text-align:center;margin:8px 0;',
    },
      ...validItems.map(it => ['a', {
        href: safeUrl(it.href),
        style: 'display:inline-block;margin:0 6px;color:#6366f1;text-decoration:none;font-size:14px;',
      }, it.label || it.name]),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SocialNodeView);
  },
});
