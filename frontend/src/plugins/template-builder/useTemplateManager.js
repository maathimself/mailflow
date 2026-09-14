import { useState, useEffect, useCallback, useMemo } from 'react';
import { templateApi } from './templateApi.js';
import { blocksToMjml } from './blockToMjml.js';
import { blocksToEditorHtml } from './blocksToEditorHtml.js';

const EMPTY_FORM = { name: '', description: '', blocks: [] };

export function useTemplateManager() {
  const [templates, setTemplates]     = useState([]);
  const [loading, setLoading]         = useState(false);
  const [selected, setSelected]       = useState(null);
  const [editing, setEditing]         = useState(false);
  const [showNew, setShowNew]         = useState(false);
  const [form, setForm]               = useState(EMPTY_FORM);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await templateApi.list();
      setTemplates(data.templates ?? []);
    } catch {
      setError('Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  function selectTemplate(tpl) {
    setSelected(tpl);
    setEditing(false);
    setShowNew(false);
    setError(null);
    setPendingDelete(null);
  }

  function startCreate() {
    setSelected(null);
    setForm(EMPTY_FORM);
    setEditing(false);
    setShowNew(true);
    setError(null);
    setPendingDelete(null);
  }

  function startEdit(tpl) {
    const target = tpl ?? selected;
    if (!target) return;
    if (tpl) setSelected(tpl);
    setForm({ name: target.name, description: target.description ?? '', blocks: target.blocks ?? [] });
    setEditing(true);
    setError(null);
  }

  function cancelEdit() {
    if (showNew) {
      setShowNew(false);
    } else {
      setEditing(false);
    }
    setError(null);
  }

  const previewHtml = useMemo(() => blocksToEditorHtml(form.blocks), [form.blocks]);

  function handleDelete(tpl) {
    setPendingDelete(tpl);
  }

  function cancelDelete() {
    setPendingDelete(null);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const tpl = pendingDelete;
    setPendingDelete(null);
    try {
      await templateApi.delete(tpl.id);
      setTemplates(ts => ts.filter(t => t.id !== tpl.id));
      if (selected?.id === tpl.id) {
        setSelected(null);
        setEditing(false);
      }
    } catch {
      setError('Failed to delete template');
    }
  }

  async function handleSave() {
    if (saving) return;
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      const mjml = blocksToMjml(form.blocks);
      let savedId;
      if (!showNew && selected) {
        await templateApi.update(selected.id, {
          name: form.name.trim(),
          description: form.description,
          blocks: form.blocks,
          mjml,
        });
        savedId = selected.id;
      } else {
        const created = await templateApi.create({
          name: form.name.trim(),
          description: form.description,
          blocks: form.blocks,
        });
        savedId = created?.template?.id;
        if (savedId) await templateApi.compile(savedId, mjml).catch(() => {});
      }
      const data = await templateApi.list();
      const list = data.templates ?? [];
      setTemplates(list);
      setSelected(list.find(t => t.id === savedId) ?? null);
      setEditing(false);
      setShowNew(false);
    } catch {
      setError('Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  const inForm = editing || showNew;

  return {
    templates, loading,
    selected, selectTemplate,
    editing, showNew, inForm,
    form, setForm,
    saving, error,
    startCreate, startEdit, cancelEdit,
    pendingDelete, handleDelete, confirmDelete, cancelDelete,
    handleSave,
    previewHtml,
  };
}
