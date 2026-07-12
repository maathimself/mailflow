import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';

// Deterministic avatar color from a string
function avatarColor(str) {
  const colors = [
    '#6366f1','#8b5cf6','#ec4899','#f43f5e',
    '#f97316','#eab308','#22c55e','#14b8a6',
    '#06b6d4','#3b82f6',
  ];
  let h = 0;
  for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

function Avatar({ name, email, size = 36 }) {
  const label = (name || email || '?').charAt(0).toUpperCase();
  const color  = avatarColor(name || email || '');
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: color + '22', border: `1.5px solid ${color}55`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.44, fontWeight: 600, color,
      flexShrink: 0, userSelect: 'none',
    }}>
      {label}
    </div>
  );
}

function EmptyEmailForm() {
  return [{ value: '', type: 'other', primary: true }];
}

function emptyContact() {
  return {
    displayName: '',
    firstName: '',
    lastName: '',
    emails: EmptyEmailForm(),
    phones: [],
    organization: '',
    notes: '',
  };
}

const PAGE_SIZE = 100;

export default function ContactsPage() {
  const { t } = useTranslation();
  const { setShowContacts } = useStore();
  const isMobile = useMobile();

  const [contacts, setContacts]     = useState([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch]         = useState('');
  const [selected, setSelected]     = useState(null); // full contact object
  const [editing, setEditing]       = useState(false);
  const [form, setForm]             = useState(emptyContact());
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState(null);
  const [listError, setListError]   = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showNew, setShowNew]       = useState(false);
  // Mobile: 'list' shows the contact list, 'detail' shows contact/form panel
  const [mobilePanel, setMobilePanel] = useState('list');
  const searchTimer                 = useRef(null);

  // Stable refs used inside scroll handler to avoid stale closures.
  const contactsRef    = useRef([]);
  const totalRef       = useRef(0);
  const loadingMoreRef = useRef(false);
  const searchRef      = useRef('');

  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  useEffect(() => { totalRef.current = total; }, [total]);

  const load = useCallback(async (q = '') => {
    setLoading(true);
    setListError(null);
    searchRef.current = q;
    try {
      const res = await api.getContacts({ q, limit: PAGE_SIZE, offset: 0 });
      setContacts(res.contacts);
      setTotal(res.total);
    } catch (err) {
      setListError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(''); }, [load]);

  const onSearchChange = (e) => {
    const val = e.target.value;
    setSearch(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(val), 300);
  };

  const handleListScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 200) return;
    if (loadingMoreRef.current || contactsRef.current.length >= totalRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const q = searchRef.current;
    const offset = contactsRef.current.length;
    api.getContacts({ q, limit: PAGE_SIZE, offset })
      .then(res => {
        setContacts(prev => [...prev, ...res.contacts]);
        setTotal(res.total);
      })
      .catch(err => console.error('loadMore error:', err))
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, []);

  const selectContact = async (c) => {
    setError(null);
    try {
      const full = await api.getContact(c.id);
      setSelected(full);
      setEditing(false);
      setShowNew(false);
      setConfirmDelete(false);
      setError(null);
      if (isMobile) setMobilePanel('detail');
    } catch (err) {
      setError(err.message);
    }
  };

  const startNew = () => {
    setSelected(null);
    setForm(emptyContact());
    setEditing(false);
    setShowNew(true);
    setConfirmDelete(false);
    setError(null);
    if (isMobile) setMobilePanel('detail');
  };

  const goBackToList = () => {
    setMobilePanel('list');
    setSelected(null);
    setShowNew(false);
    setEditing(false);
    setError(null);
  };

  const startEdit = () => {
    if (!selected) return;
    setForm({
      displayName:  selected.display_name  || '',
      firstName:    selected.first_name    || '',
      lastName:     selected.last_name     || '',
      emails:       (selected.emails?.length ? selected.emails : EmptyEmailForm()),
      phones:       selected.phones        || [],
      organization: selected.organization  || '',
      notes:        selected.notes         || '',
    });
    setEditing(true);
    setError(null);
  };

  const cancelEdit = () => {
    if (showNew) {
      setShowNew(false);
      if (isMobile) setMobilePanel('list');
    } else {
      setEditing(false);
    }
    setError(null);
  };

  const saveContact = async () => {
    setSaving(true);
    setError(null);
    try {
      const derivedDisplayName =
        form.displayName.trim() ||
        [form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(' ') ||
        null;
      const payload = {
        displayName:  derivedDisplayName,
        firstName:    form.firstName    || null,
        lastName:     form.lastName     || null,
        emails:       form.emails.filter(e => e.value.trim()),
        phones:       form.phones.filter(p => p.value.trim()),
        organization: form.organization || null,
        notes:        form.notes        || null,
      };
      let saved;
      if (showNew) {
        saved = await api.createContact(payload);
      } else {
        saved = await api.updateContact(selected.id, payload);
      }
      // Reload list and re-fetch the saved contact before touching UI state,
      // so that any error here is still shown inside the open form.
      await load(search);
      const updated = await api.getContact(saved.id);
      setShowNew(false);
      setEditing(false);
      setSelected(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteContact = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.deleteContact(selected.id);
      setSelected(null);
      setConfirmDelete(false);
      if (isMobile) setMobilePanel('list');
      await load(search);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Form field helpers
  const setFormField = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const setEmail = (idx, field, val) => setForm(f => {
    const emails = f.emails.map((e, i) => i === idx ? { ...e, [field]: val } : e);
    return { ...f, emails };
  });

  const addEmail = () => setForm(f => ({
    ...f, emails: [...f.emails, { value: '', type: 'other', primary: false }],
  }));

  const removeEmail = (idx) => setForm(f => ({
    ...f, emails: f.emails.filter((_, i) => i !== idx),
  }));

  const setPhone = (idx, field, val) => setForm(f => {
    const phones = f.phones.map((p, i) => i === idx ? { ...p, [field]: val } : p);
    return { ...f, phones };
  });

  const addPhone = () => setForm(f => ({
    ...f, phones: [...f.phones, { value: '', type: 'mobile' }],
  }));

  const removePhone = (idx) => setForm(f => ({
    ...f, phones: f.phones.filter((_, i) => i !== idx),
  }));

  const inForm = editing || showNew;

  // Shared list panel content (used by both mobile and desktop)
  const listPanel = (
    <>
      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }} onScroll={handleListScroll}>
        {loading && !contacts.length && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
            {t('common.loading')}
          </div>
        )}
        {!loading && !contacts.length && (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: listError ? 'var(--red, #f87171)' : 'var(--text-tertiary)' }}>
            {listError || (search ? t('contacts.noResults') : t('contacts.empty'))}
          </div>
        )}
        {contacts.map(c => (
          <div
            key={c.id}
            onClick={() => selectContact(c)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 14px', cursor: 'pointer',
              background: selected?.id === c.id ? 'var(--bg-hover)' : 'transparent',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => { if (selected?.id !== c.id) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
            onMouseLeave={e => { if (selected?.id !== c.id) e.currentTarget.style.background = 'transparent'; }}
          >
            <Avatar name={c.display_name} email={c.primary_email} size={34} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {c.display_name || c.primary_email}
              </div>
              {c.display_name && c.primary_email && (
                <div style={{
                  fontSize: 11, color: 'var(--text-tertiary)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {c.primary_email}
                </div>
              )}
            </div>
            {c.is_auto && (
              <div style={{
                fontSize: 10, color: 'var(--text-tertiary)',
                background: 'var(--bg-tertiary)', borderRadius: 4,
                padding: '1px 5px', flexShrink: 0,
              }}>
                {t('contacts.auto')}
              </div>
            )}
          </div>
        ))}
        {loadingMore && (
          <div style={{ padding: '10px 14px', textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
            {t('common.loading')}
          </div>
        )}
      </div>

      {total > 0 && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border-subtle)', fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
          {contacts.length < total
            ? `${contacts.length} / ${t('contacts.count', { count: total })}`
            : t('contacts.count', { count: total })
          }
        </div>
      )}
    </>
  );

  // Shared detail / form content
  const detailPanel = (
    <>
      {!selected && !showNew && !isMobile && (
        <div style={{
          height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-tertiary)',
        }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ opacity: 0.3, marginBottom: 12 }}>
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87"/>
            <path d="M16 3.13a4 4 0 010 7.75"/>
          </svg>
          <div style={{ fontSize: 14 }}>{t('contacts.selectHint')}</div>
        </div>
      )}
      {inForm && (
        <ContactForm
          key={showNew ? 'new' : selected?.id}
          form={form}
          isNew={showNew}
          saving={saving}
          error={error}
          onField={setFormField}
          onSetEmail={setEmail}
          onAddEmail={addEmail}
          onRemoveEmail={removeEmail}
          onSetPhone={setPhone}
          onAddPhone={addPhone}
          onRemovePhone={removePhone}
          onSave={saveContact}
          onCancel={cancelEdit}
          t={t}
        />
      )}
      {selected && !inForm && (
        <ContactDetail
          key={selected.id}
          contact={selected}
          confirmDelete={confirmDelete}
          saving={saving}
          error={error}
          onEdit={startEdit}
          onDeleteRequest={() => setConfirmDelete(true)}
          onDeleteConfirm={deleteContact}
          onDeleteCancel={() => setConfirmDelete(false)}
          t={t}
        />
      )}
    </>
  );

  // ── Mobile layout ─────────────────────────────────────────────────────────
  if (isMobile) {
    const mobileHeaderTitle = mobilePanel === 'detail' && selected
      ? (selected.display_name || selected.primary_email || t('contacts.title'))
      : t('contacts.title');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg-secondary)' }}>
        {/* Mobile header — matches MessageList header style */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          paddingTop: 'calc(var(--sat) + 10px)',
          paddingBottom: 10, paddingLeft: 12, paddingRight: 12,
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-secondary)', flexShrink: 0,
        }}>
          <button
            onClick={mobilePanel === 'detail' ? goBackToList : () => setShowContacts(false)}
            style={{
              background: 'none', border: 'none', color: 'var(--text-secondary)',
              cursor: 'pointer', padding: 0, borderRadius: 7,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 44, minHeight: 44,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>

          <h2 style={{
            flex: 1, margin: 0, fontSize: 16, fontWeight: 600,
            color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {mobileHeaderTitle}
          </h2>

          {mobilePanel === 'list' && (
            <button
              onClick={startNew}
              style={{
                background: 'none', border: 'none', color: 'var(--accent)',
                cursor: 'pointer', padding: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                minWidth: 44, minHeight: 44,
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          )}
        </div>

        {/* Search bar — only on list view */}
        {mobilePanel === 'list' && (
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
            <input
              value={search}
              onChange={onSearchChange}
              placeholder={t('contacts.search')}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '8px 12px', borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg-input)', color: 'var(--text-primary)',
                fontSize: 14, outline: 'none',
              }}
            />
          </div>
        )}

        {/* Content */}
        {mobilePanel === 'list' ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'slide-in-left var(--motion-normal) var(--ease-emphasized) both' }}>
            {listPanel}
          </div>
        ) : (
          <div style={{ flex: 1, overflow: 'hidden auto', padding: '20px 16px', animation: 'slide-in-right var(--motion-normal) var(--ease-emphasized) both' }}>
            {detailPanel}
          </div>
        )}
      </div>
    );
  }

  // ── Desktop layout ────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--bg-primary)' }}>

      {/* Contact list panel */}
      <div style={{
        width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('contacts.title')}
            </span>
            <button
              onClick={startNew}
              style={{
                background: 'var(--accent)', border: 'none', borderRadius: 6,
                color: 'var(--accent-text)', fontSize: 12, fontWeight: 500,
                padding: '4px 10px', cursor: 'pointer',
              }}
            >
              + {t('contacts.new')}
            </button>
          </div>
          <input
            value={search}
            onChange={onSearchChange}
            placeholder={t('contacts.search')}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '7px 10px', borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'var(--bg-input)', color: 'var(--text-primary)',
              fontSize: 13, outline: 'none',
            }}
          />
        </div>

        {listPanel}
      </div>

      {/* Detail / form panel — keyed by contact id so scroll resets when switching contacts */}
      <div key={selected?.id ?? (showNew ? 'new' : 'empty')} style={{ flex: 1, overflow: 'hidden auto', padding: 32, minWidth: 0 }}>
        {detailPanel}
      </div>
    </div>
  );
}

