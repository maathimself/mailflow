import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { addSidebarLabel, buildSidebarFolderChoices, removeSidebarLabel, resolveSavedSidebarLabels } from '../utils/rightSidebar.js';

function SortableLabelRow({ folder, onRemove, disabled }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: folder.path, disabled });

  return (
    <div ref={setNodeRef} style={{
      display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px',
      background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 7,
      transform: CSS.Transform.toString(transform), transition,
    }}>
      <button
        type="button"
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label={t('admin.rightSidebar.drag')}
        title={t('admin.rightSidebar.drag')}
        style={{
          display: 'flex', padding: 2, background: 'none', border: 'none',
          color: 'var(--text-primary)', cursor: disabled ? 'default' : 'grab', touchAction: 'none',
        }}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="8" cy="6" r="1.5"/><circle cx="16" cy="6" r="1.5"/>
          <circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/>
          <circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/>
        </svg>
      </button>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {folder.name}
        </div>
        {folder.name !== folder.path && (
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {folder.path}
          </div>
        )}
      </div>
      {!folder.available && (
        <span style={{
          flexShrink: 0, padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
          color: 'var(--amber)', background: 'color-mix(in srgb, var(--amber) 12%, transparent)',
        }}>
          {t('admin.rightSidebar.unavailable')}
        </span>
      )}
      <button
        type="button"
        onClick={() => onRemove(folder.path)}
        disabled={disabled}
        title={t('common.remove')}
        style={{ display: 'flex', padding: 3, background: 'none', border: 'none', color: 'var(--text-primary)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
}

function AccountSidebarLabels({ account }) {
  const { t } = useTranslation();
  const updateAccount = useStore(state => state.updateAccount);
  const [labels, setLabels] = useState(() => [...(account.right_sidebar_labels || [])]);
  const [folders, setFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [folderError, setFolderError] = useState('');
  const [addPath, setAddPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLabels([...(account.right_sidebar_labels || [])]);
  }, [account.id, account.right_sidebar_labels]);

  useEffect(() => {
    let cancelled = false;
    setFoldersLoading(true);
    setFolderError('');
    api.getFolders(account.id)
      .then(result => { if (!cancelled) setFolders(result); })
      .catch(() => { if (!cancelled) setFolderError(t('admin.rightSidebar.loadFailed')); })
      .finally(() => { if (!cancelled) setFoldersLoading(false); });
    return () => { cancelled = true; };
  }, [account.id, t]);

  const choices = useMemo(() => buildSidebarFolderChoices(folders, labels), [folders, labels]);
  const persistedLabels = account.right_sidebar_labels || [];
  const dirty = labels.length !== persistedLabels.length || labels.some((label, index) => label !== persistedLabels[index]);

  const handleChange = (next) => {
    if (saving) return;
    setLabels(next);
    setError('');
    setSaved(false);
  };

  const handleDragEnd = ({ active, over }) => {
    if (saving || !over || active.id === over.id) return;
    const from = labels.indexOf(active.id);
    const to = labels.indexOf(over.id);
    if (from < 0 || to < 0) return;
    handleChange(arrayMove(labels, from, to));
  };

  const handleAdd = () => {
    if (saving || !addPath) return;
    handleChange(addSidebarLabel(labels, addPath));
    setAddPath('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const result = await api.updateAccount(account.id, { right_sidebar_labels: labels });
      const savedLabels = resolveSavedSidebarLabels(result, labels);
      setLabels(savedLabels);
      updateAccount(account.id, { right_sidebar_labels: savedLabels });
      if (result?.right_sidebar_labels_rejected?.length) {
        setError(t('admin.rightSidebar.rejected'));
      } else {
        setSaved(true);
      }
    } catch {
      setError(t('admin.rightSidebar.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 14, marginBottom: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 9 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{account.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>{account.email_address}</div>
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 7, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {t('admin.rightSidebar.selected')}
      </div>
      {choices.selected.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>{t('admin.rightSidebar.noLabels')}</div>
      ) : (
        <DndContext
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={labels} strategy={verticalListSortingStrategy}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {choices.selected.map(folder => (
                <SortableLabelRow
                  key={folder.path}
                  folder={folder}
                  disabled={saving}
                  onRemove={path => handleChange(removeSidebarLabel(labels, path))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {foldersLoading ? (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('common.loading')}</div>
      ) : folderError ? (
        <div style={{ fontSize: 12, color: 'var(--red)' }}>{folderError}</div>
      ) : (
        <div style={{ display: 'flex', gap: 7 }}>
          <select
            value={addPath}
            onChange={event => setAddPath(event.target.value)}
            disabled={saving || choices.available.length === 0}
            style={{
              minWidth: 0, flex: 1, padding: '7px 9px', background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12,
            }}
          >
            <option value="">{t('admin.rightSidebar.addPlaceholder')}</option>
            {choices.available.map(folder => <option key={folder.path} value={folder.path}>{folder.name}</option>)}
          </select>
          <button
            type="button"
            onClick={handleAdd}
            disabled={saving || !addPath}
            style={{
              padding: '7px 12px', background: addPath && !saving ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
              border: `1px solid ${addPath && !saving ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 6, color: addPath && !saving ? 'var(--text-primary)' : 'var(--text-tertiary)',
              cursor: addPath && !saving ? 'pointer' : 'default', fontSize: 12,
            }}
          >
            {t('common.add')}
          </button>
        </div>
      )}

      {error && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 10 }}>{error}</div>}
      {saved && <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 10 }}>{t('admin.rightSidebar.saved')}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          style={{
            padding: '8px 16px', background: dirty && !saving ? 'var(--accent)' : 'var(--bg-tertiary)',
            border: 'none', borderRadius: 7,
            color: dirty && !saving ? 'var(--accent-text)' : 'var(--text-tertiary)', fontSize: 13, fontWeight: 500,
            cursor: dirty && !saving ? 'pointer' : 'default',
          }}
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

export default function RightSidebarSettings() {
  const { t } = useTranslation();
  const accounts = useStore(state => state.accounts);

  return (
    <div>
      <h2 style={{ margin: '0 0 6px', fontSize: 17, color: 'var(--text-primary)' }}>{t('admin.rightSidebar.title')}</h2>
      <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
        {t('admin.rightSidebar.description')}
      </p>
      {accounts.length === 0
        ? <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.rightSidebar.noAccounts')}</div>
        : accounts.map(account => <AccountSidebarLabels key={account.id} account={account} />)}
    </div>
  );
}
