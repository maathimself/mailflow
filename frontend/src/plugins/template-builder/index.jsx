// Template Builder plugin — frontend registrations (v3.0 plugin platform).
//
// Registers:
//  - settings-categories: Template Manager (CRUD + preview) within the admin panel
//  - composer-toolbar: "Template" button that opens a picker and injects HTML
//  - sidebar-nav-item: entry in the left sidebar that opens the full-page editor
//  - main-view: the full-page template builder view
// Imported for its side effects by plugins/index.js.
import { registerSlot, registerPluginMeta, registerEditorExtension } from '../registry.js';
import { TemplateInsertButton } from './TemplateInsertButton.jsx';
import { TemplateBuilderPage } from './TemplateBuilderPage.jsx';
import { TemplateButton, TemplateSpacer, TemplateSocial } from './tiptapExtensions.js';

const PLUGIN_ID = 'template-builder';

registerPluginMeta(PLUGIN_ID, {});

registerEditorExtension(PLUGIN_ID, TemplateButton);
registerEditorExtension(PLUGIN_ID, TemplateSpacer);
registerEditorExtension(PLUGIN_ID, TemplateSocial);

// Composer toolbar: "Template" button that opens a picker and injects HTML.
// ctx.insertHtml is provided by the 'composer-toolbar' PluginSlot in ComposeModal.jsx.
registerSlot('composer-toolbar', {
  pluginId: PLUGIN_ID,
  render: (ctx) => <TemplateInsertButton insertHtml={ctx.insertHtml} />,
});

// Sidebar nav: icon-only button that activates the main-view below.
// Sits inline with the contacts button (row when expanded, column when collapsed).
registerSlot('sidebar-nav-item', {
  pluginId: PLUGIN_ID,
  render: ({ activePluginView, setActivePluginView, isMobile, setMobileSidebarOpen }) => {
    const active = activePluginView === PLUGIN_ID;
    return (
      <button
        type="button"
        title="Templates"
        onClick={() => {
          setActivePluginView(active ? null : PLUGIN_ID);
          if (isMobile && setMobileSidebarOpen) setMobileSidebarOpen(false);
        }}
        style={{
          width: 28, height: 28, borderRadius: 7,
          border: 'none', cursor: 'pointer', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: active ? 'var(--bg-hover)' : 'transparent',
          color: active ? 'var(--accent)' : 'var(--text-tertiary)',
          transition: 'background 0.1s, color 0.1s',
        }}
        onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'var(--bg-tertiary)'; e.currentTarget.style.color = 'var(--text-secondary)'; } }}
        onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; } }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
      </button>
    );
  },
});

// Main view: full-page template builder, activated by sidebar-nav-item above.
registerSlot('main-view', {
  pluginId: PLUGIN_ID,
  render: ({ viewId }) => {
    if (viewId !== PLUGIN_ID) return null;
    return <TemplateBuilderPage />;
  },
});
