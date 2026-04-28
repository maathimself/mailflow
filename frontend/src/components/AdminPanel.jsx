import { useState, useEffect, useRef } from 'react';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';
import { api } from '../utils/api.js';
import { THEMES, applyTheme } from '../themes.js';
import { FONT_SETS, loadFontSet } from '../fonts.js';
import { LAYOUTS, applyLayout } from '../layouts.js';
import { NOTIFICATION_SOUNDS, playNotificationSound, playCustomSound, warmUpAudioContext } from '../utils/notificationSounds.js';
import SignatureEditor from './SignatureEditor.jsx';
import { getEffectiveShortcuts, getGroupedActions, ACTION_DEFS } from '../utils/defaultShortcuts.js';

// ─── Shared field component ───────────────────────────────────────────────────
function Field({ label, required, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
        {label} {required && <span style={{ color: 'var(--red)' }}>*</span>}
      </label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '9px 12px',
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13,
  outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box',
};

// ─── Color picker ─────────────────────────────────────────────────────────────
const COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#ef4444',
  '#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#14b8a6',
];

// ─── IMAP presets ─────────────────────────────────────────────────────────────
// Note: Microsoft 365 / Outlook is intentionally excluded here — it requires
// OAuth2 (not app passwords) and is handled via the Integrations tab instead.
const PRESETS = {
  gmail:   { label: 'Gmail',   imap_host: 'imap.gmail.com',   imap_port: 993, smtp_host: 'smtp.gmail.com',   smtp_port: 587 },
  icloud:  { label: 'iCloud',  imap_host: 'imap.mail.me.com', imap_port: 993, smtp_host: 'smtp.mail.me.com', smtp_port: 587 },
  custom:  { label: 'Custom' },
};

