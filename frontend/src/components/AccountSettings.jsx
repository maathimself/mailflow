import { useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

const ACCOUNT_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#14b8a6',
];

const PRESETS = {
  gmail: {
    name: 'Gmail', imap_host: 'imap.gmail.com', imap_port: 993, imap_tls: true,
    smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  },
  icloud: {
    name: 'iCloud', imap_host: 'imap.mail.me.com', imap_port: 993, imap_tls: true,
    smtp_host: 'smtp.mail.me.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  },
  outlook: {
    name: 'Outlook', imap_host: 'outlook.office365.com', imap_port: 993, imap_tls: true,
    smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_tls: 'STARTTLS',
  },
  custom: { name: '' },
};

const defaultForm = {
  name: '', email_address: '', color: '#6366f1', protocol: 'imap',
  imap_host: '', imap_port: 993, imap_tls: true,
  smtp_host: '', smtp_port: 587, smtp_tls: 'STARTTLS',
  auth_user: '', auth_pass: '',
};

export default function AccountSettings() {
  const { setShowAccountSettings, accounts, setAccounts, updateAccount, selectedAccountId, setSelectedAccount } = useStore();
  const [view, setView] = useState('list'); // 'list' | 'add' | 'edit'
  const [editingAccount, setEditingAccount] = useState(null);
  const [editForm, setEditForm] = useState({ auth_pass: '', name: '' });
  const [preset, setPreset] = useState('gmail');
  const [form, setForm] = useState({ ...defaultForm, ...PRESETS.gmail });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const close = () => setShowAccountSettings(false);

  const handlePreset = (key) => {
    setPreset(key);
    setForm(prev => ({ ...prev, ...PRESETS[key] }));
  };

  const handleAdd = async () => {
    if (!form.email_address || !form.auth_user || !form.auth_pass || !form.imap_host) {
      setError('Please fill in all required fields');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const account = await api.addAccount(form);
      setAccounts([...accounts, account]);
      setView('list');
      setForm({ ...defaultForm, ...PRESETS.gmail });
      setPreset('gmail');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Remove this account? Synced messages will be deleted.')) return;
    try {
      await api.deleteAccount(id);
      setAccounts(accounts.filter(a => a.id !== id));
      // If the deleted account was selected, fall back to unified inbox
      if (selectedAccountId === id) setSelectedAccount(null);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleReconnect = async (id) => {
    await api.reconnectAccount(id);
    updateAccount(id, { sync_error: null });
  };

  const handleEditOpen = (account) => {
    setEditingAccount(account);
    setEditForm({ auth_pass: '', name: account.name });
    setError('');
    setView('edit');
  };

  const handleEditSave = async () => {
    if (!editForm.auth_pass) { setError('Please enter a new password'); return; }
    setSaving(true);
    setError('');
    try {
      const updates = { auth_pass: editForm.auth_pass };
      if (editForm.name) updates.name = editForm.name;
      await api.updateAccount(editingAccount.id, updates);
      updateAccount(editingAccount.id, { name: editForm.name || editingAccount.name });
      // Reconnect with new credentials
      await api.reconnectAccount(editingAccount.id);
      updateAccount(editingAccount.id, { sync_error: null });
      setView('list');
      setEditingAccount(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const field = (label, key, opts = {}) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
        {label} {opts.required && <span style={{ color: 'var(--red)' }}>*</span>}
      </label>
      {opts.type === 'select' ? (
        <select
          value={form[key]}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
          style={inputStyle}
        >
          {opts.options.map(o => (
            <option key={o.value} value={o.value} style={{ background: 'var(--bg-tertiary)' }}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={opts.type || 'text'}
          value={form[key]}
          onChange={e => setForm(f => ({
            ...f,
            [key]: opts.type === 'number' ? parseInt(e.target.value) : e.target.value
          }))}
          placeholder={opts.placeholder || ''}
          style={inputStyle}
          onFocus={e => e.target.style.borderColor = 'var(--accent)'}
          onBlur={e => e.target.style.borderColor = 'var(--border)'}
        />
      )}
    </div>
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 2000, padding: 24,
    }}
      onClick={e => e.target === e.currentTarget && close()}
    >
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 14, width: '100%', maxWidth: 520,
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {(view === 'add' || view === 'edit') && (
              <button onClick={() => { setView('list'); setError(''); }} style={backBtnStyle}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
              </button>
            )}
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {view === 'list' ? 'Email Accounts' : view === 'add' ? 'Add Account' : 'Edit Account'}
            </h3>
          </div>
          <button onClick={close} style={backBtnStyle}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>
          {view === 'list' && (
            <>
              {accounts.length === 0 && (
                <div style={{
                  textAlign: 'center', padding: '32px 0',
                  color: 'var(--text-tertiary)', fontSize: 14,
                }}>
                  No accounts added yet
                </div>
              )}

              {accounts.map(account => (
                <div key={account.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 14px', borderRadius: 9,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-tertiary)', marginBottom: 10,
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                    background: account.color, display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontSize: 14, fontWeight: 600, color: 'white',
                  }}>
                    {account.name[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {account.name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {account.email_address}
                    </div>
                    {account.sync_error && (
                      <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>
                        ⚠ {account.sync_error}
                      </div>
                    )}
                    {!account.sync_error && account.last_sync && (
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                        ✓ Connected
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <SmallBtn onClick={() => handleEditOpen(account)} title="Edit credentials">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </SmallBtn>
                    {account.sync_error && (
                      <SmallBtn onClick={() => handleReconnect(account.id)} title="Reconnect">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="23 4 23 10 17 10"/>
                          <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
                        </svg>
                      </SmallBtn>
                    )}
                    <SmallBtn onClick={() => handleDelete(account.id)} title="Remove" danger>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                      </svg>
                    </SmallBtn>
                  </div>
                </div>
              ))}

              <button
                onClick={() => setView('add')}
                style={{
                  width: '100%', padding: '10px', marginTop: 4,
                  background: 'transparent', border: '1px dashed var(--border)',
                  borderRadius: 9, color: 'var(--accent)', cursor: 'pointer',
                  fontSize: 13, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', gap: 6,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add Account
              </button>
            </>
          )}

          {view === 'edit' && editingAccount && (
            <div>
              <div style={{ marginBottom: 18, padding: '10px 14px', background: 'var(--bg-tertiary)', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{editingAccount.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{editingAccount.email_address}</div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
                  Display name
                </label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>
                  New password / App password <span style={{ color: 'var(--red)' }}>*</span>
                </label>
                <input
                  type="password"
                  value={editForm.auth_pass}
                  onChange={e => setEditForm(f => ({ ...f, auth_pass: e.target.value }))}
                  placeholder="Leave current password"
                  style={inputStyle}
                  autoFocus
                  onFocus={e => e.target.style.borderColor = 'var(--accent)'}
                  onBlur={e => e.target.style.borderColor = 'var(--border)'}
                />
              </div>

              {editingAccount.email_address?.endsWith('@gmail.com') && (
                <div style={{
                  padding: '10px 14px', background: 'rgba(124,106,247,0.08)',
                  border: '1px solid rgba(124,106,247,0.2)', borderRadius: 8,
                  color: 'var(--text-secondary)', fontSize: 12, marginBottom: 14,
                  lineHeight: 1.6,
                }}>
                  <strong style={{ color: 'var(--accent)' }}>Gmail requires an App Password.</strong>{' '}
                  Go to <strong>myaccount.google.com/apppasswords</strong> (2FA must be enabled),
                  generate one for "Mail", and paste the 16-character code above.
                </div>
              )}

              {error && (
                <div style={{
                  padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
                  border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8,
                  color: 'var(--red)', fontSize: 13, marginBottom: 14,
                }}>
                  {error}
                </div>
              )}

              <button
                onClick={handleEditSave}
                disabled={saving}
                style={{
                  width: '100%', padding: '11px', background: 'var(--accent)',
                  border: 'none', borderRadius: 8, color: 'white',
                  fontSize: 14, fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Save & Reconnect'}
              </button>
            </div>
          )}

          {view === 'add' && (
            <div>
              {/* Provider presets */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
                {Object.entries(PRESETS).map(([key, p]) => (
                  <button
                    key={key}
                    onClick={() => handlePreset(key)}
                    style={{
                      padding: '6px 14px', borderRadius: 20,
                      border: `1px solid ${preset === key ? 'var(--accent)' : 'var(--border)'}`,
                      background: preset === key ? 'var(--accent-dim)' : 'transparent',
                      color: preset === key ? 'var(--accent)' : 'var(--text-secondary)',
                      cursor: 'pointer', fontSize: 12, fontWeight: 500,
                      transition: 'all 0.15s',
                    }}
                  >
                    {p.name || 'Custom'}
                  </button>
                ))}
              </div>

              {/* Color */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Account color
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {ACCOUNT_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setForm(f => ({ ...f, color: c }))}
                      style={{
                        width: 24, height: 24, borderRadius: '50%', background: c,
                        border: `2px solid ${form.color === c ? 'white' : 'transparent'}`,
                        cursor: 'pointer', outline: 'none', padding: 0,
                        boxShadow: form.color === c ? `0 0 0 1px ${c}` : 'none',
                      }}
                    />
                  ))}
                </div>
              </div>

              {field('Display name', 'name', { required: true, placeholder: 'My Gmail' })}
              {field('Email address', 'email_address', { required: true, placeholder: 'you@gmail.com' })}
              {field('Username (IMAP login)', 'auth_user', { required: true, placeholder: 'Usually your email' })}
              {field('Password / App password', 'auth_pass', { required: true, type: 'password' })}

              <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }} />
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, fontWeight: 500 }}>
                IMAP Settings
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 10 }}>
                <div>
                  {field('IMAP Host', 'imap_host', { required: true, placeholder: 'imap.gmail.com' })}
                </div>
                <div>
                  {field('Port', 'imap_port', { type: 'number' })}
                </div>
              </div>

              <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0 16px' }} />
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, fontWeight: 500 }}>
                SMTP Settings
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 10 }}>
                <div>
                  {field('SMTP Host', 'smtp_host', { placeholder: 'smtp.gmail.com' })}
                </div>
                <div>
                  {field('Port', 'smtp_port', { type: 'number' })}
                </div>
              </div>

              {error && (
                <div style={{
                  padding: '10px 14px', background: 'rgba(248,113,113,0.1)',
                  border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8,
                  color: 'var(--red)', fontSize: 13, marginBottom: 14,
                }}>
                  {error}
                </div>
              )}

              {preset === 'gmail' && (
                <div style={{
                  padding: '10px 14px', background: 'rgba(124,106,247,0.08)',
                  border: '1px solid rgba(124,106,247,0.2)', borderRadius: 8,
                  color: 'var(--text-secondary)', fontSize: 12, marginBottom: 14,
                  lineHeight: 1.6,
                }}>
                  <strong style={{ color: 'var(--accent)' }}>Gmail:</strong> Use an App Password, not your regular password.
                  Go to myaccount.google.com/apppasswords to generate one.
                  2FA must be enabled on your Google account.
                </div>
              )}

              {preset === 'icloud' && (
                <div style={{
                  padding: '10px 14px', background: 'rgba(124,106,247,0.08)',
                  border: '1px solid rgba(124,106,247,0.2)', borderRadius: 8,
                  color: 'var(--text-secondary)', fontSize: 12, marginBottom: 14,
                  lineHeight: 1.6,
                }}>
                  <strong style={{ color: 'var(--accent)' }}>iCloud:</strong> Use an App-Specific Password from
                  appleid.apple.com → Sign-In and Security → App-Specific Passwords.
                </div>
              )}

              <button
                onClick={handleAdd}
                disabled={saving}
                style={{
                  width: '100%', padding: '11px', background: 'var(--accent)',
                  border: 'none', borderRadius: 8, color: 'white',
                  fontSize: 14, fontWeight: 500, cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? 'Connecting…' : 'Add Account'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '9px 12px',
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 7, color: 'var(--text-primary)', fontSize: 13,
  outline: 'none', transition: 'border-color 0.15s',
  boxSizing: 'border-box',
};

const backBtnStyle = {
  background: 'none', border: 'none', padding: 6, borderRadius: 6,
  color: 'var(--text-tertiary)', cursor: 'pointer',
  display: 'flex', alignItems: 'center',
};

function SmallBtn({ children, onClick, title, danger }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
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