function ContactDetail({ contact: c, confirmDelete, saving, error, onEdit, onDeleteRequest, onDeleteConfirm, onDeleteCancel, t }) {
  return (
    <div style={{ width: '100%', maxWidth: 560, position: 'relative', animation: 'pane-fade-in var(--motion-normal) var(--ease-emphasized) both' }}>
      {/* Edit/Delete for editable contacts — out of flow, top-right (fixed width). */}
      {!c.read_only && (
        <div style={{ position: 'absolute', top: 0, right: 0, display: 'flex', gap: 8 }}>
          <ActionBtn onClick={onEdit}>{t('common.edit')}</ActionBtn>
          <ActionBtn onClick={onDeleteRequest} danger>{t('common.delete')}</ActionBtn>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, marginBottom: 28, paddingRight: c.read_only ? 0 : 128 }}>
        <Avatar name={c.display_name} email={c.primary_email} size={60} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.display_name || c.primary_email}
          </h2>
          {c.organization && (
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 2 }}>{c.organization}</div>
          )}
          {/* CardDAV badge sits in flow below the name so it can never overlap it, whatever
              the badge's translated width. */}
          {c.read_only && (
            <span style={{ display: 'inline-block', marginTop: 6, fontSize: 11, padding: '4px 10px', borderRadius: 100, background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', border: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
              {t('contacts.carddavBadge')}
            </span>
          )}
          {c.is_auto && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{t('contacts.autoHint')}</div>
          )}
        </div>
      </div>

      {error && <ErrorBanner msg={error} />}

      {confirmDelete && (
        <div style={{
          padding: '14px 16px', borderRadius: 10,
          background: 'var(--red-dim, rgba(248,113,113,0.1))',
          border: '1px solid var(--red-border, rgba(248,113,113,0.3))',
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 10 }}>
            {t('contacts.deleteConfirm')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <ActionBtn onClick={onDeleteConfirm} danger disabled={saving}>
              {saving ? t('common.deleting') : t('common.delete')}
            </ActionBtn>
            <ActionBtn onClick={onDeleteCancel}>{t('common.cancel')}</ActionBtn>
          </div>
        </div>
      )}

      {((c.emails?.length > 0) || (c.phones?.length > 0) || c.notes) && (
        <DetailSection>
          {(c.emails || []).map((e, i) => (
            <DetailRow key={i} label={t(`contacts.emailTypes.${e.type || 'other'}`, { defaultValue: t('contacts.emailTypes.other') })}>
              <a href={`mailto:${e.value}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{e.value}</a>
            </DetailRow>
          ))}
          {(c.phones || []).map((p, i) => (
            <DetailRow key={i} label={t(`contacts.phoneTypes.${p.type === 'cell' || p.type === 'iphone' ? 'mobile' : (p.type || 'other')}`, { defaultValue: t('contacts.phoneTypes.other') })}>
              <a href={`tel:${p.value}`} style={{ color: 'var(--text-primary)', textDecoration: 'none' }}>{p.value}</a>
            </DetailRow>
          ))}
          {c.notes && <DetailRow label={t('contacts.fields.notes')}>{c.notes}</DetailRow>}
        </DetailSection>
      )}

      {(c.send_count > 0 || c.last_sent) && (
        <DetailSection>
          {c.send_count > 0 && (
            <DetailRow label={t('contacts.fields.emailsSent')}>{c.send_count}</DetailRow>
          )}
          {c.last_sent && (
            <DetailRow label={t('contacts.fields.lastContacted')}>
              {new Date(c.last_sent).toLocaleDateString()}
            </DetailRow>
          )}
        </DetailSection>
      )}
    </div>
  );
}

function ContactForm({
  form, isNew, saving, error,
  onField, onSetEmail, onAddEmail, onRemoveEmail,
  onSetPhone, onAddPhone, onRemovePhone,
  onSave, onCancel, t,
}) {
  const inputStyle = {
    width: '100%', boxSizing: 'border-box',
    padding: '8px 10px', borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--bg-input)', color: 'var(--text-primary)',
    fontSize: 13, outline: 'none',
  };
  const labelStyle = { fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4, display: 'block' };

  return (
    <div style={{ width: '100%', maxWidth: 560, animation: 'pane-fade-in var(--motion-normal) var(--ease-emphasized) both' }}>
      <h2 style={{ margin: '0 0 24px', fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
        {isNew ? t('contacts.newContact') : t('contacts.editContact')}
      </h2>

      {error && <ErrorBanner msg={error} />}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>{t('contacts.fields.firstName')}</label>
          <input style={inputStyle} value={form.firstName} onChange={e => onField('firstName', e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>{t('contacts.fields.lastName')}</label>
          <input style={inputStyle} value={form.lastName} onChange={e => onField('lastName', e.target.value)} />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('contacts.fields.displayName')}</label>
        <input style={inputStyle} value={form.displayName} onChange={e => onField('displayName', e.target.value)} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('contacts.fields.organization')}</label>
        <input style={inputStyle} value={form.organization} onChange={e => onField('organization', e.target.value)} />
      </div>

      {/* Emails */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('contacts.fields.email')}</label>
        {form.emails.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="email"
              value={e.value}
              placeholder="email@example.com"
              onChange={ev => onSetEmail(i, 'value', ev.target.value)}
            />
            <select
              value={e.type}
              onChange={ev => onSetEmail(i, 'type', ev.target.value)}
              style={{ ...inputStyle, width: 80, padding: '8px 6px' }}
            >
              <option value="other">{t('contacts.emailTypes.other')}</option>
              <option value="work">{t('contacts.emailTypes.work')}</option>
              <option value="home">{t('contacts.emailTypes.home')}</option>
            </select>
            {form.emails.length > 1 && (
              <button onClick={() => onRemoveEmail(i)} style={removeBtn}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            )}
          </div>
        ))}
        <button onClick={onAddEmail} style={addFieldBtn}>+ {t('contacts.addEmail')}</button>
      </div>

      {/* Phones */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('contacts.fields.phone')}</label>
        {form.phones.map((p, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="tel"
              value={p.value}
              placeholder="+1 555 000 0000"
              onChange={ev => onSetPhone(i, 'value', ev.target.value)}
            />
            <select
              value={p.type}
              onChange={ev => onSetPhone(i, 'type', ev.target.value)}
              style={{ ...inputStyle, width: 90, padding: '8px 6px' }}
            >
              <option value="mobile">{t('contacts.phoneTypes.mobile')}</option>
              <option value="work">{t('contacts.phoneTypes.work')}</option>
              <option value="home">{t('contacts.phoneTypes.home')}</option>
              <option value="other">{t('contacts.phoneTypes.other')}</option>
            </select>
            <button onClick={() => onRemovePhone(i)} style={removeBtn}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        ))}
        <button onClick={onAddPhone} style={addFieldBtn}>+ {t('contacts.addPhone')}</button>
      </div>

      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>{t('contacts.fields.notes')}</label>
        <textarea
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
          value={form.notes}
          onChange={e => onField('notes', e.target.value)}
        />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onSave}
          disabled={saving}
          style={{
            background: 'var(--accent)', border: 'none', borderRadius: 7,
            color: 'var(--accent-text)', fontSize: 13, fontWeight: 500,
            padding: '8px 20px', cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <ActionBtn onClick={onCancel} disabled={saving}>{t('common.cancel')}</ActionBtn>
      </div>
    </div>
  );
}

function DetailSection({ children }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)',
      borderRadius: 10, border: '1px solid var(--border-subtle)',
      overflow: 'hidden', marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function DetailRow({ label, children }) {
  return (
    <div style={{
      display: 'flex', gap: 16, padding: '10px 16px',
      borderBottom: '1px solid var(--border-subtle)',
      fontSize: 13,
    }}>
      <div style={{ width: 110, flexShrink: 0, color: 'var(--text-tertiary)', textTransform: 'capitalize' }}>{label}</div>
      <div style={{ flex: 1, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

function ActionBtn({ children, onClick, danger, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="btn-press"
      style={{
        background: danger ? 'transparent' : 'var(--bg-tertiary)',
        border: danger ? '1px solid var(--red-border, rgba(248,113,113,0.4))' : '1px solid var(--border)',
        borderRadius: 7,
        color: danger ? 'var(--red, #f87171)' : 'var(--text-primary)',
        fontSize: 12, fontWeight: 500,
        padding: '6px 12px', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background 0.1s',
      }}
    >
      {children}
    </button>
  );
}

function ErrorBanner({ msg }) {
  return (
    <div style={{
      marginBottom: 16, padding: '10px 14px', borderRadius: 8,
      background: 'var(--red-dim, rgba(248,113,113,0.1))',
      border: '1px solid var(--red-border, rgba(248,113,113,0.3))',
      fontSize: 13, color: 'var(--red, #f87171)',
    }}>
      {msg}
    </div>
  );
}

const removeBtn = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6, cursor: 'pointer',
  color: 'var(--text-tertiary)',
  padding: '0 8px', display: 'flex', alignItems: 'center',
  flexShrink: 0,
};

const addFieldBtn = {
  background: 'transparent',
  border: 'none',
  color: 'var(--accent)',
  fontSize: 12, cursor: 'pointer',
  padding: '2px 0',
};
