import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';
import { api } from '../utils/api.js';
import { THEMES, applyTheme } from '../themes.js';
import { FONT_SETS, loadFontSet } from '../fonts.js';
import { LAYOUTS, applyLayout } from '../layouts.js';
import { NOTIFICATION_SOUNDS, playNotificationSound, playCustomSound, warmUpAudioContext } from '../utils/notificationSounds.js';
import { usePushNotifications } from '../hooks/usePushNotifications.js';
import SignatureEditor from './SignatureEditor.jsx';
import { getEffectiveShortcuts, getGroupedActions, ACTION_DEFS, SPECIAL_KEY_LABELS, parseModKey, modLabel } from '../utils/defaultShortcuts.js';

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
const PRESETS = {
  gmail:   { label: 'Gmail',   imap_host: 'imap.gmail.com',        imap_port: 993, smtp_host: 'smtp.gmail.com',        smtp_port: 587 },
  yahoo:   { label: 'Yahoo',   imap_host: 'imap.mail.yahoo.com',   imap_port: 993, smtp_host: 'smtp.mail.yahoo.com',   smtp_port: 587 },
  icloud:  { label: 'iCloud',  imap_host: 'imap.mail.me.com',      imap_port: 993, smtp_host: 'smtp.mail.me.com',      smtp_port: 587 },
  custom:  { label: 'Custom' },
};

// ─── Account Form (Add or Edit) ───────────────────────────────────────────────
function isMicrosoftImapHost(host) {
  const h = (host || '').toLowerCase();
  return h.includes('.outlook.com') || h.includes('office365.com') || h.includes('.hotmail.com') || h.includes('.live.com');
}

function AccountForm({ initial, onSave, onCancel }) {
  const { t } = useTranslation();
  const { setAdminTab } = useStore();
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
      setError(t('admin.accounts.errorRequired'));
      return;
    }
    if (!isEdit && !form.auth_pass) {
      setError(t('admin.accounts.errorPasswordRequired'));
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
            const presetLabel = key === 'gmail' ? t('admin.accounts.presetGmail') : key === 'yahoo' ? t('admin.accounts.presetYahoo') : key === 'icloud' ? t('admin.accounts.presetIcloud') : t('admin.accounts.presetCustom');
            return (
              <button key={key} onClick={() => handlePreset(key)} style={{
                padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 500,
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'var(--accent-dim)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer', transition: 'all 0.12s',
              }}>
                {presetLabel}
              </button>
            );
          })}
        </div>
      )}

      {/* Color */}
      <Field label={t('admin.accounts.color')}>
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

      <Field label={t('admin.accounts.displayName')} required>
        <input value={form.name || ''} onChange={e => set('name', e.target.value)}
          placeholder={t('admin.accounts.displayNamePh')} style={inputStyle}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'} />
      </Field>

      <Field label={t('admin.accounts.senderName')}>
        <input value={form.sender_name || ''} onChange={e => set('sender_name', e.target.value)}
          placeholder={t('admin.accounts.senderNamePh')} style={inputStyle}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'} />
      </Field>

      {!isEdit && (
        <Field label={t('admin.accounts.email')} required>
          <input value={form.email_address || ''} onChange={e => set('email_address', e.target.value)}
            placeholder={t('admin.accounts.emailPh')} style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
      )}

      <Field label={t('admin.accounts.authUser')} required>
        <input value={form.auth_user || ''} onChange={e => set('auth_user', e.target.value)}
          placeholder={t('admin.accounts.authUserPh')} style={inputStyle}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'} />
      </Field>

      <Field label={isEdit ? t('admin.accounts.password') + ' (' + t('admin.accounts.passwordPhEdit') + ')' : t('admin.accounts.password')} required={!isEdit}>
        <div style={{ position: 'relative' }}>
          <input type={showPass ? 'text' : 'password'}
            value={form.auth_pass || ''} onChange={e => set('auth_pass', e.target.value)}
            placeholder={isEdit ? '••••••••' : t('admin.accounts.passwordPhNew')}
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
        {t('admin.accounts.imapSection')}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 10 }}>
        <Field label={t('admin.accounts.imapHost')} required>
          <input value={form.imap_host || ''} onChange={e => set('imap_host', e.target.value)}
            placeholder={t('admin.accounts.imapHostPh')} style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
        <Field label={t('admin.accounts.imapPort')}>
          <input type="number" value={form.imap_port || 993} onChange={e => set('imap_port', parseInt(e.target.value))}
            style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
      </div>

      {isMicrosoftImapHost(form.imap_host) && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '10px 14px', marginTop: 10,
          background: 'rgba(248,113,113,0.07)',
          border: '1px solid rgba(248,113,113,0.3)',
          borderRadius: 8, fontSize: 13, color: 'var(--text-primary)',
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>{t('admin.accounts.microsoftImapUnsupported')}</div>
            <div style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t('admin.accounts.microsoftImapNote')}</div>
          </div>
        </div>
      )}

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0 16px', marginTop: isMicrosoftImapHost(form.imap_host) ? 16 : '4px' }} />
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        {t('admin.accounts.smtpSection')}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 10 }}>
        <Field label={t('admin.accounts.smtpHost')}>
          <input value={form.smtp_host || ''} onChange={e => set('smtp_host', e.target.value)}
            placeholder={t('admin.accounts.smtpHostPh')} style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
        <Field label={t('admin.accounts.smtpPort')}>
          <input type="number" value={form.smtp_port || 587} onChange={e => set('smtp_port', parseInt(e.target.value))}
            style={inputStyle}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'} />
        </Field>
      </div>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }} />
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        {t('admin.accounts.signatureSection')}
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
        <button onClick={handleSubmit} disabled={saving || (!isEdit && isMicrosoftImapHost(form.imap_host))} style={{
          flex: 1, padding: '10px', background: 'var(--accent)',
          border: 'none', borderRadius: 8, color: 'white',
          fontSize: 13, fontWeight: 500,
          cursor: (saving || (!isEdit && isMicrosoftImapHost(form.imap_host))) ? 'not-allowed' : 'pointer',
          opacity: (saving || (!isEdit && isMicrosoftImapHost(form.imap_host))) ? 0.4 : 1,
        }}>
          {saving ? t('admin.accounts.saving') : (isEdit ? t('admin.accounts.saveChanges') : t('admin.accounts.addAccount'))}
        </button>
        <button onClick={onCancel} style={{
          padding: '10px 16px', background: 'var(--bg-tertiary)',
          border: '1px solid var(--border)', borderRadius: 8,
          color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13,
        }}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