// ─── Account Form (Add or Edit) ───────────────────────────────────────────────
function AccountForm({ initial, onSave, onCancel }) {
  const isEdit = !!initial?.id;
  const [form, setForm] = useState(initial || {
    name: '', email_address: '', color: '#6366f1', protocol: 'imap',
    imap_host: '', imap_port: 993, imap_tls: true,
    smtp_host: '', smtp_port: 587, smtp_tls: 'STARTTLS',
    auth_user: '', auth_pass: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState(null);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const handlePreset = (key) => {
    const p = PRESETS[key];
    if (p.imap_host) setForm(f => ({ ...f, ...p, label: undefined }));
    setSelectedPreset(key);
  };

  const handleSubmit = async () => {
    if (!form.email_address || !form.auth_user || !form.imap_host) {
      setError('Email, username, and IMAP host are required');
      return;
    }
    if (!isEdit && !form.auth_pass) {
      setError('Password is required for new accounts');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(form);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div>
      {/* Presets (add only) */}
      {!isEdit && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
          {Object.entries(PRESETS).map(([key, p]) => {
            const active = selectedPreset === key;
            return (
              <button key={key} onClick={() => handlePreset(key)} style={{
                padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 500,
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'var(--accent-dim)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer', transition: 'all 0.12s',
              }}>
                {p.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Color */}
      <Field label="Account color">
        <div style={{ display: 'flex', gap: 6 }}>
          {COLORS.map(c => (
            <button key={c} onClick={() => set('color', c)} style={{
              width: 24, height: 24, borderRadius: '50%', background: c,
              border: `2px solid ${form.color === c ? 'white' : 'transparent'}`,
              cursor: 'pointer', outline: 'none', padding: 0,
              boxShadow: form.color === c ? `0 0 0 1px ${c}` : 'none',
            }} />
          ))}
        </div>
      </Field>

      <Field label="Display name" required>
        <input value={form.name || ''} onChange={e => set('name', e.target.value)}
          placeholder="e.g. Work Gmail" style={inputStyle}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'} />
      </Field>

      {!isEdit && (
        <Field label="Email address" required>
          <input value={form.email_address || ''} onChange={e => set('email_address', e.target.value)}
            placeholder="you@example.com" style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
      )}

      <Field label="Username (IMAP login)" required>
        <input value={form.auth_user || ''} onChange={e => set('auth_user', e.target.value)}
          placeholder="Usually your email address" style={inputStyle}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'} />
      </Field>

      <Field label={isEdit ? 'New password (leave blank to keep current)' : 'Password / App password'} required={!isEdit}>
        <div style={{ position: 'relative' }}>
          <input type={showPass ? 'text' : 'password'}
            value={form.auth_pass || ''} onChange={e => set('auth_pass', e.target.value)}
            placeholder={isEdit ? '••••••••' : 'App password'}
            style={{ ...inputStyle, paddingRight: 36 }}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
          <button onClick={() => setShowPass(!showPass)} style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
            display: 'flex', padding: 2,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {showPass
                ? <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>
                : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
              }
            </svg>
          </button>
        </div>
      </Field>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }} />
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        IMAP Settings
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 10 }}>
        <Field label="IMAP Host" required>
          <input value={form.imap_host || ''} onChange={e => set('imap_host', e.target.value)}
            placeholder="imap.gmail.com" style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
        <Field label="Port">
          <input type="number" value={form.imap_port || 993} onChange={e => set('imap_port', parseInt(e.target.value))}
            style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
      </div>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0 16px' }} />
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        SMTP Settings
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 10 }}>
        <Field label="SMTP Host">
          <input value={form.smtp_host || ''} onChange={e => set('smtp_host', e.target.value)}
            placeholder="smtp.gmail.com" style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
        <Field label="Port">
          <input type="number" value={form.smtp_port || 587} onChange={e => set('smtp_port', parseInt(e.target.value))}
            style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
      </div>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }} />
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        Signature
      </div>
      <SignatureEditor
        value={form.signature || ''}
        onChange={val => set('signature', val)}
      />

      {error && (
        <div style={{
          padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
          border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8,
          color: 'var(--red)', fontSize: 13, marginBottom: 14,
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button onClick={handleSubmit} disabled={saving} style={{
          flex: 1, padding: '10px', background: 'var(--accent)',
          border: 'none', borderRadius: 8, color: 'white',
          fontSize: 13, fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer',
          opacity: saving ? 0.7 : 1,
        }}>
          {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Add account')}
        </button>
        <button onClick={onCancel} style={{
          padding: '10px 16px', background: 'var(--bg-tertiary)',
          border: '1px solid var(--border)', borderRadius: 8,
          color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13,
        }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Accounts Tab ─────────────────────────────────────────────────────────────
function AccountsTab() {
  const { accounts, setAccounts, updateAccount } = useStore();
  const [subview, setSubview] = useState('list'); // 'list' | 'add' | 'edit' | 'folders' | 'aliases'
  const [editTarget, setEditTarget] = useState(null);
  const [folderMappings, setFolderMappings] = useState({});
  const [availableFolders, setAvailableFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersSaving, setFoldersSaving] = useState(false);

  // Alias form state
  const [aliasFormMode, setAliasFormMode] = useState(null); // null | 'add' | 'edit'
  const [aliasFormData, setAliasFormData] = useState({ name: '', email: '', reply_to: '', signature: '' });
  const [aliasFormId, setAliasFormId] = useState(null);
  const [aliasFormError, setAliasFormError] = useState('');
  const [aliasFormSaving, setAliasFormSaving] = useState(false);

  const handleAdd = async (form) => {
    const account = await api.addAccount(form);
    setAccounts([...accounts, account]);
    setSubview('list');
  };

  const handleEdit = async (form) => {
    const updates = { name: form.name, color: form.color, smtp_host: form.smtp_host, smtp_port: form.smtp_port, signature: form.signature || null };
    if (form.auth_pass) updates.auth_pass = form.auth_pass;
    if (form.auth_user) updates.auth_user = form.auth_user;
    await api.updateAccount(editTarget.id, updates);
    updateAccount(editTarget.id, updates);
    setSubview('list');
    setEditTarget(null);
  };

  const handleDelete = async (id) => {
    if (!confirm('Remove this account? All synced messages will be deleted.')) return;
    await api.deleteAccount(id);
    setAccounts(accounts.filter(a => a.id !== id));
  };

  const handleReconnect = async (id) => {
    await api.reconnectAccount(id);
    updateAccount(id, { sync_error: null });
  };

  const handleFolderMappingOpen = async (account) => {
    setEditTarget(account);
    setFolderMappings(account.folder_mappings || {});
    setSubview('folders');
    setFoldersLoading(true);
    try {
      const folders = await api.getFolders(account.id);
      setAvailableFolders(folders);
    } catch (err) {
      console.error('Failed to load folders:', err);
    } finally {
      setFoldersLoading(false);
    }
  };

  const handleFolderMappingsSave = async () => {
    setFoldersSaving(true);
    try {
      const cleanMappings = {};
      for (const [key, val] of Object.entries(folderMappings)) {
        if (val) cleanMappings[key] = val;
      }
      await api.updateAccount(editTarget.id, { folder_mappings: cleanMappings });
      updateAccount(editTarget.id, { folder_mappings: cleanMappings });
      setSubview('list');
      setEditTarget(null);
    } catch (err) {
      console.error('Failed to save folder mappings:', err);
    } finally {
      setFoldersSaving(false);
    }
  };

  const handleAliasOpen = (account) => {
    setEditTarget(account);
    setAliasFormMode(null);
    setAliasFormData({ name: '', email: '', reply_to: '', signature: '' });
    setAliasFormError('');
    setSubview('aliases');
  };

  const handleAliasSave = async () => {
    if (!aliasFormData.name || !aliasFormData.email) {
      setAliasFormError('Name and email are required');
      return;
    }
    setAliasFormSaving(true);
    setAliasFormError('');
    try {
      const payload = {
        name: aliasFormData.name,
        email: aliasFormData.email,
        reply_to: aliasFormData.reply_to || null,
        signature: aliasFormData.signature || null,
      };
      let saved;
      if (aliasFormMode === 'add') {
        saved = await api.addAlias(editTarget.id, payload);
        const newAliases = [...(editTarget.aliases || []), saved];
        updateAccount(editTarget.id, { aliases: newAliases });
        setEditTarget(t => ({ ...t, aliases: newAliases }));
      } else {
        saved = await api.updateAlias(editTarget.id, aliasFormId, payload);
        const newAliases = (editTarget.aliases || []).map(a => a.id === aliasFormId ? saved : a);
        updateAccount(editTarget.id, { aliases: newAliases });
        setEditTarget(t => ({ ...t, aliases: newAliases }));
      }
      setAliasFormMode(null);
      setAliasFormData({ name: '', email: '', reply_to: '', signature: '' });
      setAliasFormId(null);
    } catch (err) {
      setAliasFormError(err.message);
    } finally {
      setAliasFormSaving(false);
    }
  };

  const handleAliasEdit = (alias) => {
    setAliasFormId(alias.id);
    setAliasFormData({
      name: alias.name,
      email: alias.email,
      reply_to: alias.reply_to || '',
      signature: alias.signature || '',
    });
    setAliasFormError('');
    setAliasFormMode('edit');
  };

  const handleAliasDelete = async (aliasId) => {
    if (!confirm('Delete this alias? This cannot be undone.')) return;
    await api.deleteAlias(editTarget.id, aliasId);
    const newAliases = (editTarget.aliases || []).filter(a => a.id !== aliasId);
    updateAccount(editTarget.id, { aliases: newAliases });
    setEditTarget(t => ({ ...t, aliases: newAliases }));
  };

  if (subview === 'add') {
    return (
      <div>
        <button onClick={() => setSubview('list')} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', color: 'var(--text-secondary)',
          cursor: 'pointer', fontSize: 13, padding: '0 0 16px 0',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Back to accounts
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>
          Add account
        </div>
        <AccountForm onSave={handleAdd} onCancel={() => setSubview('list')} />
      </div>
    );
  }

  if (subview === 'edit' && editTarget) {
    return (
      <div>
        <button onClick={() => { setSubview('list'); setEditTarget(null); }} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', color: 'var(--text-secondary)',
          cursor: 'pointer', fontSize: 13, padding: '0 0 16px 0',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Back to accounts
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Edit account
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 20 }}>
          {editTarget.email_address}
        </div>
        <AccountForm initial={editTarget} onSave={handleEdit} onCancel={() => { setSubview('list'); setEditTarget(null); }} />
      </div>
    );
  }

  if (subview === 'aliases' && editTarget) {
    const backBtn = (
      <button onClick={() => { setSubview('list'); setEditTarget(null); setAliasFormMode(null); setAliasFormError(''); }} style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'none', border: 'none', color: 'var(--text-secondary)',
        cursor: 'pointer', fontSize: 13, padding: '0 0 16px 0',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Back to accounts
      </button>
    );

    if (aliasFormMode) {
      return (
        <div>
          {backBtn}
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {aliasFormMode === 'add' ? 'New alias' : 'Edit alias'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 20 }}>
            {editTarget.email_address}
          </div>

          <Field label="Display name" required>
            <input value={aliasFormData.name} onChange={e => setAliasFormData(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Support Team" style={inputStyle}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'} />
          </Field>
          <Field label="Email address" required>
            <input value={aliasFormData.email} onChange={e => setAliasFormData(f => ({ ...f, email: e.target.value }))}
              placeholder="support@example.com" style={inputStyle}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'} />
          </Field>
          <Field label="Reply-To (optional)">
            <input value={aliasFormData.reply_to} onChange={e => setAliasFormData(f => ({ ...f, reply_to: e.target.value }))}
              placeholder="Leave blank to use the alias address" style={inputStyle}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'} />
          </Field>

          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }} />
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Signature
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>
            Optional — leave blank to inherit the account signature.
          </div>
          <SignatureEditor
            value={aliasFormData.signature}
            onChange={val => setAliasFormData(f => ({ ...f, signature: val }))}
          />

          {aliasFormError && (
            <div style={{
              padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
              border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8,
              color: 'var(--red)', fontSize: 13, marginBottom: 14,
            }}>
              {aliasFormError}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button onClick={handleAliasSave} disabled={aliasFormSaving} style={{
              flex: 1, padding: '10px', background: 'var(--accent)',
              border: 'none', borderRadius: 8, color: 'white',
              fontSize: 13, fontWeight: 500, cursor: aliasFormSaving ? 'not-allowed' : 'pointer',
              opacity: aliasFormSaving ? 0.7 : 1,
            }}>
              {aliasFormSaving ? 'Saving…' : 'Save alias'}
            </button>
            <button onClick={() => { setAliasFormMode(null); setAliasFormError(''); }} style={{
              padding: '10px 16px', background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)', borderRadius: 8,
              color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13,
            }}>
              Cancel
            </button>
          </div>
        </div>
      );
    }

    const aliases = editTarget.aliases || [];
    return (
      <div>
        {backBtn}
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Aliases
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
          {editTarget.email_address}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
          Aliases let you send from a different name or address using this account's SMTP credentials. Select an alias in the <strong>From</strong> field when composing. MailFlow will automatically reply from an alias if a message was addressed to it.
        </div>

        <button
          onClick={() => { setAliasFormData({ name: '', email: '', reply_to: '', signature: '' }); setAliasFormMode('add'); }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 12px', background: 'var(--accent)',
            border: 'none', borderRadius: 7, color: 'white',
            cursor: 'pointer', fontSize: 12, fontWeight: 500, marginBottom: 16,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add alias
        </button>

        {aliases.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
            No aliases yet
          </div>
        ) : (
          aliases.map(alias => (
            <div key={alias.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 14px', marginBottom: 8,
              border: '1px solid var(--border-subtle)', borderRadius: 10,
              background: 'var(--bg-tertiary)',
            }}>
              <div style={{
                width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                background: 'var(--bg-hover)', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <circle cx="12" cy="8" r="4"/>
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {alias.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1 }}>
                  {alias.email}
                </div>
                {alias.reply_to && (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
                    Reply-To: {alias.reply_to}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <IconBtn onClick={() => handleAliasEdit(alias)} title="Edit alias">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </IconBtn>
                <IconBtn onClick={() => handleAliasDelete(alias.id)} title="Delete alias" danger>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                  </svg>
                </IconBtn>
              </div>
            </div>
          ))
        )}
      </div>
    );
  }

  if (subview === 'folders' && editTarget) {
    const FOLDER_ROLES = [
      { key: 'sent',    label: 'Sent',        specialUse: '\\Sent' },
      { key: 'drafts',  label: 'Drafts',      specialUse: '\\Drafts' },
      { key: 'trash',   label: 'Trash',       specialUse: '\\Trash' },
      { key: 'spam',    label: 'Spam / Junk', specialUse: '\\Junk' },
      { key: 'archive', label: 'Archive',     specialUse: '\\Archive' },
    ];
    const selectStyle = {
      width: '100%', padding: '8px 10px',
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 7, color: 'var(--text-primary)', fontSize: 13,
      outline: 'none', cursor: 'pointer',
    };
    return (
      <div>
        <button onClick={() => { setSubview('list'); setEditTarget(null); }} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', color: 'var(--text-secondary)',
          cursor: 'pointer', fontSize: 13, padding: '0 0 16px 0',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Back to accounts
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Folder mappings
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 20 }}>
          {editTarget.email_address}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
          Map each mail role to a specific folder. Select <strong>Auto-detect</strong> to let MailFlow use the folder your server has tagged for that role.
        </div>
        {foldersLoading ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
            Loading folders…
          </div>
        ) : (
          FOLDER_ROLES.map(role => {
            const autoFolder = availableFolders.find(f => f.special_use === role.specialUse);
            return (
              <div key={role.key} style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
                  {role.label}
                </label>
                <select
                  value={folderMappings[role.key] || ''}
                  onChange={e => setFolderMappings(m => ({ ...m, [role.key]: e.target.value }))}
                  style={selectStyle}
                >
                  <option value="" style={{ background: 'var(--bg-tertiary)' }}>
                    {autoFolder ? `Auto-detect (${autoFolder.path})` : 'Auto-detect (none found)'}
                  </option>
                  {availableFolders.map(f => (
                    <option key={f.path} value={f.path} style={{ background: 'var(--bg-tertiary)' }}>
                      {f.path}
                    </option>
                  ))}
                </select>
              </div>
            );
          })
        )}
        <button
          onClick={handleFolderMappingsSave}
          disabled={foldersSaving || foldersLoading}
          style={{
            marginTop: 8, padding: '9px 20px', background: 'var(--accent)',
            border: 'none', borderRadius: 7, color: 'white',
            fontSize: 13, fontWeight: 500, cursor: (foldersSaving || foldersLoading) ? 'not-allowed' : 'pointer',
            opacity: (foldersSaving || foldersLoading) ? 0.7 : 1,
          }}
        >
          {foldersSaving ? 'Saving…' : 'Save mappings'}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          Email accounts
        </div>
        <button onClick={() => setSubview('add')} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '7px 12px', background: 'var(--accent)',
          border: 'none', borderRadius: 7, color: 'white',
          cursor: 'pointer', fontSize: 12, fontWeight: 500,
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Add account
        </button>
      </div>

      {accounts.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-tertiary)', fontSize: 14 }}>
          No accounts added yet
        </div>
      )}

      {accounts.map(account => (
        <div key={account.id} style={{
          border: '1px solid var(--border-subtle)', borderRadius: 10,
          background: 'var(--bg-tertiary)', marginBottom: 10, overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
            <div style={{
              width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
              background: account.color, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 15, fontWeight: 600, color: 'white',
            }}>
              {account.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                {account.name}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1 }}>
                {account.email_address}
              </div>
              <div style={{ fontSize: 11, marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
                {account.sync_error ? (
                  <span style={{
                    color: 'var(--red)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>⚠ {account.sync_error}</span>
                ) : (
                  <>
                    <span style={{ color: 'var(--green)' }}>● Connected</span>
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {account.imap_host}:{account.imap_port}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {account.sync_error && (
                <IconBtn onClick={() => handleReconnect(account.id)} title="Reconnect">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                  </svg>
                </IconBtn>
              )}
              <IconBtn onClick={() => { setEditTarget(account); setSubview('edit'); }} title="Edit">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </IconBtn>
              <IconBtn onClick={() => handleFolderMappingOpen(account)} title="Folder mappings">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
              </IconBtn>
              <IconBtn onClick={() => handleAliasOpen(account)} title="Aliases">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="8" r="4"/>
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </IconBtn>
              <IconBtn onClick={() => handleDelete(account.id)} title="Remove" danger>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                </svg>
              </IconBtn>
            </div>
          </div>

          {/* Connection details bar */}
          <div style={{
            padding: '8px 14px', borderTop: '1px solid var(--border-subtle)',
            background: 'var(--bg-secondary)',
            display: 'flex', gap: 20, flexWrap: 'wrap',
          }}>
            {[
              ['IMAP', `${account.imap_host}:${account.imap_port}`],
              ['SMTP', `${account.smtp_host}:${account.smtp_port}`],
              ['Last sync', account.last_sync ? new Date(account.last_sync).toLocaleTimeString() : 'Never'],
            ].map(([label, val]) => (
              <div key={label} style={{ fontSize: 11 }}>
                <span style={{ color: 'var(--text-tertiary)' }}>{label} </span>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono, monospace' }}>{val}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Themes Tab ───────────────────────────────────────────────────────────────
function ThemesTab() {
  const { theme, setTheme } = useStore();

  const handleSelect = (key) => {
    setTheme(key);
    applyTheme(key);
  };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Appearance
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        Choose a color theme for the interface
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {Object.entries(THEMES).map(([key, t]) => (
          <button
            key={key}
            onClick={() => handleSelect(key)}
            style={{
              background: theme === key ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
              border: `2px solid ${theme === key ? 'var(--accent)' : 'var(--border-subtle)'}`,
              borderRadius: 10, padding: '12px', cursor: 'pointer',
              textAlign: 'left', transition: 'all 0.15s',
              outline: 'none',
            }}
            onMouseEnter={e => { if (theme !== key) e.currentTarget.style.borderColor = 'var(--border)'; }}
            onMouseLeave={e => { if (theme !== key) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
          >
            {/* Color swatches */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
              {t.preview.map((c, i) => (
                <div key={i} style={{
                  flex: i === 0 ? 2 : 1, height: 28, borderRadius: 5,
                  background: c,
                  border: '1px solid rgba(255,255,255,0.1)',
                }} />
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {t.label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {t.description}
                </div>
              </div>
              {theme === key && (
                <div style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: 'var(--accent)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Admin Panel Shell ────────────────────────────────────────────────────────
function IconBtn({ children, onClick, title, danger }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick} title={title}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: hov ? (danger ? 'rgba(248,113,113,0.1)' : 'var(--bg-hover)') : 'transparent',
        border: `1px solid ${hov ? (danger ? 'rgba(248,113,113,0.3)' : 'var(--border)') : 'transparent'}`,
        borderRadius: 6, padding: '5px', color: danger && hov ? 'var(--red)' : 'var(--text-tertiary)',
        cursor: 'pointer', display: 'flex', alignItems: 'center', transition: 'all 0.1s',
      }}
    >
      {children}
    </button>
  );
}

// ─── Fonts Tab ───────────────────────────────────────────────────────────────
function FontsTab() {
  const { fontSet, setFontSet } = useStore();
  const [fontsReady, setFontsReady] = useState(false);

  const handleSelect = (key) => {
    setFontSet(key);
  };

  // Load Google Fonts for every set so specimens render in their own typefaces.
  // Use document.fonts.ready (the proper font-loading API) plus a minimum 500ms
  // so newly-appended <link> tags have time to register their @font-face rules
  // before the promise resolves. A 4s fallback handles blocked or slow loads.
  useEffect(() => {
    Object.keys(FONT_SETS).forEach(k => loadFontSet(k));
    let done = false;
    const finish = () => { if (!done) { done = true; setFontsReady(true); } };
    Promise.all([
      document.fonts.ready,
      new Promise(r => setTimeout(r, 500)),
    ]).then(finish);
    const fallback = setTimeout(finish, 4000);
    return () => clearTimeout(fallback);
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          Typography
        </div>
        {!fontsReady && (
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Loading fonts…</div>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        Choose a font pairing for the interface
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Object.entries(FONT_SETS).map(([key, set]) => {
          const isActive = fontSet === key;
          return (
            <button
              key={key}
              onClick={() => handleSelect(key)}
              style={{
                background: isActive ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                border: `2px solid ${isActive ? 'var(--accent)' : 'var(--border-subtle)'}`,
                borderRadius: 10, padding: '14px 16px', cursor: 'pointer',
                textAlign: 'left', transition: 'all 0.15s', outline: 'none',
                display: 'flex', alignItems: 'center', gap: 16,
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.borderColor = 'var(--border)'; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
            >
              {/* Font specimen */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: set.vars['--font-display'],
                  fontSize: 22, fontWeight: 400, lineHeight: 1.1,
                  color: 'var(--text-primary)', marginBottom: 4,
                  letterSpacing: '-0.01em',
                }}>
                  {set.label}
                </div>
                <div style={{
                  fontFamily: set.vars['--font-sans'],
                  fontSize: 12, color: 'var(--text-tertiary)',
                  marginBottom: 8,
                }}>
                  {set.description}
                </div>
                {/* Specimen text */}
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    <span style={{ color: 'var(--text-tertiary)', marginRight: 4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Display
                    </span>
                    <span style={{
                      fontFamily: set.vars['--font-display'],
                      color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                      fontSize: 13,
                    }}>
                      {set.preview.heading}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    <span style={{ color: 'var(--text-tertiary)', marginRight: 4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Body
                    </span>
                    <span style={{
                      fontFamily: set.vars['--font-sans'],
                      color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                      fontSize: 13,
                    }}>
                      {set.preview.body}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    <span style={{ color: 'var(--text-tertiary)', marginRight: 4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Mono
                    </span>
                    <span style={{
                      fontFamily: set.vars['--font-mono'],
                      color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                      fontSize: 12,
                    }}>
                      {set.preview.mono}
                    </span>
                  </div>
                </div>
              </div>

              {/* Active check */}
              {isActive && (
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                  background: 'var(--accent)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Layout Diagram ───────────────────────────────────────────────────────────
function LayoutDiagram({ layoutKey, layoutConfig, active }) {
  const isColumn = layoutConfig.direction === 'column';
  const accent = active ? 'var(--accent)' : 'var(--border)';
  const bg1 = active ? 'var(--accent-dim)' : 'var(--bg-elevated)';
  const bg2 = active ? 'rgba(124,106,247,0.08)' : 'var(--bg-tertiary)';

  // Sidebar width fraction (always ~15% of diagram)
  const sw = 14;
  // List width fraction: derived from listWidth relative to 340 baseline
  const lw = isColumn ? 50 : Math.round(10 + (layoutConfig.listWidth / 460) * 32);
  const rw = 72 - lw; // reading pane width

  if (isColumn) {
    // Vertical split: sidebar left, right side has list on top + reading pane below
    return (
      <svg width="80" height="52" viewBox="0 0 80 52" xmlns="http://www.w3.org/2000/svg">
        {/* Outer border */}
        <rect x="0.5" y="0.5" width="79" height="51" rx="4" fill="var(--bg-secondary)" stroke={accent} strokeWidth={active ? 1.5 : 1}/>
        {/* Sidebar */}
        <rect x="1" y="1" width={sw} height="50" rx="3" fill={bg1}/>
        {/* List (top half of content) */}
        <rect x={sw + 2} y="1" width={72} height="24" fill={bg2}/>
        {/* Reading pane (bottom half) */}
        <rect x={sw + 2} y="27" width={72} height="24" fill="var(--bg-secondary)"/>
        {/* Divider */}
        <line x1={sw + 2} y1="26" x2="79" y2="26" stroke={accent} strokeWidth="0.8"/>
        {/* Sidebar lines */}
        <rect x="4" y="8" width={sw - 6} height="2" rx="1" fill={accent} opacity="0.5"/>
        <rect x="4" y="14" width={sw - 8} height="2" rx="1" fill={accent} opacity="0.3"/>
        <rect x="4" y="20" width={sw - 7} height="2" rx="1" fill={accent} opacity="0.3"/>
        {/* List rows */}
        <rect x={sw + 5} y="5" width="30" height="1.5" rx="0.75" fill={accent} opacity="0.5"/>
        <rect x={sw + 5} y="9" width="45" height="1.5" rx="0.75" fill={accent} opacity="0.3"/>
        <rect x={sw + 5} y="14" width="28" height="1.5" rx="0.75" fill={accent} opacity="0.4"/>
        <rect x={sw + 5} y="18" width="40" height="1.5" rx="0.75" fill={accent} opacity="0.25"/>
        {/* Reading pane lines */}
        <rect x={sw + 5} y="31" width="40" height="2" rx="1" fill={accent} opacity="0.4"/>
        <rect x={sw + 5} y="36" width="55" height="1.5" rx="0.75" fill={accent} opacity="0.2"/>
        <rect x={sw + 5} y="40" width="50" height="1.5" rx="0.75" fill={accent} opacity="0.2"/>
        <rect x={sw + 5} y="44" width="35" height="1.5" rx="0.75" fill={accent} opacity="0.15"/>
      </svg>
    );
  }

  return (
    <svg width="80" height="52" viewBox="0 0 80 52" xmlns="http://www.w3.org/2000/svg">
      {/* Outer border */}
      <rect x="0.5" y="0.5" width="79" height="51" rx="4" fill="var(--bg-secondary)" stroke={accent} strokeWidth={active ? 1.5 : 1}/>
      {/* Sidebar */}
      <rect x="1" y="1" width={sw} height="50" rx="3" fill={bg1}/>
      {/* Message list */}
      <rect x={sw + 2} y="1" width={lw} height="50" fill={bg2}/>
      {/* Reading pane */}
      <rect x={sw + lw + 3} y="1" width={rw - 3} height="50" fill="var(--bg-secondary)"/>
      {/* Dividers */}
      <line x1={sw + 1} y1="1" x2={sw + 1} y2="51" stroke={accent} strokeWidth="0.8"/>
      <line x1={sw + lw + 2} y1="1" x2={sw + lw + 2} y2="51" stroke={accent} strokeWidth="0.8"/>
      {/* Sidebar lines */}
      <rect x="3" y="8" width={sw - 4} height="1.5" rx="0.75" fill={accent} opacity="0.5"/>
      <rect x="3" y="13" width={sw - 6} height="1.5" rx="0.75" fill={accent} opacity="0.3"/>
      <rect x="3" y="18" width={sw - 5} height="1.5" rx="0.75" fill={accent} opacity="0.3"/>
      <rect x="3" y="23" width={sw - 7} height="1.5" rx="0.75" fill={accent} opacity="0.2"/>
      {/* List rows */}
      <rect x={sw + 4} y="5" width={lw - 6} height="1.5" rx="0.75" fill={accent} opacity="0.6"/>
      <rect x={sw + 4} y="9" width={lw - 4} height="1" rx="0.5" fill={accent} opacity="0.3"/>
      <line x1={sw + 2} y1="13" x2={sw + lw + 1} y2="13" stroke={accent} strokeWidth="0.5" opacity="0.3"/>
      <rect x={sw + 4} y="15" width={lw - 7} height="1.5" rx="0.75" fill={accent} opacity="0.5"/>
      <rect x={sw + 4} y="19" width={lw - 4} height="1" rx="0.5" fill={accent} opacity="0.25"/>
      <line x1={sw + 2} y1="23" x2={sw + lw + 1} y2="23" stroke={accent} strokeWidth="0.5" opacity="0.3"/>
      <rect x={sw + 4} y="25" width={lw - 6} height="1.5" rx="0.75" fill={accent} opacity="0.45"/>
      <rect x={sw + 4} y="29" width={lw - 5} height="1" rx="0.5" fill={accent} opacity="0.2"/>
      {/* Reading pane content */}
      <rect x={sw + lw + 5} y="7" width={rw - 10} height="2.5" rx="1" fill={accent} opacity="0.5"/>
      <rect x={sw + lw + 5} y="13" width={rw - 8} height="1.5" rx="0.75" fill={accent} opacity="0.2"/>
      <rect x={sw + lw + 5} y="17" width={rw - 12} height="1.5" rx="0.75" fill={accent} opacity="0.2"/>
      <rect x={sw + lw + 5} y="21" width={rw - 9} height="1.5" rx="0.75" fill={accent} opacity="0.15"/>
      <rect x={sw + lw + 5} y="25" width={rw - 14} height="1.5" rx="0.75" fill={accent} opacity="0.15"/>
    </svg>
  );
}

// ─── Layouts Tab ──────────────────────────────────────────────────────────────
function LayoutsTab() {
  const { layout, setLayout, pageSize, setPageSize, scrollMode, setScrollMode, syncInterval, setSyncInterval } = useStore();

  const handleSelect = (key) => {
    setLayout(key);
    applyLayout(key);
  };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Layout
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        Choose how the sidebar, message list, and reading pane are arranged
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {Object.entries(LAYOUTS).map(([key, l]) => {
          const isActive = layout === key;
          return (
            <button
              key={key}
              onClick={() => handleSelect(key)}
              style={{
                background: isActive ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                border: `2px solid ${isActive ? 'var(--accent)' : 'var(--border-subtle)'}`,
                borderRadius: 10, padding: '14px', cursor: 'pointer',
                textAlign: 'left', transition: 'all 0.15s', outline: 'none',
                display: 'flex', alignItems: 'center', gap: 14,
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.borderColor = 'var(--border)'; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
            >
              <div style={{ flexShrink: 0 }}>
                <LayoutDiagram layoutKey={key} layoutConfig={l} active={isActive} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {l.label}
                  </div>
                  {isActive && (
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                      background: 'var(--accent)', display: 'flex',
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.4 }}>
                  {l.description}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Message list behaviour */}
      <div style={{ marginTop: 28, paddingTop: 22, borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
          Message List
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Scrolling mode</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { id: 'infinite',   label: 'Infinite scroll', desc: 'Auto-loads as you scroll down' },
              { id: 'paginated',  label: 'Paginated',       desc: 'Navigate with Prev / Next buttons' },
            ].map(({ id, label, desc }) => {
              const active = scrollMode === id;
              return (
                <button
                  key={id}
                  onClick={() => setScrollMode(id)}
                  style={{
                    flex: 1, padding: '10px 12px', textAlign: 'left',
                    background: active ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                    border: `2px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    borderRadius: 8, cursor: 'pointer', transition: 'all 0.15s', outline: 'none',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border)'; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
                >
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{desc}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {scrollMode === 'paginated' ? 'Emails per page' : 'Emails loaded per batch'}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[25, 50, 100, 200].map(n => {
              const active = pageSize === n;
              return (
                <button
                  key={n}
                  onClick={() => setPageSize(n)}
                  style={{
                    flex: 1, padding: '7px 4px', fontSize: 13, fontWeight: 500,
                    background: active ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                    border: `2px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    borderRadius: 7, cursor: 'pointer', transition: 'all 0.15s', outline: 'none',
                    color: active ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border)'; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
                >
                  {n}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Sync interval */}
      <div style={{ marginTop: 28, paddingTop: 22, borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Sync Frequency
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
          How often mailflow checks for new emails
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { value: 15,  label: '15s' },
            { value: 30,  label: '30s' },
            { value: 60,  label: '60s' },
            { value: 120, label: '2 min' },
          ].map(({ value, label }) => {
            const active = syncInterval === value;
            return (
              <button
                key={value}
                onClick={() => setSyncInterval(value)}
                style={{
                  flex: 1, padding: '7px 4px', fontSize: 13, fontWeight: 500,
                  background: active ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                  border: `2px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
                  borderRadius: 7, cursor: 'pointer', transition: 'all 0.15s', outline: 'none',
                  color: active ? 'var(--accent)' : 'var(--text-secondary)',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border)'; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Integrations Tab ────────────────────────────────────────────────────────
function IntegrationsTab() {
  const { setAccounts } = useStore();
  const [configs, setConfigs] = useState({});
  const [loading, setLoading] = useState(true);
  const [msForm, setMsForm] = useState({ clientId: '', clientSecret: '', tenantId: '', redirectUri: '' });
  const [msExpanded, setMsExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [connectingMs, setConnectingMs] = useState(false);

  useEffect(() => {
    api.getIntegrations()
      .then(data => {
        setConfigs(data);
        if (data.microsoft) {
          setMsForm({
            clientId: data.microsoft.clientId || '',
            clientSecret: data.microsoft.clientSecret || '',
            tenantId: data.microsoft.tenantId || '',
            redirectUri: data.microsoft.redirectUri || '',
          });
          setMsExpanded(true);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    // Listen for oauth_success / oauth_error messages from the OAuth popup tab.
    // URL-param detection has been moved to MailApp so it works regardless of
    // which tab/modal is currently open.
    const handleMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === 'oauth_success' && e.data?.provider === 'microsoft') {
        setSaveMsg('Microsoft 365 account connected successfully! Check the Accounts tab.');
        setConnectingMs(false);
        // Reload both so the new account appears in the sidebar immediately
        api.getIntegrations().then(setConfigs).catch(console.error);
        api.getAccounts().then(setAccounts).catch(console.error);
      } else if (e.data?.type === 'oauth_error') {
        setSaveMsg('Error: ' + e.data.error);
        setConnectingMs(false);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleSaveMs = async () => {
    if (!msForm.clientId || !msForm.tenantId || !msForm.redirectUri) {
      setSaveMsg('Client ID, Tenant ID, and Redirect URI are required');
      return;
    }
    setSaving(true);
    setSaveMsg('');
    try {
      await api.saveIntegration('microsoft', msForm);
      // Update local state so "Connect account" button enables immediately
      // without requiring a page reload.
      setConfigs(prev => ({
        ...prev,
        microsoft: { clientId: msForm.clientId, tenantId: msForm.tenantId, redirectUri: msForm.redirectUri },
      }));
      setSaveMsg('Configuration saved. Click "Connect account" to authorize.');
    } catch (err) {
      setSaveMsg('Error: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleConnectMs = () => {
    setConnectingMs(true);
    // Use a real anchor click so the browser treats it as a normal navigation
    // window.open gets intercepted by some browser extensions (e.g. claude.ai in Zen)
    const a = document.createElement('a');
    a.href = '/oauth/microsoft';
    a.target = '_blank';
    a.rel = 'opener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => setConnectingMs(false), 5000);
  };

  const msConfigured = configs.microsoft?.clientId;

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Integrations
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 24 }}>
        Connect OAuth providers for accounts that don't support app passwords
      </div>

      {loading && <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>}

      {!loading && (
        <div>
          {/* Microsoft 365 */}
          <div style={{
            border: '1px solid var(--border-subtle)', borderRadius: 12,
            overflow: 'hidden', marginBottom: 12,
          }}>
            {/* Header */}
            <div
              onClick={() => setMsExpanded(!msExpanded)}
              style={{
                padding: '14px 16px', display: 'flex', alignItems: 'center',
                gap: 12, cursor: 'pointer', background: 'var(--bg-tertiary)',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
            >
              {/* Microsoft icon */}
              <svg width="20" height="20" viewBox="0 0 21 21" fill="none">
                <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
              </svg>

              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                  Microsoft 365 / Entra
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1 }}>
                  OAuth2 for work/school accounts that require modern authentication
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {msConfigured ? (
                  <span style={{
                    fontSize: 11, padding: '3px 8px', borderRadius: 20,
                    background: 'rgba(74,222,128,0.1)', color: 'var(--green)',
                    border: '1px solid rgba(74,222,128,0.2)', fontWeight: 500,
                  }}>
                    Configured
                  </span>
                ) : (
                  <span style={{
                    fontSize: 11, padding: '3px 8px', borderRadius: 20,
                    background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
                    border: '1px solid var(--border)',
                  }}>
                    Not configured
                  </span>
                )}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="var(--text-tertiary)" strokeWidth="2"
                  style={{ transform: msExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>
            </div>

            {/* Expanded form */}
            {msExpanded && (
              <div style={{ padding: '16px', borderTop: '1px solid var(--border-subtle)' }}>
                {/* Setup instructions */}
                <div style={{
                  padding: '12px 14px', borderRadius: 8, marginBottom: 16,
                  background: 'rgba(124,106,247,0.06)',
                  border: '1px solid rgba(124,106,247,0.15)',
                  fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7,
                }}>
                  <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: 6 }}>
                    Azure App Registration setup
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    <li>Go to <strong>portal.azure.com</strong> → Microsoft Entra ID → App registrations → New registration</li>
                    <li>Set redirect URI type to <strong>Web</strong> and paste the URI shown below</li>
                    <li>API permissions → Add a permission → <strong>APIs my organization uses</strong> → <em>Office 365 Exchange Online</em> → Delegated → <code>IMAP.AccessAsUser.All</code> and <code>SMTP.Send</code></li>
                    <li>API permissions → Add a permission → <strong>Microsoft Graph</strong> → Delegated → <code>offline_access</code>, <code>openid</code>, <code>email</code>, <code>profile</code></li>
                    <li>Click <strong>Grant admin consent</strong> for your organization</li>
                    <li>Certificates &amp; secrets → New client secret — copy the <em>Value</em> (not the ID)</li>
                  </ol>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <Field label="Application (Client) ID" required>
                    <input value={msForm.clientId} onChange={e => setMsForm(f => ({ ...f, clientId: e.target.value }))}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      style={{ ...inputStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                      onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                      onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                  </Field>
                  <Field label="Directory (Tenant) ID" required>
                    <input value={msForm.tenantId} onChange={e => setMsForm(f => ({ ...f, tenantId: e.target.value }))}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      style={{ ...inputStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                      onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                      onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                  </Field>
                </div>

                <Field label="Client Secret" required>
                  <input type="password" value={msForm.clientSecret}
                    onChange={e => setMsForm(f => ({ ...f, clientSecret: e.target.value }))}
                    placeholder="Client secret value from Azure"
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                </Field>

                <Field label="Redirect URI" required>
                  <input value={msForm.redirectUri}
                    onChange={e => setMsForm(f => ({ ...f, redirectUri: e.target.value }))}
                    placeholder={`http://${window.location.hostname}:8080/oauth/microsoft/callback`}
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>
                    This must exactly match the redirect URI registered in Azure. Suggested:&nbsp;
                    <code style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent)' }}>
                      {`${window.location.protocol}//${window.location.hostname}${window.location.port ? ':' + window.location.port : ''}/oauth/microsoft/callback`}
                    </code>
                  </div>
                </Field>

                {saveMsg && (
                  <div style={{
                    padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13,
                    background: saveMsg.startsWith('Error') ? 'rgba(248,113,113,0.1)' : 'rgba(74,222,128,0.1)',
                    border: `1px solid ${saveMsg.startsWith('Error') ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.2)'}`,
                    color: saveMsg.startsWith('Error') ? 'var(--red)' : 'var(--green)',
                  }}>
                    {saveMsg}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={handleSaveMs} disabled={saving} style={{
                    padding: '9px 16px', background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)', borderRadius: 8,
                    color: 'var(--text-primary)', cursor: saving ? 'not-allowed' : 'pointer',
                    fontSize: 13, fontWeight: 500, opacity: saving ? 0.7 : 1,
                  }}>
                    {saving ? 'Saving…' : 'Save configuration'}
                  </button>

                  <button
                    onClick={handleConnectMs}
                    disabled={!msConfigured || connectingMs}
                    title={!msConfigured ? 'Save configuration first' : ''}
                    style={{
                      padding: '9px 16px', background: msConfigured ? 'var(--accent)' : 'var(--bg-elevated)',
                      border: `1px solid ${msConfigured ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 8, color: msConfigured ? 'white' : 'var(--text-tertiary)',
                      cursor: msConfigured && !connectingMs ? 'pointer' : 'not-allowed',
                      fontSize: 13, fontWeight: 500,
                      opacity: !msConfigured || connectingMs ? 0.6 : 1,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 21 21" fill="none">
                      <rect x="1" y="1" width="9" height="9" fill="currentColor" opacity="0.9"/>
                      <rect x="11" y="1" width="9" height="9" fill="currentColor" opacity="0.7"/>
                      <rect x="1" y="11" width="9" height="9" fill="currentColor" opacity="0.7"/>
                      <rect x="11" y="11" width="9" height="9" fill="currentColor" opacity="0.5"/>
                    </svg>
                    {connectingMs ? 'Redirecting…' : 'Connect Microsoft account'}
                  </button>

                  {msConfigured && (
                    <button onClick={async () => {
                      await api.deleteIntegration('microsoft');
                      setConfigs(c => { const n = {...c}; delete n.microsoft; return n; });
                      setMsForm({ clientId: '', clientSecret: '', tenantId: '', redirectUri: '' });
                      setSaveMsg('');
                    }} style={{
                      padding: '9px 12px', background: 'transparent',
                      border: '1px solid transparent', borderRadius: 8,
                      color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 13,
                      marginLeft: 'auto',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)'; e.currentTarget.style.borderColor = 'rgba(248,113,113,0.3)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.borderColor = 'transparent'; }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Users Tab ────────────────────────────────────────────────────────────────
function UsersTab() {
  const { user: currentUser } = useStore();
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [regOpen, setRegOpen] = useState(null); // null = loading
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteMsg, setInviteMsg] = useState(null); // { type: 'ok'|'error', text, url? }
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    Promise.all([
      api.admin.getUsers(),
      api.admin.getSettings(),
      api.admin.getInvites(),
    ]).then(([usersData, settingsData, invitesData]) => {
      setUsers(usersData.users);
      setRegOpen(settingsData.settings.registration_open === 'true');
      setInvites(invitesData.invites);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const handleToggleAdmin = async (u) => {
    const newVal = !u.isAdmin;
    await api.admin.updateUser(u.id, { isAdmin: newVal });
    setUsers(us => us.map(x => x.id === u.id ? { ...x, isAdmin: newVal } : x));
  };

  const handleDeleteUser = async (u) => {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    await api.admin.deleteUser(u.id);
    setUsers(us => us.filter(x => x.id !== u.id));
  };

  const handleToggleReg = async () => {
    const newVal = !regOpen;
    await api.admin.updateSettings({ registration_open: newVal });
    setRegOpen(newVal);
  };

  const handleSendInvite = async () => {
    if (!inviteEmail.includes('@')) return;
    setInviteLoading(true);
    setInviteMsg(null);
    try {
      const data = await api.admin.createInvite(inviteEmail);
      setInviteEmail('');
      if (data.emailSent) {
        setInviteMsg({ type: 'ok', text: `Invite sent to ${inviteEmail}`, url: data.inviteUrl });
      } else {
        setInviteMsg({ type: 'ok', text: 'Invite created (email not sent — no SMTP account configured).', url: data.inviteUrl });
      }
      // Reload invites to get proper data from server
      api.admin.getInvites().then(d => setInvites(d.invites)).catch(() => {});
    } catch (err) {
      setInviteMsg({ type: 'error', text: err.message });
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRevokeInvite = async (id) => {
    await api.admin.deleteInvite(id);
    setInvites(inv => inv.filter(i => i.id !== id));
  };

  const copyInviteUrl = (url, id) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  if (loading) {
    return <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>;
  }

  const pendingInvites = invites.filter(i => !i.used_at && new Date(i.expires_at) > new Date());
  const usedOrExpiredInvites = invites.filter(i => i.used_at || new Date(i.expires_at) <= new Date());

  return (
    <div>
      {/* ── Users ── */}
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Users
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        Manage user accounts and admin privileges
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 28 }}>
        {users.map(u => (
          <div key={u.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px', borderRadius: 8,
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
              background: u.isAdmin ? 'var(--accent)' : 'var(--bg-elevated)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 600, color: u.isAdmin ? 'white' : 'var(--text-secondary)',
              border: '1px solid var(--border)',
            }}>
              {u.username[0].toUpperCase()}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {u.username}
                </span>
                {u.isAdmin && (
                  <span style={{
                    fontSize: 10, padding: '2px 6px', borderRadius: 20,
                    background: 'rgba(124,106,247,0.15)', color: 'var(--accent)',
                    border: '1px solid rgba(124,106,247,0.25)', fontWeight: 600,
                    letterSpacing: '0.04em', textTransform: 'uppercase',
                  }}>
                    Admin
                  </span>
                )}
                {u.id === currentUser?.id && (
                  <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>(you)</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
                Joined {new Date(u.created_at).toLocaleDateString()}
              </div>
            </div>

            {u.id !== currentUser?.id && (
              <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                <button
                  onClick={() => handleToggleAdmin(u)}
                  title={u.isAdmin ? 'Remove admin' : 'Make admin'}
                  style={{
                    padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500,
                    border: '1px solid var(--border)',
                    background: u.isAdmin ? 'var(--bg-elevated)' : 'transparent',
                    color: u.isAdmin ? 'var(--text-secondary)' : 'var(--accent)',
                    cursor: 'pointer', transition: 'all 0.1s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
                >
                  {u.isAdmin ? 'Remove admin' : 'Make admin'}
                </button>
                <IconBtn onClick={() => handleDeleteUser(u)} title="Delete user" danger>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                  </svg>
                </IconBtn>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Registration ── */}
      <div style={{ height: 1, background: 'var(--border-subtle)', marginBottom: 20 }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Open registration
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 12 }}>
        When enabled, anyone can create an account without an invite link.
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px', borderRadius: 8,
        background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
        marginBottom: 28,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
            {regOpen ? 'Registration is open' : 'Registration is closed'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
            {regOpen ? 'Anyone can sign up' : 'Only users with an invite link can register'}
          </div>
        </div>
        <button
          onClick={handleToggleReg}
          style={{
            width: 44, height: 24, borderRadius: 12,
            background: regOpen ? 'var(--accent)' : 'var(--bg-elevated)',
            border: `1px solid ${regOpen ? 'var(--accent)' : 'var(--border)'}`,
            cursor: 'pointer', position: 'relative', transition: 'all 0.2s',
            flexShrink: 0,
          }}
        >
          <div style={{
            position: 'absolute', top: 3, left: regOpen ? 22 : 3,
            width: 16, height: 16, borderRadius: '50%',
            background: 'white', transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }} />
        </button>
      </div>

      {/* ── Invite ── */}
      <div style={{ height: 1, background: 'var(--border-subtle)', marginBottom: 20 }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Invite a user
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 12 }}>
        Generate a single-use invite link valid for 7 days. An email will be sent if you have an SMTP account configured.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="email"
          value={inviteEmail}
          onChange={e => setInviteEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSendInvite()}
          placeholder="email@example.com"
          style={{ ...inputStyle, flex: 1 }}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'}
        />
        <button
          onClick={handleSendInvite}
          disabled={inviteLoading || !inviteEmail.includes('@')}
          style={{
            padding: '9px 16px', background: 'var(--accent)',
            border: 'none', borderRadius: 7, color: 'white',
            fontSize: 13, fontWeight: 500, cursor: inviteLoading ? 'not-allowed' : 'pointer',
            opacity: inviteLoading || !inviteEmail.includes('@') ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          {inviteLoading ? 'Sending…' : 'Send invite'}
        </button>
      </div>

      {inviteMsg && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13,
          background: inviteMsg.type === 'error' ? 'rgba(248,113,113,0.1)' : 'rgba(74,222,128,0.1)',
          border: `1px solid ${inviteMsg.type === 'error' ? 'rgba(248,113,113,0.3)' : 'rgba(74,222,128,0.2)'}`,
          color: inviteMsg.type === 'error' ? 'var(--red)' : 'var(--green)',
        }}>
          {inviteMsg.text}
          {inviteMsg.url && inviteMsg.type === 'ok' && (
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <code style={{
                fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono, monospace',
                background: 'var(--bg-tertiary)', padding: '3px 6px', borderRadius: 4,
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                display: 'block',
              }}>
                {inviteMsg.url}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(inviteMsg.url)}
                style={{
                  padding: '4px 10px', borderRadius: 6, fontSize: 11,
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0,
                }}
              >
                Copy
              </button>
            </div>
          )}
        </div>
      )}

      {/* Pending invites */}
      {pendingInvites.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8, marginTop: 16 }}>
            Pending invites
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {pendingInvites.map(inv => {
              const invUrl = `${window.location.origin}/register?invite=${inv.token}`;
              return (
                <div key={inv.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', borderRadius: 8,
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
                      {inv.email}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
                      Expires {new Date(inv.expires_at).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    onClick={() => copyInviteUrl(invUrl, inv.id)}
                    title="Copy invite link"
                    style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11,
                      background: copiedId === inv.id ? 'rgba(74,222,128,0.1)' : 'var(--bg-elevated)',
                      border: `1px solid ${copiedId === inv.id ? 'rgba(74,222,128,0.3)' : 'var(--border)'}`,
                      color: copiedId === inv.id ? 'var(--green)' : 'var(--text-secondary)',
                      cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s',
                    }}
                  >
                    {copiedId === inv.id ? 'Copied!' : 'Copy link'}
                  </button>
                  <IconBtn onClick={() => handleRevokeInvite(inv.id)} title="Revoke" danger>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </IconBtn>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Used/expired invites */}
      {usedOrExpiredInvites.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8, marginTop: 16 }}>
            Used / expired
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {usedOrExpiredInvites.map(inv => (
              <div key={inv.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px', borderRadius: 8,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
                opacity: 0.6,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 }}>
                    {inv.email}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
                    {inv.used_at
                      ? `Used by ${inv.used_by_username || 'unknown'} on ${new Date(inv.used_at).toLocaleDateString()}`
                      : `Expired ${new Date(inv.expires_at).toLocaleDateString()}`}
                  </div>
                </div>
                <IconBtn onClick={() => handleRevokeInvite(inv.id)} title="Delete" danger>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                  </svg>
                </IconBtn>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Notifications Tab ────────────────────────────────────────────────────────
function NotificationsTab() {
  const { notificationSound, setNotificationSound, customSoundDataUrl, setCustomSoundDataUrl } = useStore();
  const fileInputRef = useRef(null);
  const [customFileName, setCustomFileName] = useState(
    () => localStorage.getItem('mailflow_custom_sound_name') || ''
  );
  const [uploadError, setUploadError] = useState('');

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadError('');
    if (file.size > 2 * 1024 * 1024) {
      setUploadError('File must be under 2 MB.');
      e.target.value = '';
      return;
    }
    // Unlock AudioContext while we're inside a user-gesture handler.
    warmUpAudioContext();
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      setCustomSoundDataUrl(dataUrl);
      setCustomFileName(file.name);
      localStorage.setItem('mailflow_custom_sound_name', file.name);
      setNotificationSound('custom');
      // Preview immediately so the user knows it worked.
      playCustomSound(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const items = [
    { id: 'none', label: 'None', description: 'No sound notification' },
    ...Object.entries(NOTIFICATION_SOUNDS).map(([id, s]) => ({ id, ...s })),
  ];

  const iconVolume = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M15.54 8.46a5 5 0 010 7.07"/>
      <path d="M19.07 4.93a10 10 0 010 14.14"/>
    </svg>
  );

  const checkmark = (
    <div style={{
      width: 16, height: 16, borderRadius: '50%', flexShrink: 0, marginLeft: 6,
      background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Notifications
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        Choose a sound to play when new mail arrives. Click a card to select and preview.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 10, alignItems: 'start' }}>
        {items.map(({ id, label, description }) => {
          const selected = notificationSound === id;
          return (
            <button
              key={id}
              onClick={() => {
                setNotificationSound(id);
                if (id !== 'none') playNotificationSound(id);
              }}
              style={{
                background: selected ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                border: `2px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                borderRadius: 10, padding: '12px 12px 10px',
                cursor: 'pointer', textAlign: 'left',
                transition: 'all 0.15s', outline: 'none',
              }}
              onMouseEnter={e => { if (!selected) e.currentTarget.style.borderColor = 'var(--border)'; }}
              onMouseLeave={e => { if (!selected) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
            >
              <div style={{ marginBottom: 8, color: selected ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                {id === 'none' ? (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <line x1="1" y1="1" x2="23" y2="23"/>
                    <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/>
                    <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 20v4M8 20h8"/>
                  </svg>
                ) : iconVolume}
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{description}</div>
                </div>
                {selected && checkmark}
              </div>
            </button>
          );
        })}

        {/* Custom upload card */}
        {(() => {
          const selected = notificationSound === 'custom';
          return (
            <div
              onClick={() => {
                setNotificationSound('custom');
                if (customSoundDataUrl) playCustomSound(customSoundDataUrl);
              }}
              style={{
                background: selected ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                border: `2px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
                borderRadius: 10, padding: '12px 12px 10px',
                cursor: 'pointer', textAlign: 'left',
                transition: 'all 0.15s', outline: 'none',
                display: 'flex', flexDirection: 'column', gap: 6,
              }}
              onMouseEnter={e => { if (!selected) e.currentTarget.style.borderColor = 'var(--border)'; }}
              onMouseLeave={e => { if (!selected) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
            >
              <div style={{ color: selected ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Custom</div>
                  <div style={{
                    fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    maxWidth: 110,
                  }}>
                    {customFileName || 'Upload audio file'}
                  </div>
                </div>
                {selected && checkmark}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                style={{ display: 'none' }}
                onChange={handleFileUpload}
              />
              <button
                onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}
                style={{
                  marginTop: 2, padding: '4px 8px', fontSize: 11, fontWeight: 500,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 5, cursor: 'pointer', color: 'var(--text-secondary)',
                  alignSelf: 'flex-start', transition: 'background 0.1s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-secondary)'}
              >
                {customFileName ? 'Change file' : 'Upload'}
              </button>

              {uploadError && (
                <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>{uploadError}</div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

const TABS = [
  {
    id: 'accounts', label: 'Accounts',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
  },
  {
    id: 'themes', label: 'Appearance',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  },
  {
    id: 'fonts', label: 'Typography',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>,
  },
  {
    id: 'layouts', label: 'Layout',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="9" y1="12" x2="21" y2="12"/></svg>,
  },
  {
    id: 'integrations', label: 'Integrations',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="3"/><path d="M6.343 6.343a8 8 0 000 11.314M17.657 6.343a8 8 0 010 11.314M3 12h1m16 0h1M12 3v1m0 16v1"/></svg>,
  },
  {
    id: 'users', label: 'Users',
    adminOnly: true,
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  },
  {
    id: 'security', label: 'Security',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>,
  },
  {
    id: 'notifications', label: 'Notifications',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/></svg>,
  },
  {
    id: 'privacy', label: 'Privacy',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  },
  {
    id: 'shortcuts', label: 'Shortcuts',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="2" y="7" width="6" height="4" rx="1"/><rect x="9" y="7" width="6" height="4" rx="1"/><rect x="16" y="7" width="6" height="4" rx="1"/><rect x="2" y="13" width="9" height="4" rx="1"/><rect x="13" y="13" width="9" height="4" rx="1"/></svg>,
  },
];

// ─── Shortcuts Tab ───────────────────────────────────────────────────────────
function ShortcutsTab() {
  const { shortcuts, setShortcuts } = useStore();
  const [recording, setRecording] = useState(null); // action name currently being recorded
  const [pendingConflict, setPendingConflict] = useState(null); // { action: conflictingAction, key }

  const effective = getEffectiveShortcuts(shortcuts);
  const groups = getGroupedActions();

  // Listen for key presses while recording
  useEffect(() => {
    if (!recording) return;
    const handler = (e) => {
      // Ignore pure modifier keys
      if (['Shift', 'Control', 'Meta', 'Alt', 'CapsLock', 'Tab'].includes(e.key)) return;
      e.preventDefault();

      if (e.key === 'Escape') {
        setRecording(null);
        setPendingConflict(null);
        return;
      }

      const key = e.key;

      // Detect conflicts with other actions (excluding the one being edited)
      const conflictEntry = Object.entries(effective).find(([a, k]) => k === key && a !== recording);
      if (conflictEntry) {
        setPendingConflict({ action: conflictEntry[0], key });
      } else {
        setPendingConflict(null);
      }

      const updated = { ...shortcuts, [recording]: key };
      setShortcuts(updated);
      setRecording(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [recording, effective, shortcuts]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearShortcut = (action) => {
    const updated = { ...shortcuts, [action]: null };
    setShortcuts(updated);
    setPendingConflict(null);
  };

  const resetAction = (action) => {
    const updated = { ...shortcuts };
    delete updated[action];
    setShortcuts(updated);
    setPendingConflict(null);
  };

  const resetAll = () => {
    setShortcuts({});
    setRecording(null);
    setPendingConflict(null);
  };

  const kbdStyle = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 26, height: 22, padding: '0 6px',
    background: 'var(--bg-primary)', border: '1px solid var(--border)',
    borderBottomWidth: 2, borderRadius: 4,
    fontSize: 12, fontFamily: 'monospace', fontWeight: 600,
    color: 'var(--text-primary)',
  };

  const renderKey = (action, key) => {
    const isRec = recording === action;
    if (isRec) {
      return (
        <span style={{
          display: 'inline-flex', alignItems: 'center',
          padding: '2px 10px', borderRadius: 4,
          background: 'var(--accent-dim)', border: '1px solid var(--accent)',
          fontSize: 11, color: 'var(--accent)', fontStyle: 'italic',
        }}>
          Press a key…
        </span>
      );
    }
    if (!key) {
      return <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>;
    }
    // Multi-char keys like 'gi': render each character as separate kbd with "then"
    if (key.length > 1) {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {[...key].map((c, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <kbd style={kbdStyle}>{c}</kbd>
              {i < key.length - 1 && <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>then</span>}
            </span>
          ))}
        </span>
      );
    }
    return <kbd style={kbdStyle}>{key}</kbd>;
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Keyboard Shortcuts</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
            Click a key binding to reassign it. Press <kbd style={{ ...kbdStyle, fontSize: 10 }}>Esc</kbd> to cancel recording.
          </div>
        </div>
        <button
          onClick={resetAll}
          style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 7,
            padding: '6px 14px', cursor: 'pointer', fontSize: 12,
            color: 'var(--text-secondary)', flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
        >
          Reset all to defaults
        </button>
      </div>

      {pendingConflict && (
        <div style={{
          marginBottom: 16, padding: '10px 14px',
          background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.4)',
          borderRadius: 7, fontSize: 12, color: 'var(--text-secondary)',
        }}>
          Key <kbd style={{ ...kbdStyle, fontSize: 11 }}>{pendingConflict.key}</kbd> was already assigned to
          <strong style={{ color: 'var(--text-primary)', marginLeft: 4 }}>{ACTION_DEFS[pendingConflict.action]?.label}</strong>
          — it has been reassigned.
        </div>
      )}

      {Object.entries(groups).map(([groupName, actions]) => (
        <div key={groupName} style={{ marginBottom: 24 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
          }}>
            {groupName}
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {actions.map(({ action, description }, i) => {
              const key = effective[action];
              const isDefault = !(action in shortcuts);
              const isRec = recording === action;
              return (
                <div
                  key={action}
                  style={{
                    display: 'flex', alignItems: 'center',
                    padding: '10px 14px', gap: 12,
                    borderBottom: i < actions.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                    background: isRec ? 'var(--accent-dim)' : 'transparent',
                    transition: 'background 0.1s',
                  }}
                >
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)' }}>
                    {description}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={() => setRecording(isRec ? null : action)}
                      title={isRec ? 'Cancel recording' : 'Click to reassign shortcut'}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        padding: 0, display: 'flex', alignItems: 'center',
                      }}
                    >
                      {renderKey(action, key)}
                    </button>
                    {!isDefault && (
                      <button
                        onClick={() => resetAction(action)}
                        title="Reset to default"
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--text-tertiary)', padding: 2,
                          fontSize: 11, display: 'flex', alignItems: 'center',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
                        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
                        </svg>
                      </button>
                    )}
                    {key && !isRec && (
                      <button
                        onClick={() => clearShortcut(action)}
                        title="Remove shortcut"
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--text-tertiary)', padding: 2,
                          display: 'flex', alignItems: 'center',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = 'var(--red, #ef4444)'}
                        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-tertiary)'}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
        Press <kbd style={{ ...kbdStyle, fontSize: 10 }}>?</kbd> anywhere in the app to see the current shortcut reference.
      </div>
    </div>
  );
}

// ─── Privacy Tab ─────────────────────────────────────────────────────────────
function PrivacyTab() {
  const { blockRemoteImages, setBlockRemoteImages, imageWhitelist, setImageWhitelist } = useStore();
  const [newAddress, setNewAddress] = useState('');
  const [newDomain,  setNewDomain]  = useState('');

  const addAddress = () => {
    const val = newAddress.trim().toLowerCase();
    if (!val || !val.includes('@')) return;
    const updated = {
      ...imageWhitelist,
      addresses: [...new Set([...(imageWhitelist.addresses || []), val])],
    };
    setImageWhitelist(updated);
    setNewAddress('');
  };

  const removeAddress = (addr) => {
    setImageWhitelist({
      ...imageWhitelist,
      addresses: (imageWhitelist.addresses || []).filter(a => a !== addr),
    });
  };

  const addDomain = () => {
    const val = newDomain.trim().toLowerCase().replace(/^@/, '');
    if (!val || val.includes('@')) return;
    const updated = {
      ...imageWhitelist,
      domains: [...new Set([...(imageWhitelist.domains || []), val])],
    };
    setImageWhitelist(updated);
    setNewDomain('');
  };

  const removeDomain = (domain) => {
    setImageWhitelist({
      ...imageWhitelist,
      domains: (imageWhitelist.domains || []).filter(d => d !== domain),
    });
  };

  const sectionHead = { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 };
  const pill = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    borderRadius: 20, padding: '3px 10px 3px 12px', fontSize: 12,
    color: 'var(--text-secondary)',
  };
  const addRow = { display: 'flex', gap: 8, marginTop: 10 };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>Privacy</div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 24 }}>
        Control whether remote images in emails are loaded automatically
      </div>

      {/* Toggle */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px', background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 10, marginBottom: 24,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Block remote images</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
            Prevents tracking pixels and remote image loading by default
          </div>
        </div>
        <button
          onClick={() => setBlockRemoteImages(!blockRemoteImages)}
          style={{
            width: 42, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
            background: blockRemoteImages ? 'var(--accent)' : 'var(--bg-tertiary)',
            position: 'relative', transition: 'background 0.2s', flexShrink: 0,
          }}
        >
          <span style={{
            position: 'absolute', top: 3, width: 18, height: 18, borderRadius: '50%',
            background: 'white', transition: 'left 0.2s',
            left: blockRemoteImages ? 21 : 3,
          }} />
        </button>
      </div>

      {blockRemoteImages && (
        <>
          {/* Allowed senders */}
          <div style={{ marginBottom: 24 }}>
            <div style={sectionHead}>Allowed senders</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>
              Images are always loaded from these sender addresses
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(imageWhitelist.addresses || []).length === 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No addresses added yet</span>
              )}
              {(imageWhitelist.addresses || []).map(addr => (
                <span key={addr} style={pill}>
                  {addr}
                  <button onClick={() => removeAddress(addr)} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-tertiary)', padding: 0, lineHeight: 1,
                    display: 'flex', alignItems: 'center',
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </span>
              ))}
            </div>
            <div style={addRow}>
              <input
                value={newAddress}
                onChange={e => setNewAddress(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addAddress()}
                placeholder="sender@example.com"
                style={{ ...inputStyle, flex: 1, maxWidth: 280 }}
              />
              <button onClick={addAddress} style={{
                padding: '8px 14px', background: 'var(--accent)', border: 'none',
                borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              }}>Add</button>
            </div>
          </div>

          {/* Allowed domains */}
          <div>
            <div style={sectionHead}>Allowed domains</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>
              Images are always loaded from senders whose email is at these domains
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(imageWhitelist.domains || []).length === 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No domains added yet</span>
              )}
              {(imageWhitelist.domains || []).map(domain => (
                <span key={domain} style={pill}>
                  @{domain}
                  <button onClick={() => removeDomain(domain)} style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-tertiary)', padding: 0, lineHeight: 1,
                    display: 'flex', alignItems: 'center',
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </span>
              ))}
            </div>
            <div style={addRow}>
              <input
                value={newDomain}
                onChange={e => setNewDomain(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addDomain()}
                placeholder="example.com"
                style={{ ...inputStyle, flex: 1, maxWidth: 280 }}
              />
              <button onClick={addDomain} style={{
                padding: '8px 14px', background: 'var(--accent)', border: 'none',
                borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              }}>Add</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Security Tab (TOTP 2FA) ──────────────────────────────────────────────────
function SecurityTab() {
  const { user, setUser } = useStore();
  const [step, setStep] = useState('idle'); // 'idle' | 'scan' | 'verify'
  const [setupData, setSetupData] = useState(null); // { qrCode, secret }
  const [verifyCode, setVerifyCode] = useState('');
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const totpEnabled = user?.totpEnabled;

  const startSetup = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.totp.setup();
      setSetupData(data);
      setStep('scan');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const verifyEnable = async (e) => {
    e.preventDefault();
    if (verifyCode.length !== 6) return;
    setLoading(true);
    setError('');
    try {
      await api.totp.enable(verifyCode);
      setUser({ ...user, totpEnabled: true });
      setStep('idle');
      setSetupData(null);
      setVerifyCode('');
      setSuccess('Two-factor authentication enabled.');
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError(err.message);
      setVerifyCode('');
    } finally {
      setLoading(false);
    }
  };

  const disableTotp = async (e) => {
    e.preventDefault();
    if (!disablePassword) return;
    setLoading(true);
    setError('');
    try {
      await api.totp.disable(disablePassword);
      setUser({ ...user, totpEnabled: false });
      setShowDisable(false);
      setDisablePassword('');
      setSuccess('Two-factor authentication disabled.');
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError(err.message);
      setDisablePassword('');
    } finally {
      setLoading(false);
    }
  };

  const cancelSetup = () => {
    setStep('idle');
    setSetupData(null);
    setVerifyCode('');
    setError('');
  };

  return (
    <div style={{ maxWidth: 520 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>Security</h2>
      <p style={{ margin: '0 0 28px', fontSize: 13, color: 'var(--text-tertiary)' }}>
        Manage two-factor authentication for your account.
      </p>

      {/* Status card */}
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '20px 24px', marginBottom: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: totpEnabled ? 'rgba(34,197,94,0.12)' : 'var(--bg-tertiary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke={totpEnabled ? '#22c55e' : 'var(--text-tertiary)'} strokeWidth="1.75">
                <rect x="5" y="11" width="14" height="10" rx="2"/>
                <path d="M8 11V7a4 4 0 018 0v4"/>
                {totpEnabled && <circle cx="12" cy="16" r="1" fill="#22c55e" stroke="none"/>}
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                Authenticator app
              </div>
              <div style={{ fontSize: 12, color: totpEnabled ? '#22c55e' : 'var(--text-tertiary)', marginTop: 2 }}>
                {totpEnabled ? 'Enabled' : 'Not configured'}
              </div>
            </div>
          </div>
          {!totpEnabled && step === 'idle' && (
            <button
              onClick={startSetup}
              disabled={loading}
              style={{
                padding: '8px 16px', background: 'var(--accent)', border: 'none',
                borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500,
                cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1,
                flexShrink: 0,
              }}
            >
              {loading ? 'Loading…' : 'Set up'}
            </button>
          )}
          {totpEnabled && !showDisable && (
            <button
              onClick={() => { setShowDisable(true); setError(''); }}
              style={{
                padding: '8px 16px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                borderRadius: 7, color: 'var(--red)', fontSize: 13, fontWeight: 500,
                cursor: 'pointer', flexShrink: 0,
              }}
            >
              Disable
            </button>
          )}
        </div>

        {/* Setup: scan QR */}
        {step === 'scan' && setupData && (
          <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
              Scan this QR code with your authenticator app (e.g. Google Authenticator, Authy).
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <img
                src={setupData.qrCode}
                alt="QR code"
                style={{ width: 180, height: 180, borderRadius: 8, background: 'white', padding: 8 }}
              />
            </div>
            <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
              Can't scan? Enter this key manually:
            </p>
            <div style={{
              fontFamily: 'monospace', fontSize: 13, letterSpacing: '0.1em',
              color: 'var(--text-secondary)', textAlign: 'center',
              background: 'var(--bg-tertiary)', borderRadius: 6, padding: '8px 12px',
              marginBottom: 20, wordBreak: 'break-all',
            }}>
              {setupData.secret}
            </div>
            <button
              onClick={() => setStep('verify')}
              style={{
                width: '100%', padding: '10px', background: 'var(--accent)', border: 'none',
                borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              }}
            >
              Next: verify code →
            </button>
            <button
              onClick={cancelSetup}
              style={{
                width: '100%', padding: '8px', background: 'none', border: 'none',
                color: 'var(--text-tertiary)', fontSize: 13, cursor: 'pointer', marginTop: 8,
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Setup: verify code */}
        {step === 'verify' && (
          <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
              Enter the 6-digit code from your authenticator app to confirm setup.
            </p>
            <form onSubmit={verifyEnable} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={verifyCode}
                onChange={e => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                autoFocus
                placeholder="000000"
                style={{
                  width: '100%', padding: '12px 14px',
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  borderRadius: 8, color: 'var(--text-primary)', fontSize: 22,
                  letterSpacing: '0.3em', textAlign: 'center',
                  outline: 'none', boxSizing: 'border-box', fontVariantNumeric: 'tabular-nums',
                }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
              <button
                type="submit"
                disabled={loading || verifyCode.length !== 6}
                style={{
                  padding: '10px', background: 'var(--accent)', border: 'none',
                  borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500,
                  cursor: loading || verifyCode.length !== 6 ? 'not-allowed' : 'pointer',
                  opacity: loading || verifyCode.length !== 6 ? 0.6 : 1,
                }}
              >
                {loading ? 'Verifying…' : 'Enable 2FA'}
              </button>
              <button
                type="button"
                onClick={() => setStep('scan')}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-tertiary)',
                  fontSize: 13, cursor: 'pointer', padding: 0,
                }}
              >
                ← Back
              </button>
            </form>
          </div>
        )}

        {/* Disable flow */}
        {showDisable && (
          <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
              Enter your password to disable two-factor authentication.
            </p>
            <form onSubmit={disableTotp} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="password"
                value={disablePassword}
                onChange={e => setDisablePassword(e.target.value)}
                autoFocus
                placeholder="Your password"
                style={{ ...inputStyle }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="submit"
                  disabled={loading || !disablePassword}
                  style={{
                    flex: 1, padding: '10px', background: 'var(--red)', border: 'none',
                    borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500,
                    cursor: loading || !disablePassword ? 'not-allowed' : 'pointer',
                    opacity: loading || !disablePassword ? 0.6 : 1,
                  }}
                >
                  {loading ? 'Disabling…' : 'Disable 2FA'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowDisable(false); setDisablePassword(''); setError(''); }}
                  style={{
                    padding: '10px 16px', background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border)', borderRadius: 7,
                    color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Error / success */}
        {error && (
          <div style={{
            marginTop: 12, padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
            border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8,
            color: 'var(--red)', fontSize: 13,
          }}>{error}</div>
        )}
        {success && (
          <div style={{
            marginTop: 12, padding: '10px 14px', background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.3)', borderRadius: 8,
            color: '#22c55e', fontSize: 13,
          }}>{success}</div>
        )}
      </div>
    </div>
  );
}

export default function AdminPanel() {
  const { setShowAdmin, adminTab, setAdminTab, user } = useStore();
  const isMobile = useMobile();
  const visibleTabs = TABS.filter(t => !t.adminOnly || user?.isAdmin);

  if (isMobile) {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'var(--bg-secondary)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Mobile header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          paddingTop: 'calc(var(--sat) + 14px)',
          paddingBottom: 14, paddingLeft: 16, paddingRight: 16,
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Settings</span>
          <button
            onClick={() => setShowAdmin(false)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-tertiary)', padding: 6, display: 'flex',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Horizontal scrollable tab bar */}
        <div className="admin-tabs" style={{
          display: 'flex', gap: 6, padding: '10px 12px',
          overflowX: 'auto', flexShrink: 0,
          borderBottom: '1px solid var(--border-subtle)',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}>
          <style>{`.admin-tabs::-webkit-scrollbar { display: none; }`}</style>
          {visibleTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setAdminTab(tab.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 12px', borderRadius: 20, border: 'none',
                background: adminTab === tab.id ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: adminTab === tab.id ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer', fontSize: 13, fontWeight: 500,
                whiteSpace: 'nowrap', flexShrink: 0,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <span style={{ display: 'flex', opacity: adminTab === tab.id ? 1 : 0.7 }}>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content — full width, scrollable */}
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 16px' }}>
          {adminTab === 'accounts' && <AccountsTab />}
          {adminTab === 'themes' && <ThemesTab />}
          {adminTab === 'fonts' && <FontsTab />}
          {adminTab === 'layouts' && <LayoutsTab />}
          {adminTab === 'integrations' && <IntegrationsTab />}
          {adminTab === 'users' && <UsersTab />}
          {adminTab === 'security' && <SecurityTab />}
          {adminTab === 'notifications' && <NotificationsTab />}
          {adminTab === 'privacy' && <PrivacyTab />}
          {adminTab === 'shortcuts' && <ShortcutsTab />}
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={e => e.target === e.currentTarget && setShowAdmin(false)}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000, padding: 24,
      }}
    >
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 16, width: '100%', maxWidth: 680,
        height: '82vh', maxHeight: 700, display: 'flex', overflow: 'hidden',
        boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
      }}>
        {/* Left sidebar */}
        <div style={{
          width: 180, borderRight: '1px solid var(--border-subtle)',
          background: 'var(--bg-primary)', padding: '20px 10px',
          display: 'flex', flexDirection: 'column', flexShrink: 0,
        }}>
          <div style={{
            fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600,
            letterSpacing: '0.07em', textTransform: 'uppercase',
            padding: '0 8px', marginBottom: 10,
          }}>
            Settings
          </div>

          {visibleTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setAdminTab(tab.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '8px 10px', borderRadius: 7, border: 'none',
                background: adminTab === tab.id ? 'var(--bg-hover)' : 'transparent',
                color: adminTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                cursor: 'pointer', fontSize: 13, fontWeight: adminTab === tab.id ? 500 : 400,
                width: '100%', textAlign: 'left', transition: 'all 0.1s',
              }}
              onMouseEnter={e => { if (adminTab !== tab.id) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
              onMouseLeave={e => { if (adminTab !== tab.id) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ color: adminTab === tab.id ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                {tab.icon}
              </span>
              {tab.label}
            </button>
          ))}

          <div style={{ flex: 1 }} />

          <button
            onClick={() => setShowAdmin(false)}
            style={{
              display: 'flex', alignItems: 'center', gap: 9,
              padding: '8px 10px', borderRadius: 7, border: 'none',
              background: 'transparent', color: 'var(--text-tertiary)',
              cursor: 'pointer', fontSize: 13, width: '100%', textAlign: 'left',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            Close
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
          {adminTab === 'accounts' && <AccountsTab />}
          {adminTab === 'themes' && <ThemesTab />}
          {adminTab === 'fonts' && <FontsTab />}
          {adminTab === 'layouts' && <LayoutsTab />}
          {adminTab === 'integrations' && <IntegrationsTab />}
          {adminTab === 'users' && <UsersTab />}
          {adminTab === 'security' && <SecurityTab />}
          {adminTab === 'notifications' && <NotificationsTab />}
          {adminTab === 'privacy' && <PrivacyTab />}
          {adminTab === 'shortcuts' && <ShortcutsTab />}
        </div>
      </div>
    </div>
  );
}
