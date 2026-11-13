import { useEffect, useState, useCallback } from 'react';
import { api } from '../utils/api.js';
import { refreshAllTags, bumpTagDefinitions, useTagDefinitionsRevision } from './tagStore.js';
import { useTranslation } from 'react-i18next';

const card = { border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', background: 'var(--bg-secondary)', marginTop: 12 };
const label = { fontSize: 11, color: 'var(--text-tertiary)', display: 'block', margin: '8px 0 3px' };
const input = { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '5px 7px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary, transparent)', color: 'var(--text-primary)' };
const btn = { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer', background: 'transparent', color: 'var(--text-primary)' };

function Message({ msg }) {
  if (!msg) return null;
  return <div style={{ fontSize: 12, marginTop: 6, color: 'var(--red, #ef4444)' }}>{msg}</div>;
}

function TagRow({ def, onChanged }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  const patch = async (p) => { try { await api.tagUpdate(def.id, p); refreshAllTags(); onChanged(); return true; } catch (e) { setMsg(e.message); return false; } };
  const remove = async () => {
    if (!window.confirm(t('tags.settings.confirmDelete', { name: def.name }))) return;
    try { await api.tagDelete(def.id); refreshAllTags(); onChanged(); } catch (e) { setMsg(e.message); }
  };
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 12, height: 12, borderRadius: 3, background: def.color }} />
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{def.name}</span>
        <button style={btn} onClick={() => { setF({ name: def.name, color: def.color }); setOpen(!open); }}>{open ? t('admin.close') : t('common.edit')}</button>
      </div>
      {open && f && (
        <div>
          <span style={label}>{t('tags.settings.name')}</span>
          <input style={input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <span style={label}>{t('tags.settings.color')}</span>
          <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={btn} onClick={async () => { if (await patch(f)) setOpen(false); }}>{t('common.save')}</button>
            <button style={{ ...btn, color: 'var(--red, #ef4444)' }} onClick={remove}>{t('common.delete')}</button>
          </div>
        </div>
      )}
      <Message msg={msg} />
    </div>
  );
}

function NewTag({ onCreated }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', color: '#3b82f6' });
  const [msg, setMsg] = useState(null);
  const create = async () => {
    try {
      await api.tagCreate(f);
      setF({ name: '', color: '#3b82f6' }); setOpen(false); setMsg(null); onCreated();
    } catch (e) { setMsg(e.message); }
  };
  if (!open) return <button style={{ ...btn, marginTop: 8 }} onClick={() => setOpen(true)}>{t('tags.settings.add')}</button>;
  return (
    <div style={{ marginTop: 8 }}>
      <span style={label}>{t('tags.settings.name')}</span>
      <input style={input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <span style={label}>{t('tags.settings.color')}</span>
      <input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button style={btn} onClick={create}>{t('tags.settings.create')}</button>
        <button style={btn} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
      </div>
      <Message msg={msg} />
    </div>
  );
}

// The user's tags: add, rename, recolour, delete.
export default function TagsSettings() {
  const { t } = useTranslation();
  const [defs, setDefs] = useState(null);
  const [msg, setMsg] = useState(null);
  const revision = useTagDefinitionsRevision();
  const load = useCallback(() => { api.tagDefinitions().then(setDefs).catch((e) => setMsg(e.message)); }, []);
  useEffect(load, [load, revision]);
  // A change made here is announced so the other screens reload their list of tags.
  const changed = useCallback(() => { bumpTagDefinitions(); }, []);
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{t('tags.title')}</div>
      <div style={card}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '0 0 4px' }}>{t('tags.settings.note')}</div>
        {(defs || []).map((d) => <TagRow key={d.id} def={d} onChanged={changed} />)}
        <NewTag onCreated={changed} />
        <Message msg={msg} />
      </div>
    </div>
  );
}
