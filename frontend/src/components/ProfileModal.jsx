import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

function resizeImage(file, maxPx = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(maxPx / img.width, maxPx / img.height, 1);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

export default function ProfileModal({ onClose }) {
  const { t } = useTranslation();
  const { user, updateUser } = useStore();
  const fileRef = useRef(null);

  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [avatarPreview, setAvatarPreview] = useState(user?.avatar || null);
  const [pendingAvatar, setPendingAvatar] = useState(null); // base64 to upload, or false = delete
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // MCP API tokens (per-user bearer tokens for the /mcp endpoint).
  const [tokens, setTokens] = useState([]);
  const [tokenName, setTokenName] = useState('');
  const [mintedToken, setMintedToken] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.tokens.list().then((r) => { if (alive) setTokens(r.tokens || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  async function handleCreateToken() {
    const name = tokenName.trim();
    if (!name || tokenBusy) return;
    setTokenBusy(true);
    setError('');
    try {
      const { token } = await api.tokens.create(name);
      setMintedToken(token); // shown once — never retrievable again
      setTokenName('');
      const r = await api.tokens.list();
      setTokens(r.tokens || []);
    } catch (e) {
      setError(e.message || t('profile.tokens.createFailed'));
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleRevokeToken(id) {
    try {
      await api.tokens.revoke(id);
      setTokens((prev) => prev.filter((tok) => tok.id !== id));
    } catch (e) {
      setError(e.message || t('profile.tokens.revokeFailed'));
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError(t('profile.errorNotImage'));
      return;
    }
    try {
      const dataUrl = await resizeImage(file);
      setAvatarPreview(dataUrl);
      setPendingAvatar(dataUrl);
      setError('');
    } catch {
      setError(t('profile.errorProcess'));
    }
  }

  function handleRemoveAvatar() {
    setAvatarPreview(null);
    setPendingAvatar(false);
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const trimmed = displayName.trim().slice(0, 100);
      if (trimmed !== (user?.displayName || '')) {
        await api.updateProfile({ displayName: trimmed });
        updateUser({ displayName: trimmed || null });
      }
      if (pendingAvatar === false) {
        await api.deleteAvatar();
        updateUser({ avatar: null });
      } else if (pendingAvatar) {
        await api.uploadAvatar(pendingAvatar);
        updateUser({ avatar: pendingAvatar });
      }
      onClose();
    } catch (err) {
      setError(err.message || t('common.error', { message: '' }));
    } finally {
      setSaving(false);
    }
  }

  const initials = ((user?.displayName || user?.username || '?')[0]).toUpperCase();

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 3000, padding: 24,
      }}
    >
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 14, width: '100%', maxWidth: 400,
        boxShadow: 'var(--shadow-modal)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 18px', borderBottom: '1px solid var(--border-subtle)',
        }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
            {t('profile.title')}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 4, display: 'flex' }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '22px 18px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Avatar */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{ position: 'relative' }}>
              {avatarPreview ? (
                <img
                  src={avatarPreview}
                  alt=""
                  style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
                />
              ) : (
                <div style={{
                  width: 80, height: 80, borderRadius: '50%',
                  background: 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 28, fontWeight: 700, color: 'var(--accent-text)',
                }}>
                  {initials}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => fileRef.current?.click()}
                style={{
                  fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer',
                }}
              >
                {t('profile.uploadPhoto')}
              </button>
              {avatarPreview && (
                <button
                  onClick={handleRemoveAvatar}
                  style={{
                    fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)',
                    background: 'transparent', color: 'var(--red, #f87171)', cursor: 'pointer',
                  }}
                >
                  {t('profile.removePhoto')}
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>

          {/* Display name */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>
              {t('profile.displayName')}
            </label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={user?.username || ''}
              maxLength={100}
              style={{
                padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)',
                background: 'var(--bg-primary)', color: 'var(--text-primary)',
                fontSize: 14, outline: 'none', width: '100%', boxSizing: 'border-box',
              }}
            />
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {t('profile.displayNameHint')}
            </span>
          </div>

          {/* API tokens (MCP) — bearer tokens for the Streamable-HTTP /mcp endpoint */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' }}>
              {t('profile.tokens.label')}
            </label>
            {tokens.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {tokens.map((tok) => (
                  <div key={tok.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12, color: 'var(--text-primary)' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tok.name}
                      <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>
                        {tok.last_used_at
                          ? t('profile.tokens.usedOn', { date: new Date(tok.last_used_at).toLocaleDateString() })
                          : t('profile.tokens.neverUsed')}
                      </span>
                    </span>
                    <button
                      onClick={() => handleRevokeToken(tok.id)}
                      style={{ fontSize: 11, padding: '3px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--red, #f87171)', cursor: 'pointer', flexShrink: 0 }}
                    >
                      {t('profile.tokens.revoke')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={tokenName}
                onChange={e => setTokenName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateToken()}
                placeholder={t('profile.tokens.namePlaceholder')}
                maxLength={80}
                style={{ flex: 1, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
              />
              <button
                onClick={handleCreateToken}
                disabled={tokenBusy || !tokenName.trim()}
                style={{ fontSize: 12, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: tokenBusy ? 'default' : 'pointer', flexShrink: 0, opacity: tokenBusy || !tokenName.trim() ? 0.6 : 1 }}
              >
                {t('profile.tokens.create')}
              </button>
            </div>
            {mintedToken && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', borderRadius: 8, background: 'rgba(52,211,153,0.08)', border: '1px solid var(--border)' }}>
                <code style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--text-primary)' }}>{mintedToken}</code>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {t('profile.tokens.copyOnce')}
                </span>
              </div>
            )}
          </div>

          {error && (
            <div style={{ fontSize: 13, color: 'var(--red, #f87171)', padding: '8px 10px', borderRadius: 6, background: 'rgba(248,113,113,0.08)' }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '12px 18px', borderTop: '1px solid var(--border-subtle)',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '7px 16px', borderRadius: 7, border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13,
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '7px 16px', borderRadius: 7, border: 'none',
              background: 'var(--accent)', color: 'var(--accent-text)', cursor: saving ? 'default' : 'pointer',
              fontSize: 13, fontWeight: 500, opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