// ─── Accounts Tab ─────────────────────────────────────────────────────────────
function AccountsTab() {
  const { t } = useTranslation();
  const { accounts, setAccounts, updateAccount, addNotification, backfillProgress } = useStore();
  const [subview, setSubview] = useState('list'); // 'list' | 'add' | 'edit' | 'folders' | 'aliases'
  const [editTarget, setEditTarget] = useState(null);
  const [folderMappings, setFolderMappings] = useState({});
  const [availableFolders, setAvailableFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersSaving, setFoldersSaving] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null);

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
    const updates = { name: form.name, sender_name: form.sender_name || null, color: form.color, smtp_host: form.smtp_host, smtp_port: form.smtp_port, signature: form.signature || null };
    if (form.auth_pass) updates.auth_pass = form.auth_pass;
    if (form.auth_user) updates.auth_user = form.auth_user;
    await api.updateAccount(editTarget.id, updates);
    updateAccount(editTarget.id, updates);
    setSubview('list');
    setEditTarget(null);
  };

  const handleDelete = (id) => {
    setConfirmDialog({
      title: 'Remove account?',
      message: 'All synced messages for this account will be deleted. This cannot be undone.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await api.deleteAccount(id);
        setAccounts(accounts.filter(a => a.id !== id));
      },
    });
  };

  const handleReconnect = async (id) => {
    await api.reconnectAccount(id);
    updateAccount(id, { sync_error: null });
  };

  const handleReindex = async (id) => {
    try {
      await api.reindexAccount(id);
    } catch (err) {
      addNotification({ type: 'error', title: t('admin.accounts.reindexError'), body: err.message });
    }
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
      addNotification({ type: 'error', title: 'Could not load folders', body: err.message });
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
      addNotification({ type: 'error', title: 'Could not save folder mappings', body: err.message });
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
      setAliasFormError(t('admin.aliases.errorRequired'));
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
        setEditTarget(prev => ({ ...prev, aliases: newAliases }));
      } else {
        saved = await api.updateAlias(editTarget.id, aliasFormId, payload);
        const newAliases = (editTarget.aliases || []).map(a => a.id === aliasFormId ? saved : a);
        updateAccount(editTarget.id, { aliases: newAliases });
        setEditTarget(prev => ({ ...prev, aliases: newAliases }));
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

  const handleAliasDelete = (aliasId) => {
    setConfirmDialog({
      title: t('admin.aliases.deleteConfirmTitle'),
      message: t('admin.aliases.deleteConfirmBody'),
      confirmLabel: t('admin.aliases.deleteConfirmLabel'),
      onConfirm: async () => {
        await api.deleteAlias(editTarget.id, aliasId);
        const newAliases = (editTarget.aliases || []).filter(a => a.id !== aliasId);
        updateAccount(editTarget.id, { aliases: newAliases });
        setEditTarget(prev => ({ ...prev, aliases: newAliases }));
      },
    });
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
          {t('sidebar.backToAccounts')}
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20 }}>
          {t('admin.accounts.addTitle')}
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
          {t('sidebar.backToAccounts')}
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.accounts.editTitle')}
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
        {t('sidebar.backToAccounts')}
      </button>
    );

    if (aliasFormMode) {
      return (
        <div>
          {backBtn}
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {aliasFormMode === 'add' ? t('admin.aliases.newTitle') : t('admin.aliases.editTitle')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 20 }}>
            {editTarget.email_address}
          </div>

          <Field label={t('admin.aliases.name')} required>
            <input value={aliasFormData.name} onChange={e => setAliasFormData(f => ({ ...f, name: e.target.value }))}
              placeholder={t('admin.aliases.namePh')} style={inputStyle}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'} />
          </Field>
          <Field label={t('admin.aliases.email')} required>
            <input value={aliasFormData.email} onChange={e => setAliasFormData(f => ({ ...f, email: e.target.value }))}
              placeholder={t('admin.aliases.emailPh')} style={inputStyle}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'} />
          </Field>
          <Field label={t('admin.aliases.replyTo')}>
            <input value={aliasFormData.reply_to} onChange={e => setAliasFormData(f => ({ ...f, reply_to: e.target.value }))}
              placeholder={t('admin.aliases.replyToPh')} style={inputStyle}
              onFocus={e => e.target.style.borderColor = 'var(--accent)'}
              onBlur={e => e.target.style.borderColor = 'var(--border)'} />
          </Field>

          <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }} />
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            {t('admin.aliases.signatureSection')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>
            {t('admin.aliases.signatureNote')}
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
              {aliasFormSaving ? t('admin.aliases.saving') : t('admin.aliases.save')}
            </button>
            <button onClick={() => { setAliasFormMode(null); setAliasFormError(''); }} style={{
              padding: '10px 16px', background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)', borderRadius: 8,
              color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13,
            }}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      );
    }

    const aliases = editTarget.aliases || [];
    return (
      <>
      <div>
        {backBtn}
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.aliases.title')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
          {editTarget.email_address}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
          {t('admin.aliases.description')}
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
          {t('admin.aliases.addButton')}
        </button>

        {aliases.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
            {t('admin.aliases.empty')}
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
                    {t('admin.aliases.replyToLabel')} {alias.reply_to}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <IconBtn onClick={() => handleAliasEdit(alias)} title={t('common.edit')}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </IconBtn>
                <IconBtn onClick={() => handleAliasDelete(alias.id)} title={t('common.delete')} danger>
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
      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />
      </>
    );
  }

  if (subview === 'folders' && editTarget) {
    const FOLDER_ROLES = [
      { key: 'sent',    label: t('admin.folderMappings.sent'),    specialUse: '\\Sent' },
      { key: 'drafts',  label: t('admin.folderMappings.drafts'),  specialUse: '\\Drafts' },
      { key: 'trash',   label: t('admin.folderMappings.trash'),   specialUse: '\\Trash' },
      { key: 'spam',    label: t('admin.folderMappings.spam'),    specialUse: '\\Junk' },
      { key: 'archive', label: t('admin.folderMappings.archive'), specialUse: '\\Archive' },
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
          {t('sidebar.backToAccounts')}
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.folderMappings.title')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 20 }}>
          {editTarget.email_address}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.6, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
          {t('admin.folderMappings.description')}
        </div>
        {foldersLoading ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
            {t('admin.folderMappings.loading')}
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
                    {autoFolder ? `${t('admin.folderMappings.autoDetect')} (${autoFolder.path})` : t('admin.folderMappings.autoDetectNone')}
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
          {foldersSaving ? t('admin.folderMappings.saving') : t('admin.folderMappings.save')}
        </button>
      </div>
    );
  }

  return (
    <>
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('admin.accounts.title')}
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
          {t('admin.accounts.addButton')}
        </button>
      </div>

      {accounts.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-tertiary)', fontSize: 14 }}>
          {t('admin.accounts.empty')}
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
                    <span style={{ color: 'var(--green)' }}>● {t('admin.accounts.connected')}</span>
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {account.imap_host}:{account.imap_port}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {account.sync_error && (
                <IconBtn onClick={() => handleReconnect(account.id)} title={t('sidebar.accountMenu.reconnect')}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                  </svg>
                </IconBtn>
              )}
              <IconBtn onClick={() => { setEditTarget(account); setSubview('edit'); }} title={t('common.edit')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </IconBtn>
              <IconBtn onClick={() => handleFolderMappingOpen(account)} title={t('admin.accounts.folderMappings')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                </svg>
              </IconBtn>
              <IconBtn onClick={() => handleAliasOpen(account)} title={t('admin.accounts.aliases')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="8" r="4"/>
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </IconBtn>
              <IconBtn onClick={() => handleReindex(account.id)} title={t('admin.accounts.reindex')} disabled={!!backfillProgress[account.id]}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
              </IconBtn>
              <IconBtn onClick={() => handleDelete(account.id)} title={t('common.remove')} danger>
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
              [t('admin.accounts.lastSync'), account.last_sync ? new Date(account.last_sync).toLocaleTimeString() : t('common.never')],
            ].map(([label, val]) => (
              <div key={label} style={{ fontSize: 11 }}>
                <span style={{ color: 'var(--text-tertiary)' }}>{label} </span>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'JetBrains Mono, monospace' }}>{val}</span>
              </div>
            ))}
            {backfillProgress[account.id] && (
              <div style={{ width: '100%', marginTop: 4 }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>
                  {backfillProgress[account.id].total
                    ? t('admin.accounts.reindexProgress', {
                        synced: backfillProgress[account.id].synced,
                        total: backfillProgress[account.id].total,
                      })
                    : t('admin.accounts.reindexing')}
                </div>
                {backfillProgress[account.id].total && (
                  <div style={{ height: 3, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 2,
                      background: 'var(--accent)',
                      width: `${Math.min(100, Math.round((backfillProgress[account.id].synced / backfillProgress[account.id].total) * 100))}%`,
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />
    </div>
    </>
  );
}

// ─── Themes Tab ───────────────────────────────────────────────────────────────
function ThemesTab() {
  const { t } = useTranslation();
  const { theme, setTheme } = useStore();

  const handleSelect = (key) => {
    setTheme(key);
    applyTheme(key);
  };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.appearance.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        {t('admin.appearance.description')}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {Object.entries(THEMES).map(([key, themeObj]) => (
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
              {themeObj.preview.map((c, i) => (
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
                  {themeObj.label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {themeObj.description}
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
function IconBtn({ children, onClick, title, danger, disabled }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={disabled ? undefined : onClick} title={title} disabled={disabled}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: hov && !disabled ? (danger ? 'rgba(248,113,113,0.1)' : 'var(--bg-hover)') : 'transparent',
        border: `1px solid ${hov && !disabled ? (danger ? 'rgba(248,113,113,0.3)' : 'var(--border)') : 'transparent'}`,
        borderRadius: 6, padding: '5px', color: danger && hov && !disabled ? 'var(--red)' : 'var(--text-tertiary)',
        cursor: disabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', transition: 'all 0.1s',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ─── Fonts Tab ───────────────────────────────────────────────────────────────
function FontsTab() {
  const { t } = useTranslation();
  const { fontSet, setFontSet, fontSize, setFontSize } = useStore();
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
      {/* Font size */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
            {t('admin.appearance.fontSize')}
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--accent)' }}>{fontSize}%</div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 14 }}>
          {t('admin.appearance.fontSizeDescription')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', minWidth: 28 }}>80%</span>
          <input
            type="range"
            min={80}
            max={130}
            step={5}
            value={fontSize}
            onChange={e => setFontSize(parseInt(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer' }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', minWidth: 32, textAlign: 'right' }}>130%</span>
        </div>
        {fontSize !== 100 && (
          <button
            onClick={() => setFontSize(100)}
            style={{
              marginTop: 8, fontSize: 12, color: 'var(--text-secondary)',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}
          >
            {t('admin.appearance.fontSizeReset')}
          </button>
        )}
      </div>

      {/* Typography */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('admin.appearance.typography')}
        </div>
        {!fontsReady && (
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('admin.appearance.typographyLoading')}</div>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        {t('admin.appearance.typographyDescription')}
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
                      {t('admin.appearance.typographyDisplay')}
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
                      {t('admin.appearance.typographyBody')}
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
                      {t('admin.appearance.typographyMono')}
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
function SwipeActionIcon({ action, size = 17 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (action === 'star') return <svg {...common}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
  if (action === 'delete') return <svg {...common}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/></svg>;
  if (action === 'markRead') return <svg {...common}><path d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2v-9"/><polyline points="22 9 12 16 2 9"/><polyline points="2 9 12 2 22 9"/></svg>;
  if (action === 'reply') return <svg {...common}><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>;
  if (action === 'replyAll') return <svg {...common}><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 00-4-4H7"/></svg>;
  if (action === 'disabled') return <svg {...common}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
  return <svg {...common}><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/><polyline points="9 13 12 16 15 13"/><line x1="12" y1="11" x2="12" y2="16"/></svg>;
}

function LayoutsTab() {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const { layout, setLayout, pageSize, setPageSize, scrollMode, setScrollMode, swipeActions, setSwipeAction, syncInterval, setSyncInterval, threadedView, setThreadedView, plaintextEmail, setPlaintextEmail, hoverQuickActions, setHoverQuickActions, replyDefault, setReplyDefault } = useStore();

  const handleSelect = (key) => {
    setLayout(key);
    applyLayout(key);
  };

  const swipeOptions = [
    { id: 'star', label: t('admin.messageList.swipeStar'), desc: t('admin.messageList.swipeStarDesc') },
    { id: 'archive', label: t('admin.messageList.swipeArchive'), desc: t('admin.messageList.swipeArchiveDesc') },
    { id: 'delete', label: t('admin.messageList.swipeDelete'), desc: t('admin.messageList.swipeDeleteDesc') },
    { id: 'markRead', label: t('admin.messageList.swipeMarkRead'), desc: t('admin.messageList.swipeMarkReadDesc') },
    { id: 'reply', label: t('admin.messageList.swipeReply'), desc: t('admin.messageList.swipeReplyDesc') },
    { id: 'replyAll', label: t('admin.messageList.swipeReplyAll'), desc: t('admin.messageList.swipeReplyAllDesc') },
    { id: 'disabled', label: t('admin.messageList.swipeDisabled'), desc: t('admin.messageList.swipeDisabledDesc') },
  ];

  const renderSwipePicker = (direction, title) => (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{title}</div>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
        {swipeOptions.map((option, i) => {
          const active = (swipeActions?.[direction] || (direction === 'left' ? 'archive' : 'markRead')) === option.id;
          return (
            <button
              key={option.id}
              onClick={() => setSwipeAction(direction, option.id)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                padding: '11px 12px', border: 'none',
                borderBottom: i < swipeOptions.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                background: active ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{ color: active ? 'var(--accent)' : 'var(--text-tertiary)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <SwipeActionIcon action={option.id} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 500 }}>{option.label}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{option.desc}</span>
              </span>
              {active && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.appearance.layout')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        {t('admin.appearance.layoutDescription')}
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
          {t('admin.messageList.title')}
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{t('admin.messageList.scrollingMode')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { id: 'infinite',   label: t('admin.messageList.infiniteScroll'), desc: t('admin.messageList.infiniteScrollDesc') },
              { id: 'paginated',  label: t('admin.messageList.paginated'),       desc: t('admin.messageList.paginatedDesc') },
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

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {scrollMode === 'paginated' ? t('admin.messageList.perPagePaginated') : t('admin.messageList.perPageInfinite')}
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

        {/* Hover quick actions */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {t('admin.messageList.hoverQuickActionsMode')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { id: false, label: t('admin.messageList.hoverQuickActionsOff'), desc: t('admin.messageList.hoverQuickActionsOffDesc') },
              { id: true, label: t('admin.messageList.hoverQuickActionsOn'), desc: t('admin.messageList.hoverQuickActionsOnDesc') },
            ].map(({ id, label, desc }) => {
              const active = hoverQuickActions === id;
              return (
                <button
                  key={String(id)}
                  onClick={() => setHoverQuickActions(id)}
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

        {isMobile && (
          <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {t('admin.messageList.swipeActions')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
              {renderSwipePicker('left', t('admin.messageList.swipeLeft'))}
              {renderSwipePicker('right', t('admin.messageList.swipeRight'))}
            </div>
          </div>
        )}
      </div>

      {/* Sync interval */}
      <div style={{ marginTop: 28, paddingTop: 22, borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.messageList.syncFrequency')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
          {t('admin.messageList.syncFrequencyDesc')}
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

      {/* Threading mode */}
      <div style={{ marginTop: 28, paddingTop: 22, borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.messageList.threadingMode')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { id: false, label: t('admin.messageList.threadingOff'), desc: t('admin.messageList.threadingOffDesc') },
            { id: true,  label: t('admin.messageList.threadingOn'),  desc: t('admin.messageList.threadingOnDesc') },
          ].map(({ id, label, desc }) => {
            const active = threadedView === id;
            return (
              <button
                key={String(id)}
                onClick={() => setThreadedView(id)}
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

      {/* Compose format */}
      <div style={{ marginTop: 28, paddingTop: 22, borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.messageList.composeFormat')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { id: false, label: t('admin.messageList.composeRichText'),  desc: t('admin.messageList.composeRichTextDesc') },
            { id: true,  label: t('admin.messageList.composePlainText'), desc: t('admin.messageList.composePlainTextDesc') },
          ].map(({ id, label, desc }) => {
            const active = plaintextEmail === id;
            return (
              <button
                key={String(id)}
                onClick={() => setPlaintextEmail(id)}
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

      {/* Default reply action */}
      <div style={{ marginTop: 28, paddingTop: 22, borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.messageList.defaultReplyAction')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { id: 'reply',    label: t('admin.messageList.defaultReply'),    desc: t('admin.messageList.defaultReplyDesc') },
            { id: 'replyAll', label: t('admin.messageList.defaultReplyAll'), desc: t('admin.messageList.defaultReplyAllDesc') },
          ].map(({ id, label, desc }) => {
            const active = replyDefault === id;
            return (
              <button
                key={id}
                onClick={() => setReplyDefault(id)}
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
    </div>
  );
}

// ─── Integrations Tab ────────────────────────────────────────────────────────
function IntegrationsTab() {
  const { t } = useTranslation();
  const { setAccounts } = useStore();
  const [configs, setConfigs] = useState({});
  const [loading, setLoading] = useState(true);
  const [msForm, setMsForm] = useState({ clientId: '', clientSecret: '', tenantId: '', redirectUri: '' });
  const [msExpanded, setMsExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [connectingMs, setConnectingMs] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState(null); // { userCode, verificationUri, interval }
  const [deviceStatus, setDeviceStatus] = useState(null); // 'pending'|'success'|'declined'|'expired'|'error'
  const devicePollRef = useRef(null);

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
        setSaveMsg(t('admin.integrations.microsoft.connectedNote'));
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
    return () => {
      window.removeEventListener('message', handleMessage);
      if (devicePollRef.current) clearInterval(devicePollRef.current);
    };
  }, []);

  const handleSaveMs = async () => {
    if (!msForm.clientId || !msForm.tenantId) {
      setSaveMsg('Client ID and Tenant ID are required');
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
      setSaveMsg(t('admin.integrations.microsoft.savedNote'));
    } catch (err) {
      setSaveMsg('Error: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const stopDeviceFlow = () => {
    if (devicePollRef.current) { clearInterval(devicePollRef.current); devicePollRef.current = null; }
    setDeviceFlow(null);
    setDeviceStatus(null);
  };

  const handleStartDeviceFlow = async () => {
    stopDeviceFlow();
    setDeviceStatus('pending');
    try {
      const data = await api.startMsDeviceFlow();
      setDeviceFlow(data);
      const intervalMs = (data.interval || 5) * 1000;
      devicePollRef.current = setInterval(async () => {
        try {
          const result = await api.pollMsDeviceFlow();
          if (result.status === 'pending') return;
          clearInterval(devicePollRef.current);
          devicePollRef.current = null;
          setDeviceStatus(result.status);
          if (result.status === 'success') {
            setSaveMsg(t('admin.integrations.microsoft.connectedNote'));
            api.getAccounts().then(setAccounts).catch(console.error);
            setTimeout(stopDeviceFlow, 3000);
          }
        } catch (err) {
          clearInterval(devicePollRef.current);
          devicePollRef.current = null;
          setDeviceStatus('error');
        }
      }, intervalMs);
    } catch (err) {
      setDeviceStatus('error');
      setSaveMsg('Error: ' + err.message);
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
        {t('admin.integrations.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 24 }}>
        {t('admin.integrations.description')}
      </div>

      {loading && <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('admin.integrations.loading')}</div>}

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
                  {t('admin.integrations.microsoft.title')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1 }}>
                  {t('admin.integrations.microsoft.description')}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {msConfigured ? (
                  <span style={{
                    fontSize: 11, padding: '3px 8px', borderRadius: 20,
                    background: 'rgba(74,222,128,0.1)', color: 'var(--green)',
                    border: '1px solid rgba(74,222,128,0.2)', fontWeight: 500,
                  }}>
                    {t('admin.integrations.microsoft.configured')}
                  </span>
                ) : (
                  <span style={{
                    fontSize: 11, padding: '3px 8px', borderRadius: 20,
                    background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
                    border: '1px solid var(--border)',
                  }}>
                    {t('admin.integrations.microsoft.notConfigured')}
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
                    {t('admin.integrations.microsoft.setupTitle')}
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    <li>{t('admin.integrations.microsoft.step1')}</li>
                    <li>{t('admin.integrations.microsoft.step2')}</li>
                    <li>{t('admin.integrations.microsoft.step3')}</li>
                    <li>{t('admin.integrations.microsoft.step4')}</li>
                    <li>{t('admin.integrations.microsoft.step5')}</li>
                    <li>{t('admin.integrations.microsoft.step6')}</li>
                  </ol>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <Field label={t('admin.integrations.microsoft.clientId')} required>
                    <input value={msForm.clientId} onChange={e => setMsForm(f => ({ ...f, clientId: e.target.value }))}
                      placeholder={t('admin.integrations.microsoft.clientIdPh')}
                      style={{ ...inputStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                      onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                      onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                  </Field>
                  <Field label={t('admin.integrations.microsoft.tenantId')} required>
                    <input value={msForm.tenantId} onChange={e => setMsForm(f => ({ ...f, tenantId: e.target.value }))}
                      placeholder={t('admin.integrations.microsoft.tenantIdPh')}
                      style={{ ...inputStyle, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
                      onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                      onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>
                      {t('admin.integrations.microsoft.tenantIdNote')}
                    </div>
                  </Field>
                </div>

                <Field label={t('admin.integrations.microsoft.clientSecret')} required>
                  <input type="password" value={msForm.clientSecret}
                    onChange={e => setMsForm(f => ({ ...f, clientSecret: e.target.value }))}
                    placeholder={t('admin.integrations.microsoft.clientSecretPh')}
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                </Field>

                <Field label={t('admin.integrations.microsoft.redirectUri')} required>
                  <input value={msForm.redirectUri}
                    onChange={e => setMsForm(f => ({ ...f, redirectUri: e.target.value }))}
                    placeholder={`http://${window.location.hostname}:8080/oauth/microsoft/callback`}
                    style={inputStyle}
                    onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>
                    {t('admin.integrations.microsoft.redirectUriNote', { uri: `${window.location.protocol}//${window.location.hostname}${window.location.port ? ':' + window.location.port : ''}/oauth/microsoft/callback` })}
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
                    {saving ? t('common.saving') : t('admin.integrations.microsoft.save')}
                  </button>

                  <button
                    onClick={handleConnectMs}
                    disabled={!msConfigured || connectingMs}
                    title={!msConfigured ? t('admin.integrations.microsoft.save') : ''}
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
                    {connectingMs ? t('admin.integrations.microsoft.redirecting') : t('admin.integrations.microsoft.connect')}
                  </button>

                  {msConfigured && (
                    <button onClick={async () => {
                      stopDeviceFlow();
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
                      {t('admin.integrations.microsoft.remove')}
                    </button>
                  )}
                </div>

                {/* Device code flow */}
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    {t('admin.integrations.microsoft.deviceCodeTitle')}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10, lineHeight: 1.5 }}>
                    {t('admin.integrations.microsoft.deviceCodeNote')}
                  </div>

                  {!deviceFlow && (
                    <button
                      onClick={handleStartDeviceFlow}
                      disabled={!msConfigured}
                      title={!msConfigured ? t('admin.integrations.microsoft.save') : ''}
                      style={{
                        padding: '8px 14px', background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)', borderRadius: 8,
                        color: msConfigured ? 'var(--text-primary)' : 'var(--text-tertiary)',
                        cursor: msConfigured ? 'pointer' : 'not-allowed',
                        fontSize: 12, fontWeight: 500, opacity: msConfigured ? 1 : 0.5,
                      }}
                    >
                      {t('admin.integrations.microsoft.deviceCodeStart')}
                    </button>
                  )}

                  {deviceFlow && (
                    <div style={{
                      padding: '14px 16px', borderRadius: 8,
                      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                    }}>
                      {deviceStatus === 'success' ? (
                        <div style={{ color: 'var(--green)', fontSize: 13, fontWeight: 500 }}>
                          {t('admin.integrations.microsoft.connectedNote')}
                        </div>
                      ) : deviceStatus === 'declined' ? (
                        <div style={{ color: 'var(--red)', fontSize: 13 }}>{t('admin.integrations.microsoft.deviceCodeDeclined')}</div>
                      ) : deviceStatus === 'expired' ? (
                        <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('admin.integrations.microsoft.deviceCodeExpired')}</div>
                      ) : deviceStatus === 'error' ? (
                        <div style={{ color: 'var(--red)', fontSize: 13 }}>{t('admin.integrations.microsoft.deviceCodeError')}</div>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
                            {t('admin.integrations.microsoft.deviceCodeInstructions')}
                          </div>
                          <div style={{ marginBottom: 8 }}>
                            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginRight: 6 }}>
                              {t('admin.integrations.microsoft.deviceCodeVisit')}
                            </span>
                            <a href={deviceFlow.verificationUri} target="_blank" rel="noreferrer"
                              style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500 }}>
                              {deviceFlow.verificationUri}
                            </a>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                              {t('admin.integrations.microsoft.deviceCodeEnter')}
                            </span>
                            <span style={{
                              fontFamily: 'JetBrains Mono, monospace', fontSize: 20, fontWeight: 700,
                              letterSpacing: '0.15em', color: 'var(--text-primary)',
                              padding: '6px 14px', background: 'var(--bg-tertiary)',
                              border: '1px solid var(--border)', borderRadius: 6,
                            }}>
                              {deviceFlow.userCode}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.5s linear infinite' }}>
                              <path d="M21 12a9 9 0 11-6.219-8.56"/>
                            </svg>
                            {t('admin.integrations.microsoft.deviceCodeWaiting')}
                          </div>
                        </>
                      )}
                      {deviceStatus !== 'success' && (
                        <button onClick={stopDeviceFlow} style={{
                          marginTop: 10, padding: '5px 10px', background: 'transparent',
                          border: '1px solid var(--border)', borderRadius: 6,
                          color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 11,
                        }}>
                          {t('admin.integrations.microsoft.deviceCodeCancel')}
                        </button>
                      )}
                    </div>
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
// ─── SSO / OIDC Tab ───────────────────────────────────────────────────────────

// Provider templates — pre-fill the OIDC form with known-good defaults.
// issuer_url values that contain placeholder text (your-domain, your-realm, etc.)
// must be edited by the user before saving.
const SSO_TEMPLATES = [
  {
    id: 'pocketid',
    name: 'PocketID',
    slug: 'pocketid',
    color: '#6366f1',
    description: 'Lightweight self-hosted OIDC',
    issuer_url: 'https://your-pocketid-domain.com',
    scopes: 'openid email profile',
    note: 'Set the issuer URL to the root URL of your PocketID instance. The client ID and secret are created under Admin → Clients.',
  },
  {
    id: 'authentik',
    name: 'Authentik',
    slug: 'authentik',
    color: '#7c3aed',
    description: 'Self-hosted identity provider',
    issuer_url: 'https://auth.example.com/application/o/your-app-slug/',
    scopes: 'openid email profile',
    note: 'Replace "your-app-slug" with the slug of your Authentik OAuth2/OIDC Provider application. Include the trailing slash.',
  },
  {
    id: 'authelia',
    name: 'Authelia',
    slug: 'authelia',
    color: '#f59e0b',
    description: 'Self-hosted authentication portal',
    issuer_url: 'https://auth.example.com',
    scopes: 'openid email profile groups',
    note: 'Set the issuer URL to the root URL of your Authelia instance. Define the client in your Authelia identity_providers.oidc.clients config.',
  },
  {
    id: 'keycloak',
    name: 'Keycloak',
    slug: 'keycloak',
    color: '#ef4444',
    description: 'Enterprise identity management',
    issuer_url: 'https://keycloak.example.com/realms/your-realm',
    scopes: 'openid email profile',
    note: 'Replace "your-realm" with your Keycloak realm name. Create the client under Clients → Create client (type: OpenID Connect).',
  },
  {
    id: 'zitadel',
    name: 'ZITADEL',
    slug: 'zitadel',
    color: '#14b8a6',
    description: 'Cloud-native identity platform',
    issuer_url: 'https://your-instance.zitadel.cloud',
    scopes: 'openid email profile',
    note: 'Use your ZITADEL instance URL. Create a Web application under Projects and set the redirect URI. The issuer is shown on the instance overview page.',
  },
  {
    id: 'kanidm',
    name: 'Kanidm',
    slug: 'kanidm',
    color: '#8b5cf6',
    description: 'Modern Rust-based identity manager',
    issuer_url: 'https://idm.example.com/oauth2/openid/client-name',
    scopes: 'openid email profile',
    note: 'Replace "client-name" with your OAuth2 RS256 client name. Create the client with: kanidm system oauth2 create <name> <displayname> <origin>',
  },
  {
    id: 'dex',
    name: 'Dex',
    slug: 'dex',
    color: '#0ea5e9',
    description: 'Federated OpenID Connect provider',
    issuer_url: 'https://dex.example.com',
    scopes: 'openid email profile offline_access',
    note: 'Set the issuer URL to the root URL of your Dex instance (must match the issuer field in your Dex config.yaml).',
  },
  {
    id: 'casdoor',
    name: 'Casdoor',
    slug: 'casdoor',
    color: '#f97316',
    description: 'Open-source IAM / SSO platform',
    issuer_url: 'https://your-casdoor-domain.com',
    scopes: 'openid email profile',
    note: 'Set the issuer URL to your Casdoor instance root. Create an Application in Casdoor and copy the Client ID and Secret from it.',
  },
  {
    id: 'google',
    name: 'Google',
    slug: 'google',
    color: '#4285F4',
    description: 'Google Workspace or personal accounts',
    issuer_url: 'https://accounts.google.com',
    scopes: 'openid email profile',
    note: 'Create an OAuth 2.0 Client ID in Google Cloud Console under APIs & Services → Credentials. Set the authorized redirect URI to the callback URL shown below.',
  },
  {
    id: 'entra',
    name: 'Microsoft Entra',
    slug: 'entra',
    color: '#0078d4',
    description: 'Azure AD / Microsoft 365',
    issuer_url: 'https://login.microsoftonline.com/your-tenant-id/v2.0',
    scopes: 'openid email profile',
    note: 'Replace "your-tenant-id" with your Azure directory (tenant) ID. Register an app in Entra ID and add the callback URL as a Web redirect URI.',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    slug: 'gitlab',
    color: '#FC6D26',
    description: 'GitLab.com or self-hosted GitLab',
    issuer_url: 'https://gitlab.com',
    scopes: 'openid email profile',
    note: 'For self-hosted GitLab, replace the issuer URL with your instance URL. Create an application under Admin Area → Applications (or user/group settings).',
  },
  {
    id: 'custom',
    name: 'Custom',
    slug: '',
    color: '#6b7280',
    description: 'Any OIDC-compatible provider',
    issuer_url: '',
    scopes: 'openid email profile',
    note: '',
  },
];

const emptyProvider = {
  name: '', slug: '', issuer_url: '', client_id: '', client_secret: '',
  scopes: 'openid email profile', provisioning_mode: 'login_existing_only',
  allowed_domains: '', enabled: true, require_email_verified: true, allow_insecure: false,
};

function SSOTab() {
  const { t } = useTranslation();
  const PROVISIONING_MODES = [
    { value: 'disabled', label: t('admin.sso.provisioningDisabled') },
    { value: 'login_existing_only', label: t('admin.sso.provisioningExisting') },
    { value: 'open', label: t('admin.sso.provisioningOpen') },
  ];
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | 'new' | provider object
  const [form, setForm] = useState(emptyProvider);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [templateNote, setTemplateNote] = useState('');
  const [internalAuthDisabled, setInternalAuthDisabled] = useState(false);
  const [internalAuthSaving, setInternalAuthSaving] = useState(false);
  const [internalAuthError, setInternalAuthError] = useState('');

  useEffect(() => {
    const fetchProviders = api.admin.oidc.getProviders()
      .then(d => setProviders(d.providers))
      .catch(console.error);
    const fetchSettings = api.admin.getSettings()
      .then(d => setInternalAuthDisabled(d.settings.internal_auth_disabled === 'true'))
      .catch(console.error);
    Promise.all([fetchProviders, fetchSettings]).finally(() => setLoading(false));
  }, []);

  const handleToggleInternalAuth = () => {
    setInternalAuthError('');
    if (!internalAuthDisabled) {
      setConfirmDialog({
        title: t('admin.sso.passwordLoginDisableTitle'),
        message: t('admin.sso.passwordLoginDisableMsg'),
        confirmLabel: t('admin.sso.passwordLoginDisableConfirm'),
        onConfirm: async () => {
          setInternalAuthSaving(true);
          try {
            await api.admin.updateSettings({ internal_auth_disabled: true });
            setInternalAuthDisabled(true);
          } catch (err) {
            setInternalAuthError(err.message);
          } finally {
            setInternalAuthSaving(false);
          }
        },
      });
    } else {
      setInternalAuthSaving(true);
      api.admin.updateSettings({ internal_auth_disabled: false })
        .then(() => setInternalAuthDisabled(false))
        .catch(err => setInternalAuthError(err.message))
        .finally(() => setInternalAuthSaving(false));
    }
  };

  const openNew = () => { setEditing('picking'); setError(''); };

  const applyTemplate = (tmpl) => {
    setForm({ ...emptyProvider, name: tmpl.id === 'custom' ? '' : tmpl.name, slug: tmpl.slug, issuer_url: tmpl.issuer_url, scopes: tmpl.scopes });
    setTemplateNote(tmpl.note || '');
    setEditing('new');
    setError('');
  };
  const openEdit = (p) => {
    setForm({ ...p, client_secret: '••••••••', allowed_domains: p.allowed_domains || '', require_email_verified: p.require_email_verified !== false, allow_insecure: p.allow_insecure === true });
    setTemplateNote('');
    setEditing(p);
    setError('');
  };
  const closeForm = () => { setEditing(null); setTemplateNote(''); setError(''); };

  const handleSave = async () => {
    if (!form.name || !form.slug || !form.issuer_url || !form.client_id) {
      return setError(t('admin.sso.errorRequired'));
    }
    if (editing === 'new' && !form.client_secret) {
      return setError(t('admin.sso.errorSecretRequired'));
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        slug: form.slug.trim(),
        issuer_url: form.issuer_url.trim(),
        client_id: form.client_id.trim(),
        scopes: form.scopes.trim() || 'openid email profile',
        provisioning_mode: form.provisioning_mode,
        allowed_domains: form.allowed_domains.trim() || null,
        enabled: form.enabled,
        require_email_verified: !!form.require_email_verified,
        allow_insecure: !!form.allow_insecure,
        ...(form.client_secret && form.client_secret !== '••••••••' ? { client_secret: form.client_secret } : {}),
      };
      if (editing === 'new') {
        if (!payload.client_secret) return setError(t('admin.sso.errorSecretRequired'));
        const data = await api.admin.oidc.createProvider(payload);
        setProviders(ps => [...ps, data.provider]);
      } else {
        const data = await api.admin.oidc.updateProvider(editing.id, payload);
        setProviders(ps => ps.map(p => p.id === editing.id ? data.provider : p));
      }
      closeForm();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (p) => {
    setConfirmDialog({
      title: t('admin.sso.deleteConfirmTitle', { name: p.name }),
      message: t('admin.sso.deleteConfirmBody'),
      confirmLabel: t('admin.sso.deleteConfirmLabel'),
      onConfirm: async () => {
        await api.admin.oidc.deleteProvider(p.id);
        setProviders(ps => ps.filter(x => x.id !== p.id));
      },
    });
  };

  const copyRedirectUri = (slug, id) => {
    const uri = `${window.location.origin}/auth/oidc/${slug}/callback`;
    navigator.clipboard.writeText(uri).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  if (loading) return <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('common.loading')}</div>;

  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{t('admin.sso.title')}</div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        {t('admin.sso.description')}
      </div>

      {/* ── Password login toggle ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.sso.passwordLoginTitle')}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 10 }}>
          {t('admin.sso.passwordLoginDesc')}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 14px', borderRadius: 8,
          background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {internalAuthDisabled ? t('admin.sso.passwordLoginDisabled') : t('admin.sso.passwordLoginEnabled')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {internalAuthDisabled ? t('admin.sso.passwordLoginDisabledDesc') : t('admin.sso.passwordLoginEnabledDesc')}
            </div>
          </div>
          <button
            onClick={handleToggleInternalAuth}
            disabled={internalAuthSaving}
            style={{
              width: 44, height: 24, borderRadius: 12,
              background: internalAuthDisabled ? 'var(--bg-elevated)' : 'var(--accent)',
              border: `1px solid ${internalAuthDisabled ? 'var(--border)' : 'var(--accent)'}`,
              cursor: internalAuthSaving ? 'not-allowed' : 'pointer',
              position: 'relative', transition: 'all 0.2s', flexShrink: 0,
              opacity: internalAuthSaving ? 0.6 : 1,
            }}
          >
            <div style={{
              position: 'absolute', top: 3, left: internalAuthDisabled ? 3 : 22,
              width: 16, height: 16, borderRadius: '50%',
              background: 'white', transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }} />
          </button>
        </div>
        {internalAuthError && (
          <div style={{
            marginTop: 8, padding: '8px 12px',
            background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
            borderRadius: 7, color: 'var(--red)', fontSize: 12,
          }}>{internalAuthError}</div>
        )}
      </div>

      <div style={{ height: 1, background: 'var(--border-subtle)', marginBottom: 20 }} />

      {providers.length === 0 && !editing && (
        <div style={{
          padding: '24px', borderRadius: 8, border: '1px dashed var(--border)',
          textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13, marginBottom: 16,
        }}>
          {t('admin.sso.empty')}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {providers.map(p => (
          <div key={p.id} style={{
            padding: '12px 14px', borderRadius: 8,
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{p.name}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
                    background: p.enabled ? 'rgba(34,197,94,0.15)' : 'var(--bg-elevated)',
                    color: p.enabled ? 'var(--green)' : 'var(--text-tertiary)',
                    border: `1px solid ${p.enabled ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
                    textTransform: 'uppercase', letterSpacing: '0.04em',
                  }}>{p.enabled ? t('admin.sso.activeBadge') : t('admin.sso.disabledBadge')}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: 'monospace' }}>{p.issuer_url}</span>
                </div>
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>{t('admin.integrations.microsoft.redirectUri')}:</span>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {`${window.location.origin}/auth/oidc/${p.slug}/callback`}
                  </span>
                  <button
                    onClick={() => copyRedirectUri(p.slug, p.id)}
                    style={{
                      background: 'none', border: '1px solid var(--border)', borderRadius: 4,
                      color: copiedId === p.id ? 'var(--green)' : 'var(--text-tertiary)',
                      fontSize: 10, padding: '2px 7px', cursor: 'pointer', flexShrink: 0,
                    }}
                  >
                    {copiedId === p.id ? t('admin.sso.copiedUri') : t('admin.sso.copyUri')}
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button onClick={() => openEdit(p)} style={{
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12,
                  padding: '5px 10px', cursor: 'pointer',
                }}>{t('admin.sso.editButton')}</button>
                <button onClick={() => handleDelete(p)} style={{
                  background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
                  borderRadius: 6, color: 'var(--red)', fontSize: 12,
                  padding: '5px 10px', cursor: 'pointer',
                }}>{t('admin.sso.deleteButton')}</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {!editing && (
        <button
          onClick={openNew}
          style={{
            padding: '9px 16px', background: 'var(--accent)', border: 'none',
            borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >{t('admin.sso.addProvider')}</button>
      )}

      {editing === 'picking' && (
        <div style={{
          marginTop: 16, padding: '20px', borderRadius: 10,
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {t('admin.sso.templatePickerTitle')}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
            {t('admin.sso.templatePickerDesc')}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 10,
            marginBottom: 16,
          }}>
            {SSO_TEMPLATES.map(tmpl => (
              <button
                key={tmpl.id}
                onClick={() => applyTemplate(tmpl)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  textAlign: 'left', transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = tmpl.color}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                  background: tmpl.color, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700, color: 'white',
                }}>
                  {tmpl.name.charAt(0)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {tmpl.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {tmpl.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <button
            onClick={closeForm}
            style={{
              padding: '9px 18px', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 7, color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer',
            }}
          >{t('common.cancel')}</button>
        </div>
      )}

      {editing && editing !== 'picking' && (
        <div style={{
          marginTop: 16, padding: '20px', borderRadius: 10,
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16 }}>
            {editing === 'new' ? t('admin.sso.newTitle') : t('admin.sso.editTitle', { name: editing.name })}
          </div>

          <Field label={t('admin.sso.name')} required>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t('admin.sso.namePh')} style={inputStyle} />
          </Field>

          <Field label={t('admin.sso.slug')} required>
            <input
              value={form.slug}
              onChange={e => setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
              placeholder={t('admin.sso.slugPh')}
              style={inputStyle}
            />
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
              {t('admin.sso.slugRedirectUri', { uri: `${window.location.origin}/auth/oidc/${form.slug || '<slug>'}/callback` })}
            </div>
          </Field>

          <Field label={t('admin.sso.issuerUrl')} required>
            <input value={form.issuer_url} onChange={e => setForm(f => ({ ...f, issuer_url: e.target.value }))} placeholder={t('admin.sso.issuerUrlPh')} style={inputStyle} />
          </Field>

          {templateNote && (
            <div style={{
              marginBottom: 14, padding: '10px 12px', borderRadius: 7,
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
              color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5,
            }}>
              {templateNote}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label={t('admin.sso.clientId')} required>
              <input value={form.client_id} onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} placeholder={t('admin.sso.clientIdPh')} style={inputStyle} />
            </Field>
            <Field label={editing === 'new' ? t('admin.sso.clientSecretNew') : t('admin.sso.clientSecretEdit')} required={editing === 'new'}>
              <input
                type="password"
                value={form.client_secret}
                onChange={e => setForm(f => ({ ...f, client_secret: e.target.value }))}
                placeholder={editing === 'new' ? t('admin.sso.clientSecretPhNew') : t('admin.sso.clientSecretPhEdit')}
                style={inputStyle}
              />
            </Field>
          </div>

          <Field label={t('admin.sso.scopes')}>
            <input value={form.scopes} onChange={e => setForm(f => ({ ...f, scopes: e.target.value }))} placeholder={t('admin.sso.scopesPh')} style={inputStyle} />
          </Field>

          <Field label={t('admin.sso.domains')}>
            <input value={form.allowed_domains} onChange={e => setForm(f => ({ ...f, allowed_domains: e.target.value }))} placeholder={t('admin.sso.domainsPh')} style={inputStyle} />
          </Field>

          <Field label={t('admin.sso.provisioning')}>
            <select
              value={form.provisioning_mode}
              onChange={e => setForm(f => ({ ...f, provisioning_mode: e.target.value }))}
              style={{ ...inputStyle, appearance: 'none' }}
            >
              {PROVISIONING_MODES.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </Field>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setForm(f => ({ ...f, enabled: !f.enabled }))}
              style={{
                width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0,
                background: form.enabled ? 'var(--accent)' : 'var(--bg-elevated)',
                position: 'relative', transition: 'background 0.2s',
              }}
            >
              <span style={{
                position: 'absolute', top: 2, left: form.enabled ? 18 : 2, width: 16, height: 16,
                borderRadius: '50%', background: 'white', transition: 'left 0.2s',
              }} />
            </button>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.sso.enabled')}</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16 }}>
            <button
              type="button"
              onClick={() => setForm(f => ({ ...f, require_email_verified: !f.require_email_verified }))}
              style={{
                width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0,
                background: form.require_email_verified ? 'var(--accent)' : 'var(--bg-elevated)',
                position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginTop: 1,
              }}
            >
              <span style={{
                position: 'absolute', top: 2, left: form.require_email_verified ? 18 : 2, width: 16, height: 16,
                borderRadius: '50%', background: 'white', transition: 'left 0.2s',
              }} />
            </button>
            <div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.sso.requireEmailVerified')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t('admin.sso.requireEmailVerifiedDesc')}</div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16 }}>
            <button
              type="button"
              onClick={() => setForm(f => ({ ...f, allow_insecure: !f.allow_insecure }))}
              style={{
                width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0,
                background: form.allow_insecure ? 'var(--amber)' : 'var(--bg-elevated)',
                position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginTop: 1,
              }}
            >
              <span style={{
                position: 'absolute', top: 2, left: form.allow_insecure ? 18 : 2, width: 16, height: 16,
                borderRadius: '50%', background: 'white', transition: 'left 0.2s',
              }} />
            </button>
            <div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.sso.allowInsecure')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t('admin.sso.allowInsecureDesc')}</div>
            </div>
          </div>

          {error && (
            <div style={{
              marginBottom: 14, padding: '9px 12px', borderRadius: 7,
              background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
              color: 'var(--red)', fontSize: 13,
            }}>{error}</div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: '9px 18px', background: 'var(--accent)', border: 'none',
                borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500,
                cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
              }}
            >{saving ? t('common.saving') : t('admin.sso.save')}</button>
            <button
              onClick={closeForm}
              style={{
                padding: '9px 18px', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 7, color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer',
              }}
            >{t('common.cancel')}</button>
          </div>
        </div>
      )}

      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />
    </>
  );
}

// ─── System Email Section ─────────────────────────────────────────────────────
function SystemEmailSection() {
  const { t } = useTranslation();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ host: '', port: '587', tls: 'STARTTLS', user: '', pass: '', fromName: 'MailFlow', fromEmail: '' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    api.admin.getSystemEmail()
      .then(({ config: cfg }) => {
        if (cfg) {
          setConfig(cfg);
          setForm({ host: cfg.host || '', port: String(cfg.port || 587), tls: cfg.tls || 'STARTTLS', user: cfg.user || '', pass: cfg.pass || '', fromName: cfg.fromName || 'MailFlow', fromEmail: cfg.fromEmail || '' });
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      await api.admin.saveSystemEmail(form);
      setConfig({ ...form });
      setMsg({ type: 'ok', text: t('admin.systemEmail.saved') });
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    } finally { setSaving(false); }
  };

  const handleTest = async () => {
    setTesting(true); setMsg(null);
    try {
      await api.admin.testSystemEmail();
      setMsg({ type: 'ok', text: t('admin.systemEmail.testOk') });
    } catch (err) {
      setMsg({ type: 'error', text: `${t('admin.systemEmail.testFail')}: ${err.message}` });
    } finally { setTesting(false); }
  };

  const handleRemove = async () => {
    await api.admin.deleteSystemEmail();
    setConfig(null);
    setForm({ host: '', port: '587', tls: 'STARTTLS', user: '', pass: '', fromName: 'MailFlow', fromEmail: '' });
    setMsg({ type: 'ok', text: t('admin.systemEmail.removed') });
  };

  const field = (label, key, type = 'text', placeholder = '') => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{label}</label>
      <input
        type={type}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        placeholder={placeholder}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        style={{ width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', color: 'var(--text-primary)', fontSize: 13 }}
      />
    </div>
  );

  if (loading) return <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('common.loading')}</div>;

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 20 }}>
        {t('admin.systemEmail.description')}
      </p>

      {config && (
        <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{config.fromName} &lt;{config.fromEmail || config.user}&gt;</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{config.host}:{config.port} · {config.tls}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleTest} disabled={testing} style={{ fontSize: 12, padding: '5px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              {testing ? t('admin.systemEmail.testing') : t('admin.systemEmail.test')}
            </button>
            <button onClick={handleRemove} style={{ fontSize: 12, padding: '5px 12px', background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--red)', cursor: 'pointer' }}>
              {t('common.remove')}
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSave}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: '0 12px' }}>
          <div>
            {field(t('admin.systemEmail.host'), 'host', 'text', 'smtp.example.com')}
          </div>
          <div>
            {field(t('admin.systemEmail.port'), 'port', 'number', '587')}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{t('admin.systemEmail.encryption')}</label>
          <select value={form.tls} onChange={e => setForm(f => ({ ...f, tls: e.target.value }))}
            style={{ width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', color: 'var(--text-primary)', fontSize: 13 }}>
            <option value="STARTTLS">STARTTLS (port 587)</option>
            <option value="SSL">SSL/TLS (port 465)</option>
            <option value="none">None (port 25)</option>
          </select>
        </div>

        {field(t('admin.systemEmail.username'), 'user', 'text', 'noreply@example.com')}
        {field(t('admin.systemEmail.password'), 'pass', 'password', config ? t('admin.systemEmail.passPlaceholder') : '')}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
          <div>{field(t('admin.systemEmail.fromName'), 'fromName', 'text', 'MailFlow')}</div>
          <div>{field(t('admin.systemEmail.fromEmail'), 'fromEmail', 'text', t('admin.systemEmail.fromEmailPh'))}</div>
        </div>

        {msg && (
          <div style={{ padding: '8px 12px', borderRadius: 6, marginBottom: 14, fontSize: 13,
            background: msg.type === 'ok' ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
            color: msg.type === 'ok' ? 'var(--green)' : 'var(--red)',
            border: `1px solid ${msg.type === 'ok' ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'}`,
          }}>
            {msg.text}
          </div>
        )}

        <button type="submit" disabled={saving || !form.host || !form.user}
          style={{ padding: '8px 18px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: (saving || !form.host || !form.user) ? 0.5 : 1 }}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </form>
    </div>
  );
}

// ─── Users Tab ────────────────────────────────────────────────────────────────
function UsersTab() {
  const { t } = useTranslation();
  return (
    <SubTabs tabs={[
      { id: 'users', label: t('admin.systemEmail.tabUsers'), content: <UsersAndInvitesPanel /> },
      { id: 'systememail', label: t('admin.systemEmail.tabEmail'), content: <SystemEmailSection /> },
    ]} />
  );
}

function UsersAndInvitesPanel() {
  const { t } = useTranslation();
  const { user: currentUser } = useStore();
  const [users, setUsers] = useState([]);
  const [userTotal, setUserTotal] = useState(0);
  const [usersLoadingMore, setUsersLoadingMore] = useState(false);
  const [invites, setInvites] = useState([]);
  const [inviteTotal, setInviteTotal] = useState(0);
  const [invitesLoadingMore, setInvitesLoadingMore] = useState(false);
  const [regOpen, setRegOpen] = useState(null); // null = loading
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteMsg, setInviteMsg] = useState(null); // { type: 'ok'|'error', text, url? }
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    Promise.all([
      api.admin.getUsers({ limit: 100, offset: 0 }),
      api.admin.getSettings(),
      api.admin.getInvites({ limit: 100, offset: 0 }),
    ]).then(([usersData, settingsData, invitesData]) => {
      setUsers(usersData.users);
      setUserTotal(usersData.total);
      setRegOpen(settingsData.settings.registration_open === 'true');
      setInvites(invitesData.invites);
      setInviteTotal(invitesData.total);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const handleLoadMoreUsers = async () => {
    setUsersLoadingMore(true);
    try {
      const data = await api.admin.getUsers({ limit: 100, offset: users.length });
      setUsers(prev => [...prev, ...data.users]);
      setUserTotal(data.total);
    } catch (err) {
      console.error(err);
    } finally {
      setUsersLoadingMore(false);
    }
  };

  const handleLoadMoreInvites = async () => {
    setInvitesLoadingMore(true);
    try {
      const data = await api.admin.getInvites({ limit: 100, offset: invites.length });
      setInvites(prev => [...prev, ...data.invites]);
      setInviteTotal(data.total);
    } catch (err) {
      console.error(err);
    } finally {
      setInvitesLoadingMore(false);
    }
  };

  const handleToggleAdmin = async (u) => {
    const newVal = !u.isAdmin;
    await api.admin.updateUser(u.id, { isAdmin: newVal });
    setUsers(us => us.map(x => x.id === u.id ? { ...x, isAdmin: newVal } : x));
  };

  const handleDeleteUser = (u) => {
    setConfirmDialog({
      title: t('admin.users.deleteConfirmTitle', { username: u.username }),
      message: t('admin.users.deleteConfirmBody'),
      confirmLabel: t('admin.users.deleteConfirmLabel'),
      onConfirm: async () => {
        await api.admin.deleteUser(u.id);
        setUsers(us => us.filter(x => x.id !== u.id));
      },
    });
  };

  const handleDisableTotp = (u) => {
    setConfirmDialog({
      title: t('admin.users.disable2faConfirmTitle', { username: u.username }),
      message: t('admin.users.disable2faConfirmBody'),
      confirmLabel: t('admin.users.disable2faConfirmLabel'),
      onConfirm: async () => {
        await api.admin.disableUserTotp(u.id);
        setUsers(us => us.map(x => x.id === u.id ? { ...x, totpEnabled: false } : x));
      },
    });
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
        setInviteMsg({ type: 'ok', text: t('admin.users.inviteSent', { email: inviteEmail }), url: data.inviteUrl });
      } else {
        setInviteMsg({ type: 'ok', text: t('admin.users.inviteCreatedNoEmail'), url: data.inviteUrl });
      }
      // Reload invites from offset 0 to get proper data including the new entry
      api.admin.getInvites({ limit: 100, offset: 0 }).then(d => {
        setInvites(d.invites);
        setInviteTotal(d.total);
      }).catch(() => {});
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
    return <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('common.loading')}</div>;
  }

  const pendingInvites = invites.filter(i => !i.used_at && new Date(i.expires_at) > new Date());
  const usedOrExpiredInvites = invites.filter(i => i.used_at || new Date(i.expires_at) <= new Date());

  return (
    <>
    <div>
      {/* ── Users ── */}
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.users.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        {t('admin.users.description')}
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
                    {t('admin.users.adminBadge')}
                  </span>
                )}
                {u.id === currentUser?.id && (
                  <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{t('admin.users.you')}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>
                {t('admin.users.joined', { date: new Date(u.created_at).toLocaleDateString() })}
              </div>
            </div>

            {u.id !== currentUser?.id && (
              <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                <button
                  onClick={() => handleToggleAdmin(u)}
                  title={u.isAdmin ? t('admin.users.removeAdmin') : t('admin.users.makeAdmin')}
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
                  {u.isAdmin ? t('admin.users.removeAdmin') : t('admin.users.makeAdmin')}
                </button>
                {u.totpEnabled && (
                  <IconBtn onClick={() => handleDisableTotp(u)} title={t('admin.users.disable2fa')}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="5" y="11" width="14" height="11" rx="2" ry="2"/>
                      <path d="M11 15v2M8 11V7a4 4 0 018 0v4"/>
                    </svg>
                  </IconBtn>
                )}
                <IconBtn onClick={() => handleDeleteUser(u)} title={t('admin.users.deleteUser')} danger>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                  </svg>
                </IconBtn>
              </div>
            )}
          </div>
        ))}
        {users.length < userTotal && (
          <button
            onClick={handleLoadMoreUsers}
            disabled={usersLoadingMore}
            style={{
              marginTop: 4, padding: '7px 14px', background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)', borderRadius: 6,
              color: 'var(--text-secondary)', fontSize: 12,
              cursor: usersLoadingMore ? 'not-allowed' : 'pointer',
              opacity: usersLoadingMore ? 0.6 : 1, alignSelf: 'flex-start',
            }}
          >
            {usersLoadingMore ? t('common.loading') : t('common.loadMore')}
          </button>
        )}
      </div>

      {/* ── Registration ── */}
      <div style={{ height: 1, background: 'var(--border-subtle)', marginBottom: 20 }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.users.registrationOpen')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 12 }}>
        {t('admin.users.registrationOpenDesc')}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px', borderRadius: 8,
        background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
        marginBottom: 28,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
            {regOpen ? t('admin.users.registrationIsOpen') : t('admin.users.registrationIsClosed')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
            {regOpen ? t('admin.users.registrationStatusOpen') : t('admin.users.registrationStatusClosed')}
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
        {t('admin.users.inviteTitle')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 12 }}>
        {t('admin.users.inviteDescription')}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="email"
          value={inviteEmail}
          onChange={e => setInviteEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSendInvite()}
          placeholder={t('admin.users.invitePh')}
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
          {inviteLoading ? t('admin.users.inviteSending') : t('admin.users.inviteSend')}
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
                {t('common.copy')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Pending invites */}
      {pendingInvites.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8, marginTop: 16 }}>
            {t('admin.users.pendingInvites')}
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
                      {t('admin.users.inviteExpires', { date: new Date(inv.expires_at).toLocaleDateString() })}
                    </div>
                  </div>
                  <button
                    onClick={() => copyInviteUrl(invUrl, inv.id)}
                    title={t('admin.users.inviteCopy')}
                    style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11,
                      background: copiedId === inv.id ? 'rgba(74,222,128,0.1)' : 'var(--bg-elevated)',
                      border: `1px solid ${copiedId === inv.id ? 'rgba(74,222,128,0.3)' : 'var(--border)'}`,
                      color: copiedId === inv.id ? 'var(--green)' : 'var(--text-secondary)',
                      cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s',
                    }}
                  >
                    {copiedId === inv.id ? t('admin.users.inviteCopied') : t('admin.users.inviteCopy')}
                  </button>
                  <IconBtn onClick={() => handleRevokeInvite(inv.id)} title={t('admin.users.inviteRevoke')} danger>
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
            {t('admin.users.usedInvites')}
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
                      ? t('admin.users.inviteUsedBy', { username: inv.used_by_username || 'unknown', date: new Date(inv.used_at).toLocaleDateString() })
                      : t('admin.users.inviteExpired', { date: new Date(inv.expires_at).toLocaleDateString() })}
                  </div>
                </div>
                <IconBtn onClick={() => handleRevokeInvite(inv.id)} title={t('admin.users.inviteDelete')} danger>
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
      {invites.length < inviteTotal && (
        <button
          onClick={handleLoadMoreInvites}
          disabled={invitesLoadingMore}
          style={{
            marginTop: 12, padding: '7px 14px', background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)', borderRadius: 6,
            color: 'var(--text-secondary)', fontSize: 12,
            cursor: invitesLoadingMore ? 'not-allowed' : 'pointer',
            opacity: invitesLoadingMore ? 0.6 : 1,
          }}
        >
          {invitesLoadingMore ? t('common.loading') : t('common.loadMore')}
        </button>
      )}
      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />
    </div>
    </>
  );
}

// ─── Push Notifications Section (inside NotificationsTab) ─────────────────────
function PushNotificationsSection() {
  const { t } = useTranslation();
  const {
    supported, permission, subscribed, serverConfigured, loading,
    subscribe, unsubscribe,
  } = usePushNotifications();

  // Detect iOS devices that need to be installed as a PWA before push works.
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  const showIOSHint = isIOS && !isStandalone;

  const handleToggle = async () => {
    if (subscribed) {
      await unsubscribe();
    } else {
      await subscribe();
    }
  };

  // Status badge colour and label
  let statusColor = 'var(--text-tertiary)';
  let statusLabel = t('admin.push.statusOff');
  if (subscribed) {
    statusColor = 'var(--green, #22c55e)';
    statusLabel = t('admin.push.statusOn');
  } else if (permission === 'denied') {
    statusColor = 'var(--red)';
    statusLabel = t('admin.push.statusDenied');
  }

  return (
    <div style={{ marginTop: 32 }}>
      {/* Divider */}
      <div style={{ height: 1, background: 'var(--border-subtle)', marginBottom: 24 }} />

      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.push.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        {t('admin.push.description')}
      </div>

      {/* Server not configured */}
      {serverConfigured === false && (
        <div style={{
          padding: '12px 16px', borderRadius: 8,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          fontSize: 13, color: 'var(--text-secondary)',
        }}>
          {t('admin.push.notConfigured')}
        </div>
      )}

      {/* Browser not supported */}
      {serverConfigured !== false && !supported && (
        <div style={{
          padding: '12px 16px', borderRadius: 8,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          fontSize: 13, color: 'var(--text-secondary)',
        }}>
          {t('admin.push.notSupported')}
        </div>
      )}

      {/* iOS not-installed hint */}
      {serverConfigured !== false && supported && showIOSHint && !subscribed && (
        <div style={{
          padding: '12px 16px', borderRadius: 8,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderLeft: '3px solid var(--accent)',
          fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16,
        }}>
          {t('admin.push.iosHint')}
        </div>
      )}

      {/* Main toggle row */}
      {serverConfigured !== false && supported && !showIOSHint && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', borderRadius: 10,
          background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                {statusLabel}
              </span>
            </div>
            {permission === 'denied' && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 340 }}>
                {t('admin.push.permissionDenied')}
              </div>
            )}
          </div>

          {permission !== 'denied' && (
            <button
              onClick={handleToggle}
              disabled={loading}
              style={{
                padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 500,
                cursor: loading ? 'wait' : 'pointer',
                background: subscribed ? 'transparent' : 'var(--accent)',
                color: subscribed ? 'var(--text-secondary)' : 'white',
                border: subscribed ? '1px solid var(--border)' : '1px solid transparent',
                opacity: loading ? 0.6 : 1,
                transition: 'all 0.15s',
              }}
            >
              {loading
                ? t('admin.push.loading')
                : subscribed
                  ? t('admin.push.disable')
                  : t('admin.push.enable')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Notifications Tab ────────────────────────────────────────────────────────
function NotificationsTab() {
  const { t } = useTranslation();
  const { notificationSound, setNotificationSound, customSoundDataUrl, setCustomSoundDataUrl,
          showAppBadge, setShowAppBadge, showFaviconBadge, setShowFaviconBadge } = useStore();
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
      setUploadError(t('admin.notifications.uploadError'));
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
    { id: 'none', label: t('admin.notifications.none'), description: t('admin.notifications.noneDesc') },
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
        {t('admin.notifications.title')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        {t('admin.notifications.description')}
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
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{t('admin.notifications.custom')}</div>
                  <div style={{
                    fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    maxWidth: 110,
                  }}>
                    {customFileName || t('admin.notifications.customUpload')}
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
                {customFileName ? t('admin.notifications.customChange') : t('admin.notifications.customButton')}
              </button>

              {uploadError && (
                <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>{uploadError}</div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Unread Badges */}
      <div style={{ marginTop: 32 }}>
        <div style={{ height: 1, background: 'var(--border-subtle)', marginBottom: 24 }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.notifications.badgeTitle')}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
          {t('admin.notifications.badgeDescription')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { label: t('admin.notifications.appBadge'), desc: t('admin.notifications.appBadgeDesc'), value: showAppBadge, set: setShowAppBadge },
            { label: t('admin.notifications.faviconBadge'), desc: t('admin.notifications.faviconBadgeDesc'), value: showFaviconBadge, set: setShowFaviconBadge },
          ].map(({ label, desc, value, set: setter }) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderRadius: 10,
              background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 2 }}>{label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{desc}</div>
              </div>
              <button
                onClick={() => setter(!value)}
                style={{
                  padding: '6px 14px', borderRadius: 7, fontSize: 13, fontWeight: 500,
                  cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0, marginLeft: 16,
                  background: value ? 'var(--accent)' : 'transparent',
                  color: value ? 'white' : 'var(--text-secondary)',
                  border: value ? '1px solid transparent' : '1px solid var(--border)',
                }}
              >
                {value ? t('admin.notifications.badgeOn') : t('admin.notifications.badgeOff')}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Push Notifications */}
      <PushNotificationsSection />
    </div>
  );
}

// ─── Shared confirm overlay (replaces window.confirm everywhere) ──────────────
function ConfirmOverlay({ dialog, onClose }) {
  const { t } = useTranslation();
  if (!dialog) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9100,
      background: 'rgba(0,0,0,0.55)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
      animation: 'backdrop-enter var(--motion-fast) var(--ease-standard) both',
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 12, padding: '24px 24px 20px', maxWidth: 360, width: '100%',
        boxShadow: 'var(--shadow-modal)',
        animation: 'modal-enter var(--motion-normal) var(--ease-emphasized) both',
      }} onClick={e => e.stopPropagation()}>
        <p style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          {dialog.title}
        </p>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {dialog.message}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="btn-press" style={{
            padding: '7px 16px', borderRadius: 7, border: '1px solid var(--border-subtle)',
            background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13,
          }}>{t('common.cancel')}</button>
          <button onClick={() => { onClose(); dialog.onConfirm(); }} className="btn-press" style={{
            padding: '7px 16px', borderRadius: 7, border: 'none',
            background: '#dc2626', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 500,
          }}>{dialog.confirmLabel || t('common.delete')}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Language Tab ─────────────────────────────────────────────────────────────
const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'es', nativeName: 'Español' },
  { code: 'it', nativeName: 'Italiano' },
  { code: 'ru', nativeName: 'Русский' },
  { code: 'zhCN', nativeName: '简体中文'},
];

function LanguageTab() {
  const { t } = useTranslation();
  const { language, setLanguage } = useStore();

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        {t('admin.appearance.language')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 20 }}>
        {t('admin.appearance.languageDescription')}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {LANGUAGES.map(({ code, nativeName }) => {
          const isActive = language === code;
          return (
            <button
              key={code}
              onClick={() => setLanguage(code)}
              style={{
                background: isActive ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
                border: `2px solid ${isActive ? 'var(--accent)' : 'var(--border-subtle)'}`,
                borderRadius: 10, padding: '10px 18px', cursor: 'pointer',
                transition: 'all 0.15s', outline: 'none',
                display: 'flex', alignItems: 'center', gap: 10,
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.borderColor = 'var(--border)'; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
            >
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{nativeName}</span>
              {isActive && (
                <div style={{
                  width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                  background: 'var(--accent)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
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

// ─── Sub-tab navigator (reusable within a top-level tab panel) ───────────────
function SubTabs({ tabs }) {
  const [active, setActive] = useState(tabs[0].id);
  return (
    <div>
      <div style={{
        display: 'flex', gap: 0,
        borderBottom: '1px solid var(--border-subtle)',
        marginBottom: 28,
      }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            style={{
              padding: '8px 16px',
              background: 'none', border: 'none',
              borderBottom: `2px solid ${active === tab.id ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -1,
              color: active === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer', fontSize: 13,
              fontWeight: active === tab.id ? 600 : 400,
              transition: 'color 0.15s, border-color 0.15s',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={e => { if (active !== tab.id) e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { if (active !== tab.id) e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map(tab => active === tab.id && <div key={tab.id}>{tab.content}</div>)}
    </div>
  );
}

// ─── Merged Appearance Tab ────────────────────────────────────────────────────
function AppearanceTab() {
  const { t } = useTranslation();
  return (
    <SubTabs tabs={[
      { id: 'theme',  label: t('admin.tabs.theme'),          content: <ThemesTab /> },
      { id: 'layout', label: t('admin.appearance.layout'),   content: <LayoutsTab /> },
      { id: 'fonts',  label: t('admin.tabs.fontsAndLanguage'), content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
          <LanguageTab />
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 28 }}>
            <FontsTab />
          </div>
        </div>
      )},
    ]} />
  );
}

// ─── Merged Security & Privacy Tab ────────────────────────────────────────────
function SecurityPrivacyTab() {
  const { t } = useTranslation();
  return (
    <SubTabs tabs={[
      { id: 'security', label: t('admin.tabs.security'), content: <SecurityTab /> },
      { id: 'privacy',  label: t('admin.tabs.privacy'),  content: <PrivacyTab /> },
    ]} />
  );
}

// ─── About Tab ───────────────────────────────────────────────────────────────
function AboutTab() {
  const { t } = useTranslation();
  const [info, setInfo] = useState(null);

  useEffect(() => {
    fetch('/api/version')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setInfo)
      .catch(() => setInfo({ version: '—', sha: '—' }));
  }, []);

  const feSha = import.meta.env.VITE_BUILD_SHA || 'dev';
  const infoRows = [
    [t('admin.about.version'),       info ? info.version : '…'],
    [t('admin.about.backendBuild'),  info ? info.sha     : '…'],
    [t('admin.about.frontendBuild'), feSha],
    [t('admin.about.license'),       'AGPL-3.0'],
  ];
  const linkRows = [
    [t('admin.about.website'),    'https://mailflow.sh'],
    [t('admin.about.sourceCode'), 'https://github.com/maathimself/mailflow'],
    [t('admin.about.sponsor'),    'https://github.com/sponsors/maathimself'],
  ];

  const rowStyle = (last) => ({
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '11px 14px', background: 'var(--bg-secondary)',
    borderBottom: last ? 'none' : '1px solid var(--border-subtle)',
  });

  return (
    <div style={{ maxWidth: 420 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
        MailFlow
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>
        {t('admin.about.subtitle')}
      </div>
      <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border-subtle)', marginBottom: 12 }}>
        {infoRows.map(([label, value], i) => (
          <div key={label} style={rowStyle(i === infoRows.length - 1)}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
            <span style={{ fontSize: 12, color: 'var(--text-primary)', fontFamily: 'monospace', letterSpacing: '0.02em' }}>{value}</span>
          </div>
        ))}
      </div>
      <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
        {linkRows.map(([label, href], i) => (
          <div key={label} style={rowStyle(i === linkRows.length - 1)}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
            <a href={href} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}
            >{href.replace('https://', '')}</a>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Rules Tab ────────────────────────────────────────────────────────────────
function RulesTab() {
  const { t } = useTranslation();
  const { accounts, rulesPreFill, setRulesPreFill } = useStore();
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [formMode, setFormMode] = useState(null); // null | 'add' | 'edit'
  const [formId, setFormId] = useState(null);
  const [formData, setFormData] = useState(null);
  const [formError, setFormError] = useState('');
  const [formSaving, setFormSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => {
    api.getRules()
      .then(data => { setRules(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (rulesPreFill) {
      openAdd(rulesPreFill);
      setRulesPreFill(null);
    }
  }, [rulesPreFill, setRulesPreFill]);

  function blankForm(prefill = {}) {
    return {
      name: prefill.name || '',
      accountId: '',
      conditionLogic: 'AND',
      conditions: [{
        field: 'from',
        operator: 'contains',
        value: prefill.fromEmail || prefill.fromName || '',
      }],
      actions: [],
      enabled: true,
      stopProcessing: false,
    };
  }

  function openAdd(prefill) {
    setFormData(blankForm(prefill));
    setFormId(null);
    setFormMode('add');
    setFormError('');
  }

  function openEdit(rule) {
    setFormData({
      name: rule.name,
      accountId: rule.account_id || '',
      conditionLogic: rule.condition_logic || 'AND',
      conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
      actions: Array.isArray(rule.actions) ? rule.actions : [],
      enabled: rule.enabled,
      stopProcessing: rule.stop_processing,
    });
    setFormId(rule.id);
    setFormMode('edit');
    setFormError('');
  }

  function closeForm() {
    setFormMode(null);
    setFormId(null);
    setFormData(null);
    setFormError('');
  }

  async function handleToggle(rule) {
    const updated = { ...rule, enabled: !rule.enabled };
    try {
      const saved = await api.updateRule(rule.id, {
        name: rule.name,
        accountId: rule.account_id || null,
        conditionLogic: rule.condition_logic,
        conditions: rule.conditions,
        actions: rule.actions,
        enabled: updated.enabled,
        stopProcessing: rule.stop_processing,
      });
      setRules(prev => prev.map(r => r.id === rule.id ? saved : r));
    } catch (_) {}
  }

  async function handleDelete(id) {
    try {
      await api.deleteRule(id);
      setRules(prev => prev.filter(r => r.id !== id));
    } catch (_) {}
    setConfirmDelete(null);
  }

  async function handleSave() {
    const { name, conditionLogic, conditions, actions, accountId, enabled, stopProcessing } = formData;
    if (!name.trim() || conditions.length === 0 || actions.length === 0) {
      setFormError(t('admin.rules.errorRequired'));
      return;
    }
    const moveAction = actions.find(a => a.type === 'move');
    if (moveAction && !moveAction.value?.trim()) {
      setFormError(t('admin.rules.errorMoveFolder'));
      return;
    }
    setFormSaving(true);
    setFormError('');
    try {
      const payload = {
        name: name.trim(),
        accountId: accountId || null,
        conditionLogic,
        conditions,
        actions,
        enabled,
        stopProcessing,
      };
      if (formMode === 'add') {
        const created = await api.createRule(payload);
        setRules(prev => [...prev, created]);
      } else {
        const updated = await api.updateRule(formId, payload);
        setRules(prev => prev.map(r => r.id === formId ? updated : r));
      }
      closeForm();
    } catch (_) {
      setFormError(t('admin.rules.errorSave'));
    } finally {
      setFormSaving(false);
    }
  }

  function setCondition(idx, key, val) {
    setFormData(prev => {
      const conditions = prev.conditions.map((c, i) => i === idx ? { ...c, [key]: val } : c);
      return { ...prev, conditions };
    });
  }

  function addCondition() {
    setFormData(prev => ({
      ...prev,
      conditions: [...prev.conditions, { field: 'from', operator: 'contains', value: '' }],
    }));
  }

  function removeCondition(idx) {
    setFormData(prev => ({ ...prev, conditions: prev.conditions.filter((_, i) => i !== idx) }));
  }

  function toggleAction(type) {
    setFormData(prev => {
      const has = prev.actions.some(a => a.type === type);
      const actions = has
        ? prev.actions.filter(a => a.type !== type)
        : [...prev.actions, { type, value: '' }];
      return { ...prev, actions };
    });
  }

  function setActionValue(type, value) {
    setFormData(prev => ({
      ...prev,
      actions: prev.actions.map(a => a.type === type ? { ...a, value } : a),
    }));
  }

  function conditionSummary(rule) {
    const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
    if (!conds.length) return '—';
    return conds.slice(0, 2).map(c => {
      if (c.field === 'has_attachment') return t('admin.rules.fieldHasAttachment');
      return `${c.field} ${c.operator} "${c.value}"`;
    }).join(` ${rule.condition_logic} `) + (conds.length > 2 ? ` +${conds.length - 2}` : '');
  }

  function actionSummary(rule) {
    const acts = Array.isArray(rule.actions) ? rule.actions : [];
    if (!acts.length) return '—';
    const labels = { mark_read: t('admin.rules.actionMarkRead'), star: t('admin.rules.actionStar'), archive: t('admin.rules.actionArchive'), delete: t('admin.rules.actionDelete'), move: t('admin.rules.actionMove') };
    return acts.map(a => labels[a.type] || a.type).join(', ');
  }

  const FIELDS = [
    { value: 'from', label: t('admin.rules.fieldFrom') },
    { value: 'to', label: t('admin.rules.fieldTo') },
    { value: 'subject', label: t('admin.rules.fieldSubject') },
    { value: 'has_attachment', label: t('admin.rules.fieldHasAttachment') },
  ];
  const OPERATORS = [
    { value: 'contains',     label: t('admin.rules.opContains') },
    { value: 'not_contains', label: t('admin.rules.opNotContains') },
    { value: 'equals',       label: t('admin.rules.opEquals') },
    { value: 'starts_with',  label: t('admin.rules.opStartsWith') },
    { value: 'ends_with',    label: t('admin.rules.opEndsWith') },
  ];
  const ACTION_TYPES = [
    { type: 'mark_read', label: t('admin.rules.actionMarkRead') },
    { type: 'star',      label: t('admin.rules.actionStar') },
    { type: 'archive',   label: t('admin.rules.actionArchive') },
    { type: 'delete',    label: t('admin.rules.actionDelete') },
    { type: 'move',      label: t('admin.rules.actionMove') },
  ];

  if (formMode) {
    const fd = formData;
    return (
      <div style={{ maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <button onClick={closeForm} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '2px 6px', fontSize: 18, lineHeight: 1 }}>
            ←
          </button>
          <span style={{ fontWeight: 600, fontSize: 15 }}>
            {formMode === 'add' ? t('admin.rules.formTitleAdd') : t('admin.rules.formTitleEdit')}
          </span>
        </div>

        <Field label={t('admin.rules.nameLabel')} required>
          <input
            style={inputStyle}
            value={fd.name}
            onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
            placeholder={t('admin.rules.namePlaceholder')}
          />
        </Field>

        <Field label={t('admin.rules.accountLabel')}>
          <select
            style={inputStyle}
            value={fd.accountId}
            onChange={e => setFormData(p => ({ ...p, accountId: e.target.value }))}
          >
            <option value="">{t('admin.rules.accountAll')}</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.name || a.email_address}</option>
            ))}
          </select>
        </Field>

        <Field label={t('admin.rules.conditionLogicLabel')}>
          <div style={{ display: 'flex', gap: 16 }}>
            {['AND', 'OR'].map(val => (
              <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="radio"
                  checked={fd.conditionLogic === val}
                  onChange={() => setFormData(p => ({ ...p, conditionLogic: val }))}
                />
                {val === 'AND' ? t('admin.rules.conditionLogicAnd') : t('admin.rules.conditionLogicOr')}
              </label>
            ))}
          </div>
        </Field>

        <Field label={t('admin.rules.conditionsLabel')} required>
          {fd.conditions.map((cond, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <select
                style={{ ...inputStyle, width: 'auto', flex: '0 0 auto' }}
                value={cond.field}
                onChange={e => setCondition(idx, 'field', e.target.value)}
              >
                {FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
              {cond.field !== 'has_attachment' && (
                <>
                  <select
                    style={{ ...inputStyle, width: 'auto', flex: '0 0 auto' }}
                    value={cond.operator}
                    onChange={e => setCondition(idx, 'operator', e.target.value)}
                  >
                    {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <input
                    style={{ ...inputStyle, flex: 1 }}
                    value={cond.value}
                    onChange={e => setCondition(idx, 'value', e.target.value)}
                    placeholder="value"
                  />
                </>
              )}
              <button
                onClick={() => removeCondition(idx)}
                style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 16, padding: '0 4px', flexShrink: 0 }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            onClick={addCondition}
            style={{ marginTop: 4, fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            + {t('admin.rules.addCondition')}
          </button>
        </Field>

        <Field label={t('admin.rules.actionsLabel')} required>
          {ACTION_TYPES.map(({ type, label }) => {
            const checked = fd.actions.some(a => a.type === type);
            const moveVal = fd.actions.find(a => a.type === 'move')?.value || '';
            return (
              <div key={type} style={{ marginBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleAction(type)} />
                  {label}
                </label>
                {type === 'move' && checked && (
                  <input
                    style={{ ...inputStyle, marginTop: 6, marginLeft: 22 }}
                    value={moveVal}
                    onChange={e => setActionValue('move', e.target.value)}
                    placeholder={t('admin.rules.actionMovePlaceholder')}
                  />
                )}
              </div>
            );
          })}
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 20 }}>
          <input
            type="checkbox"
            checked={fd.stopProcessing}
            onChange={e => setFormData(p => ({ ...p, stopProcessing: e.target.checked }))}
          />
          {t('admin.rules.stopProcessing')}
        </label>

        {formError && (
          <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 12 }}>{formError}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={handleSave}
            disabled={formSaving}
            style={{ flex: 1, padding: '9px 0', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: formSaving ? 'not-allowed' : 'pointer', opacity: formSaving ? 0.7 : 1 }}
          >
            {formSaving ? t('admin.rules.saving') : t('admin.rules.saveButton')}
          </button>
          <button
            onClick={closeForm}
            style={{ padding: '9px 18px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer' }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{t('admin.rules.title')}</span>
        <button
          onClick={() => openAdd({})}
          style={{ padding: '7px 14px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
        >
          + {t('admin.rules.newButton')}
        </button>
      </div>

      {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('common.loading')}</div>}

      {!loading && rules.length === 0 && (
        <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{t('admin.rules.empty')}</div>
      )}

      {rules.map(rule => (
        <div key={rule.id} style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', marginBottom: 8 }}>
          {confirmDelete === rule.id ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1 }}>{t('admin.rules.deleteConfirm')}</span>
              <button
                onClick={() => handleDelete(rule.id)}
                style={{ padding: '5px 12px', background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
              >
                {t('admin.rules.deleteButton')}
              </button>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{ padding: '5px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)' }}
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 0, cursor: 'pointer', marginTop: 2, flexShrink: 0 }}>
                <input type="checkbox" checked={rule.enabled} onChange={() => handleToggle(rule)} />
              </label>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{rule.name || '(unnamed)'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {conditionSummary(rule)} → {actionSummary(rule)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button
                  onClick={() => openEdit(rule)}
                  style={{ padding: '4px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)' }}
                >
                  {t('admin.rules.editButton')}
                </button>
                <button
                  onClick={() => setConfirmDelete(rule.id)}
                  style={{ padding: '4px 10px', background: 'none', border: '1px solid var(--red)', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: 'var(--red)' }}
                >
                  {t('admin.rules.deleteButton')}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const TABS = [
  {
    id: 'accounts', labelKey: 'admin.tabs.accounts',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
  },
  {
    id: 'rules', labelKey: 'admin.tabs.rules',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
  },
  {
    id: 'appearance', labelKey: 'admin.tabs.appearance',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  },
  {
    id: 'integrations', labelKey: 'admin.tabs.integrations',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="3"/><path d="M6.343 6.343a8 8 0 000 11.314M17.657 6.343a8 8 0 010 11.314M3 12h1m16 0h1M12 3v1m0 16v1"/></svg>,
  },
  {
    id: 'users', labelKey: 'admin.tabs.users',
    adminOnly: true,
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
  },
  {
    id: 'sso', labelKey: 'admin.tabs.sso',
    adminOnly: true,
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
  },
  {
    id: 'security', labelKey: 'admin.tabs.security',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  },
  {
    id: 'notifications', labelKey: 'admin.tabs.notifications',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/></svg>,
  },
  {
    id: 'shortcuts', labelKey: 'admin.tabs.shortcuts',
    mobileHidden: true,
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><rect x="2" y="7" width="6" height="4" rx="1"/><rect x="9" y="7" width="6" height="4" rx="1"/><rect x="16" y="7" width="6" height="4" rx="1"/><rect x="2" y="13" width="9" height="4" rx="1"/><rect x="13" y="13" width="9" height="4" rx="1"/></svg>,
  },
  {
    id: 'about', labelKey: 'admin.tabs.about',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8"/><line x1="12" y1="12" x2="12" y2="16"/></svg>,
  },
];

// ─── Shortcuts Tab ───────────────────────────────────────────────────────────
function ShortcutsTab() {
  const { t } = useTranslation();
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

      const key = (e.ctrlKey || e.metaKey) ? `ctrl+${e.key.toLowerCase()}` : e.key;

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
          {t('admin.shortcuts.recording')}
        </span>
      );
    }
    if (!key) {
      return <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>;
    }
    // Modifier combos like 'ctrl+p'
    const mod = parseModKey(key);
    if (mod) {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <kbd style={kbdStyle}>{modLabel(mod.mod)}</kbd>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>+</span>
          <kbd style={kbdStyle}>{mod.bare.toUpperCase()}</kbd>
        </span>
      );
    }
    // Special key names like 'Delete', 'ArrowUp' — single keypress, render as one badge
    if (SPECIAL_KEY_LABELS[key]) {
      return <kbd style={kbdStyle}>{SPECIAL_KEY_LABELS[key]}</kbd>;
    }
    // Multi-char keys like 'gi': render each character as separate kbd with "then"
    if (key.length > 1) {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {[...key].map((c, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <kbd style={kbdStyle}>{c}</kbd>
              {i < key.length - 1 && <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{t('shortcuts.then')}</span>}
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
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.shortcuts.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
            {t('admin.shortcuts.description')}
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
          {t('admin.shortcuts.resetAll')}
        </button>
      </div>

      {pendingConflict && (
        <div style={{
          marginBottom: 16, padding: '10px 14px',
          background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.4)',
          borderRadius: 7, fontSize: 12, color: 'var(--text-secondary)',
        }}>
          {t('admin.shortcuts.conflict', { key: pendingConflict.key, action: ACTION_DEFS[pendingConflict.action]?.label })}
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
                      title={isRec ? t('common.cancel') : t('admin.shortcuts.description')}
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
                        title={t('admin.shortcuts.resetDefault')}
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
                        title={t('admin.shortcuts.remove')}
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
        {t('admin.shortcuts.footer')}
      </div>
    </div>
  );
}

// ─── Privacy Tab ─────────────────────────────────────────────────────────────
function PrivacyTab() {
  const { t } = useTranslation();
  const { blockRemoteImages, setBlockRemoteImages, imageWhitelist, setImageWhitelist, addToImageWhitelist, addNotification } = useStore();
  const [newAddress, setNewAddress] = useState('');
  const [newDomain,  setNewDomain]  = useState('');
  const [saving, setSaving] = useState(false);

  const addAddress = async () => {
    const val = newAddress.trim().toLowerCase();
    // Require at least one character before and after a single @
    const atIdx = val.indexOf('@');
    if (!val || atIdx < 1 || atIdx === val.length - 1) return;
    setSaving(true);
    try {
      await addToImageWhitelist({ type: 'address', value: val });
      setNewAddress('');
    } catch (_) {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSaving(false);
    }
  };

  const removeAddress = async (addr) => {
    setSaving(true);
    try {
      await setImageWhitelist({
        ...imageWhitelist,
        addresses: (imageWhitelist.addresses || []).filter(a => a !== addr),
      });
    } catch (_) {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSaving(false);
    }
  };

  const addDomain = async () => {
    const val = newDomain.trim().toLowerCase().replace(/^@/, '');
    if (!val || val.includes('@')) return;
    setSaving(true);
    try {
      await addToImageWhitelist({ type: 'domain', value: val });
      setNewDomain('');
    } catch (_) {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSaving(false);
    }
  };

  const removeDomain = async (domain) => {
    setSaving(true);
    try {
      await setImageWhitelist({
        ...imageWhitelist,
        domains: (imageWhitelist.domains || []).filter(d => d !== domain),
      });
    } catch (_) {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSaving(false);
    }
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
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{t('admin.privacy.title')}</div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 24 }}>
        {t('admin.privacy.description')}
      </div>

      {/* Toggle */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px', background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 10, marginBottom: 24,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{t('admin.privacy.blockImages')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
            {t('admin.privacy.blockImagesDesc')}
          </div>
        </div>
        <button
          onClick={async () => {
            try { await setBlockRemoteImages(!blockRemoteImages); }
            catch (_) { addNotification({ title: t('message.whitelistFail.title') }); }
          }}
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
            <div style={sectionHead}>{t('admin.privacy.allowedSenders')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>
              {t('admin.privacy.allowedSendersDesc')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(imageWhitelist.addresses || []).length === 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('admin.privacy.sendersEmpty')}</span>
              )}
              {(imageWhitelist.addresses || []).map(addr => (
                <span key={addr} style={pill}>
                  {addr}
                  <button onClick={() => removeAddress(addr)} disabled={saving} style={{
                    background: 'none', border: 'none', cursor: saving ? 'default' : 'pointer',
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
                onKeyDown={e => e.key === 'Enter' && !saving && addAddress()}
                placeholder={t('admin.privacy.addSenderPh')}
                style={{ ...inputStyle, flex: 1, maxWidth: 280 }}
              />
              <button onClick={addAddress} disabled={saving} style={{
                padding: '8px 14px', background: 'var(--accent)', border: 'none',
                borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500,
                cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
              }}>{t('common.add')}</button>
            </div>
          </div>

          {/* Allowed domains */}
          <div>
            <div style={sectionHead}>{t('admin.privacy.allowedDomains')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>
              {t('admin.privacy.allowedDomainsDesc')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(imageWhitelist.domains || []).length === 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('admin.privacy.domainsEmpty')}</span>
              )}
              {(imageWhitelist.domains || []).map(domain => (
                <span key={domain} style={pill}>
                  @{domain}
                  <button onClick={() => removeDomain(domain)} disabled={saving} style={{
                    background: 'none', border: 'none', cursor: saving ? 'default' : 'pointer',
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
                onKeyDown={e => e.key === 'Enter' && !saving && addDomain()}
                placeholder={t('admin.privacy.addDomainPh')}
                style={{ ...inputStyle, flex: 1, maxWidth: 280 }}
              />
              <button onClick={addDomain} disabled={saving} style={{
                padding: '8px 14px', background: 'var(--accent)', border: 'none',
                borderRadius: 7, color: 'white', fontSize: 13, fontWeight: 500,
                cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1,
              }}>{t('common.add')}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Security Tab (TOTP 2FA) ──────────────────────────────────────────────────
function SecurityTab() {
  const { t } = useTranslation();
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

  // Admin-only: login protection settings
  const [maxAttempts, setMaxAttempts] = useState(10);
  const [windowMins, setWindowMins] = useState(15);
  const [protectionSaving, setProtectionSaving] = useState(false);
  const [protectionSaved, setProtectionSaved] = useState(false);
  const [protectionError, setProtectionError] = useState('');

  // Admin-only: auth activity log
  const [authEvents, setAuthEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  useEffect(() => {
    if (!user?.isAdmin) return;
    api.admin.getSettings()
      .then(d => {
        if (d.settings.auth_max_attempts) setMaxAttempts(parseInt(d.settings.auth_max_attempts));
        if (d.settings.auth_window_minutes) setWindowMins(parseInt(d.settings.auth_window_minutes));
      })
      .catch(console.error);
    loadAuthEvents();
  }, [user?.isAdmin]);

  const loadAuthEvents = () => {
    setEventsLoading(true);
    api.admin.getAuthEvents({ limit: 100, offset: 0 })
      .then(d => setAuthEvents(d.events))
      .catch(console.error)
      .finally(() => setEventsLoading(false));
  };

  const saveProtection = async () => {
    const attempts = parseInt(maxAttempts);
    const mins = parseInt(windowMins);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
      setProtectionError(t('admin.security.maxAttempts') + ': 1–100');
      return;
    }
    if (!Number.isInteger(mins) || mins < 1 || mins > 1440) {
      setProtectionError(t('admin.security.windowMinutes') + ': 1–1440');
      return;
    }
    setProtectionSaving(true);
    setProtectionError('');
    try {
      await api.admin.updateSettings({ auth_max_attempts: attempts, auth_window_minutes: mins });
      setProtectionSaved(true);
      setTimeout(() => setProtectionSaved(false), 3000);
    } catch (err) {
      setProtectionError(err.message);
    } finally {
      setProtectionSaving(false);
    }
  };

  const eventLabel = (type) => {
    const map = {
      login_success: t('admin.security.eventLoginSuccess'),
      login_fail:    t('admin.security.eventLoginFail'),
      totp_success:  t('admin.security.eventTotpSuccess'),
      totp_fail:     t('admin.security.eventTotpFail'),
      sso_login:     t('admin.security.eventSsoLogin'),
    };
    return map[type] || type;
  };

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
      setSuccess(t('admin.security.totpSuccess'));
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
      setSuccess(t('admin.security.totpDisabledSuccess'));
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
      <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.security.title')}</h2>
      <p style={{ margin: '0 0 28px', fontSize: 13, color: 'var(--text-tertiary)' }}>
        {t('admin.security.description')}
      </p>

      {/* Login Protection — admin only */}
      {user?.isAdmin && (
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 12, padding: '20px 24px', marginBottom: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {t('admin.security.loginProtectionTitle')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
            {t('admin.security.loginProtectionDesc')}
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
                {t('admin.security.maxAttempts')}
              </label>
              <input
                type="number" min="1" max="100" value={maxAttempts}
                onChange={e => setMaxAttempts(e.target.value)}
                style={{ ...inputStyle, width: '100%' }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
                {t('admin.security.windowMinutes')}
              </label>
              <input
                type="number" min="1" max="1440" value={windowMins}
                onChange={e => setWindowMins(e.target.value)}
                style={{ ...inputStyle, width: '100%' }}
                onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                onBlur={e => e.target.style.borderColor = 'var(--border)'}
              />
            </div>
          </div>
          {protectionError && (
            <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{protectionError}</div>
          )}
          <button
            onClick={saveProtection}
            disabled={protectionSaving}
            style={{
              padding: '8px 18px', background: protectionSaved ? 'rgba(34,197,94,0.15)' : 'var(--accent)',
              border: protectionSaved ? '1px solid rgba(34,197,94,0.4)' : 'none',
              borderRadius: 7, color: protectionSaved ? '#22c55e' : 'white',
              fontSize: 13, fontWeight: 500,
              cursor: protectionSaving ? 'not-allowed' : 'pointer', opacity: protectionSaving ? 0.6 : 1,
            }}
          >
            {protectionSaving
              ? t('admin.security.savingProtection')
              : protectionSaved
                ? t('admin.security.protectionSaved')
                : t('admin.security.saveProtection')}
          </button>
        </div>
      )}

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
                {t('admin.security.totpTitle')}
              </div>
              <div style={{ fontSize: 12, color: totpEnabled ? '#22c55e' : 'var(--text-tertiary)', marginTop: 2 }}>
                {totpEnabled ? t('admin.security.totpEnabled') : t('admin.security.totpNotConfigured')}
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
              {loading ? t('admin.security.totpSetupLoading') : t('admin.security.totpSetup')}
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
              {t('admin.security.totpDisable')}
            </button>
          )}
        </div>

        {/* Setup: scan QR */}
        {step === 'scan' && setupData && (
          <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('admin.security.totpScanInstructions')}
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <img
                src={setupData.qrCode}
                alt={t('admin.security.qrCodeAlt')}
                style={{ width: 180, height: 180, borderRadius: 8, background: 'white', padding: 8 }}
              />
            </div>
            <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
              {t('admin.security.totpManualKey')}
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
              {t('admin.security.totpNext')}
            </button>
            <button
              onClick={cancelSetup}
              style={{
                width: '100%', padding: '8px', background: 'none', border: 'none',
                color: 'var(--text-tertiary)', fontSize: 13, cursor: 'pointer', marginTop: 8,
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}

        {/* Setup: verify code */}
        {step === 'verify' && (
          <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('admin.security.totpVerifyInstructions')}
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
                placeholder={t('admin.security.totpVerifyPh')}
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
                {loading ? t('admin.security.totpVerifyLoading') : t('admin.security.totpVerifyButton')}
              </button>
              <button
                type="button"
                onClick={() => setStep('scan')}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-tertiary)',
                  fontSize: 13, cursor: 'pointer', padding: 0,
                }}
              >
                {t('admin.security.totpBack')}
              </button>
            </form>
          </div>
        )}

        {/* Disable flow */}
        {showDisable && (
          <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 20 }}>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('admin.security.totpDisableInstructions')}
            </p>
            <form onSubmit={disableTotp} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <input
                type="password"
                value={disablePassword}
                onChange={e => setDisablePassword(e.target.value)}
                autoFocus
                placeholder={t('admin.security.totpDisablePh')}
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
                  {loading ? t('admin.security.totpDisableLoading') : t('admin.security.totpDisableConfirm')}
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
                  {t('common.cancel')}
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

      <LinkedIdentitiesSection />

      {/* Activity Log — admin only */}
      {user?.isAdmin && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('admin.security.activityTitle')}
            </div>
            <button
              onClick={loadAuthEvents}
              disabled={eventsLoading}
              style={{
                padding: '5px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12,
                cursor: eventsLoading ? 'not-allowed' : 'pointer', opacity: eventsLoading ? 0.6 : 1,
              }}
            >
              {t('admin.security.activityRefresh')}
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12 }}>
            {t('admin.security.activityDesc')}
          </div>
          {eventsLoading ? (
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 0' }}>
              {t('admin.security.activityLoading')}
            </div>
          ) : authEvents.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 0' }}>
              {t('admin.security.activityEmpty')}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {[
                      t('admin.security.activityColTime'),
                      t('admin.security.activityColEvent'),
                      t('admin.security.activityColUser'),
                      t('admin.security.activityColIP'),
                      t('admin.security.activityColStatus'),
                    ].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--text-tertiary)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {authEvents.map(ev => (
                    <tr key={ev.id} style={{ borderBottom: '1px solid var(--border-subtle, var(--border))' }}>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {new Date(ev.created_at).toLocaleString()}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                        {eventLabel(ev.event_type)}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ev.username || '—'}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                        {ev.ip || '—'}
                      </td>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                        <span style={{
                          display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 11, fontWeight: 500,
                          background: ev.success ? 'rgba(34,197,94,0.12)' : 'rgba(248,113,113,0.12)',
                          color: ev.success ? '#22c55e' : 'var(--red)',
                        }}>
                          {ev.success ? t('admin.security.activityAllowed') : t('admin.security.activityBlocked')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LinkedIdentitiesSection() {
  const { t } = useTranslation();
  const [identities, setIdentities] = useState(null); // null = loading
  const [providers, setProviders] = useState([]);
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    Promise.all([
      api.oidc.getIdentities(),
      api.oidc.getProviders(),
    ]).then(([idData, provData]) => {
      setIdentities(idData.identities);
      setProviders(provData.providers || []);
    }).catch(() => setIdentities([]));
  }, []);

  const handleUnlink = (identity) => {
    setConfirmDialog({
      title: t('admin.security.ssoUnlinkTitle', { provider: identity.provider_name }),
      message: t('admin.security.ssoUnlinkBody'),
      confirmLabel: t('admin.security.ssoUnlinkConfirm'),
      onConfirm: async () => {
        await api.oidc.unlinkIdentity(identity.id);
        setIdentities(ids => ids.filter(i => i.id !== identity.id));
      },
    });
  };

  // Providers not yet linked
  const linkedProviderIds = new Set((identities || []).map(i => i.provider_slug));
  const unlinkableProviders = providers.filter(p => !linkedProviderIds.has(p.slug));

  if (identities === null) return null;

  return (
    <>
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '20px 24px', marginTop: 16,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          {t('admin.security.ssoTitle')}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 16 }}>
          {t('admin.security.ssoDescription')}
        </div>

        {/* Linked identities */}
        {identities.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {identities.map(identity => (
              <div key={identity.id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', borderRadius: 8,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {identity.provider_name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {identity.email || identity.issuer}
                  </div>
                </div>
                <button
                  onClick={() => handleUnlink(identity)}
                  style={{
                    padding: '5px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                    background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)',
                    color: 'var(--red)', flexShrink: 0,
                  }}
                >
                  {t('admin.security.ssoUnlink')}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Link new provider */}
        {unlinkableProviders.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {unlinkableProviders.map(p => (
              <a
                key={p.id}
                href={`/auth/oidc/${p.slug}/start?action=link`}
                style={{
                  padding: '7px 14px', borderRadius: 7, fontSize: 13, fontWeight: 500,
                  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                  color: 'var(--text-secondary)', textDecoration: 'none', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
                </svg>
                {t('admin.security.ssoLink', { provider: p.name })}
              </a>
            ))}
          </div>
        )}

        {identities.length === 0 && unlinkableProviders.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
            {t('admin.security.ssoNoProviders')}
          </div>
        )}
      </div>

      <ConfirmOverlay dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />
    </>
  );
}

export default function AdminPanel() {
  const { t } = useTranslation();
  const { setShowAdmin, adminTab, setAdminTab, user } = useStore();
  const isMobile = useMobile();
  const visibleTabs = TABS.filter(tab => (!tab.adminOnly || user?.isAdmin) && (!tab.mobileHidden || !isMobile));

  if (isMobile) {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'var(--bg-secondary)',
        display: 'flex', flexDirection: 'column',
        animation: 'sheet-enter var(--motion-normal) var(--ease-emphasized) both',
      }}>
        {/* Mobile header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          paddingTop: 'calc(var(--sat) + 14px)',
          paddingBottom: 14, paddingLeft: 16, paddingRight: 16,
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{t('admin.title')}</span>
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
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {/* Content — full width, scrollable */}
        <div
          style={{ flex: 1, overflow: 'auto', padding: '20px 16px' }}
          onScroll={e => {
            const el = e.currentTarget;
            el.style.boxShadow = el.scrollTop > 4 ? 'inset 0 8px 8px -8px rgba(0,0,0,0.2)' : 'none';
          }}
        >
          {adminTab === 'accounts' && <AccountsTab />}
          {adminTab === 'rules' && <RulesTab />}
          {adminTab === 'appearance' && <AppearanceTab />}
          {adminTab === 'integrations' && <IntegrationsTab />}
          {adminTab === 'users' && <UsersTab />}
          {adminTab === 'sso' && <SSOTab />}
          {adminTab === 'security' && <SecurityPrivacyTab />}
          {adminTab === 'notifications' && <NotificationsTab />}
          {adminTab === 'shortcuts' && !isMobile && <ShortcutsTab />}
          {adminTab === 'about' && <AboutTab />}
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={e => e.target === e.currentTarget && setShowAdmin(false)}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000, padding: 24,
        animation: 'backdrop-enter var(--motion-fast) var(--ease-standard) both',
      }}
    >
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 16, width: '100%', maxWidth: 680,
        height: '82vh', maxHeight: 700, display: 'flex', overflow: 'hidden',
        boxShadow: 'var(--shadow-modal)',
        animation: 'modal-enter var(--motion-normal) var(--ease-emphasized) both',
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
            {t('admin.title')}
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
              {t(tab.labelKey)}
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
            {t('admin.close')}
          </button>
        </div>

        {/* Content */}
        <div
          style={{ flex: 1, overflow: 'auto', padding: '24px' }}
          onScroll={e => {
            const el = e.currentTarget;
            el.style.boxShadow = el.scrollTop > 4 ? 'inset 0 8px 8px -8px rgba(0,0,0,0.2)' : 'none';
          }}
        >
          {adminTab === 'accounts' && <AccountsTab />}
          {adminTab === 'rules' && <RulesTab />}
          {adminTab === 'appearance' && <AppearanceTab />}
          {adminTab === 'integrations' && <IntegrationsTab />}
          {adminTab === 'users' && <UsersTab />}
          {adminTab === 'sso' && <SSOTab />}
          {adminTab === 'security' && <SecurityPrivacyTab />}
          {adminTab === 'notifications' && <NotificationsTab />}
          {adminTab === 'shortcuts' && !isMobile && <ShortcutsTab />}
          {adminTab === 'about' && <AboutTab />}
        </div>
      </div>
    </div>
  );
}
