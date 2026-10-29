import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { closeHistory } from '@tiptap/pm/history';
import DOMPurify from 'dompurify';
import { useTranslation } from 'react-i18next';
import { useMobile } from '../hooks/useMobile.js';
import { createComposeExtensions, createComposeEditorProps, RichToolbar, resizeImageToDataUrl } from './ComposeModal.jsx';

// Shared composer surface for reusable mail content, without sending or draft side effects.
export default function ComposeContentEditor({ value, onChange, disabled = false, renderActions }) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const [htmlMode, setHtmlMode] = useState(false);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const imageInput = useRef(null);
  const sourceInput = useRef(null);
  const editor = useEditor({
    extensions: createComposeExtensions(t('compose.bodyPh')),
    editorProps: createComposeEditorProps(),
    content: DOMPurify.sanitize(value || ''),
    onUpdate: ({ editor: updated }) => onChange(updated.getHTML()),
  });
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  const toggleSource = () => {
    if (htmlMode) {
      const safe = DOMPurify.sanitize(source);
      editor.commands.setContent(safe);
      onChange(editor.getHTML());
    } else setSource(editor.getHTML());
    setHtmlMode(!htmlMode);
  };
  const captureSelection = () => htmlMode ? {
    mode: 'source', value: sourceInput.current.value,
    from: sourceInput.current.selectionStart, to: sourceInput.current.selectionEnd,
  } : { mode: 'rich', bookmark: editor?.state.selection.getBookmark() };
  const insertText = (text, selection) => {
    if (disabled || !editor || editor.isDestroyed) return false;
    if (htmlMode) {
      const sameSource = selection?.mode === 'source' && selection.value === source;
      const from = sameSource ? selection.from : source.length;
      const to = sameSource ? selection.to : source.length;
      const next = source.slice(0, from) + text + source.slice(to);
      setSource(next); onChange(DOMPurify.sanitize(next));
      requestAnimationFrame(() => {
        sourceInput.current?.focus();
        sourceInput.current?.setSelectionRange(from + text.length, from + text.length);
      });
    } else {
      editor.chain().focus().command(({ tr }) => {
        closeHistory(tr);
        if (selection?.mode === 'rich' && selection.bookmark) {
          try { tr.setSelection(selection.bookmark.resolve(tr.doc)); }
          catch { /* Keep the current selection if the document changed while a dialog was open. */ }
        }
        return true;
      }).insertContent({ type: 'text', text }).run();
    }
    return true;
  };
  return <div className="template-content-editor tiptap-compose">
    <RichToolbar editor={editor} isMobile={isMobile} htmlMode={htmlMode} onToggleHtml={toggleSource}
      extraControls={renderActions?.({ disabled: disabled || !editor, captureSelection, insertText })}
      onInsertImage={() => imageInput.current?.click()} />
    <input hidden ref={imageInput} type="file" accept="image/*" onChange={async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const src = await resizeImageToDataUrl(file);
        if (!editor.isDestroyed) editor.chain().focus().setImage({ src }).run();
      } catch (failure) { setError(failure.message); }
    }} />
    {error && <p role="alert">{error}</p>}
    {htmlMode ? <textarea ref={sourceInput} disabled={disabled} aria-label={t('signatureEditor.sourceMode')} value={source}
      onChange={event => { setSource(event.target.value); onChange(DOMPurify.sanitize(event.target.value)); }} />
      : <EditorContent editor={editor} />}
  </div>;
}
