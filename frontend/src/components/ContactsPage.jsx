import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useStore } from '../store/index.js';
import { useMobile } from '../hooks/useMobile.js';
import {
  ADDITIONAL_FIELD_KINDS,
  additionalFieldInputType,
  beginPhotoRead,
  canUploadContactPhoto,
  completePhotoRead,
  contactCarddavState,
  contactPromotionState,
  contactToForm,
  formToContactDraft,
  initialPhotoReadState,
  invalidatePhotoRead,
  newAdditionalField,
  promoteFailureKey,
  removeContactPhoto,
  saveFailureState,
  shouldRefreshContactAfterResolution,
  validateContactPhoto,
} from '../contactCarddavState.js';
import { formatContactValue, humanizeContactLabel } from '../contactLabels.js';
import CardDavConflicts from './CardDavConflicts.jsx';

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

function emptyContact() {
  return contactToForm();
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
  const [conflictCount, setConflictCount] = useState(0);
  const [carddav, setCarddav] = useState({ connected: false, books: [] });
  const [promoting, setPromoting] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);
  const [activeConflictId, setActiveConflictId] = useState(null);
  const [photoRead, setPhotoRead] = useState(initialPhotoReadState);
  // Mobile: 'list' shows the contact list, 'detail' shows contact/form panel
  const [mobilePanel, setMobilePanel] = useState('list');
  const searchTimer                 = useRef(null);

  // Stable refs used inside scroll handler to avoid stale closures.
  const contactsRef    = useRef([]);
  const totalRef       = useRef(0);
  const loadingMoreRef = useRef(false);
  const searchRef      = useRef('');
  const photoReadRef   = useRef(photoRead);

  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  useEffect(() => { totalRef.current = total; }, [total]);

  const updatePhotoRead = useCallback(next => {
    photoReadRef.current = next;
    setPhotoRead(next);
  }, []);

  const invalidateCurrentPhotoRead = useCallback(() => {
    updatePhotoRead(invalidatePhotoRead(photoReadRef.current));
  }, [updatePhotoRead]);

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

  const loadConflictCount = useCallback(async () => {
    try {
      const result = await api.carddav.getConflicts();
      setConflictCount(result.conflicts.length);
    } catch {
      // Contact loading remains usable when CardDAV health is temporarily unavailable.
    }
  }, []);

  // The connection's per-book roles decide whether a harvested contact has a
  // write-target to be promoted into (see contactPromotionState).
  const loadCarddav = useCallback(async () => {
    try {
      setCarddav(await api.carddav.status());
    } catch {
      // Without a readable status the promote affordance simply stays hidden.
    }
  }, []);

  useEffect(() => {
    load('');
    loadConflictCount();
    loadCarddav();
  }, [load, loadConflictCount, loadCarddav]);

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
    invalidateCurrentPhotoRead();
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
    invalidateCurrentPhotoRead();
    setSelected(null);
    setForm(emptyContact());
    setEditing(false);
    setShowNew(true);
    setConfirmDelete(false);
    setError(null);
    if (isMobile) setMobilePanel('detail');
  };

  const goBackToList = () => {
    invalidateCurrentPhotoRead();
    setMobilePanel('list');
    setSelected(null);
    setShowNew(false);
    setEditing(false);
    setShowConflicts(false);
    setActiveConflictId(null);
    setError(null);
  };

  const startEdit = () => {
    if (!selected) return;
    if (!contactCarddavState(selected).canEdit) return;
    invalidateCurrentPhotoRead();
    setForm(contactToForm(selected));
    setEditing(true);
    setError(null);
  };

  const cancelEdit = () => {
    invalidateCurrentPhotoRead();
    if (showNew) {
      setShowNew(false);
      if (isMobile) setMobilePanel('list');
    } else {
      setEditing(false);
    }
    setError(null);
  };

  const submitContact = async (draft, isNew) => {
    setSaving(true);
    setError(null);
    try {
      const payload = formToContactDraft(draft);
      const saved = isNew
        ? await api.createContact(payload)
        : await api.updateContact(selected.id, payload);
      // Reload list and re-fetch the saved contact before touching UI state,
      // so that any error here is still shown inside the open form.
      await load(search);
      const updated = await api.getContact(saved.id);
      setShowNew(false);
      setEditing(false);
      setSelected(updated);
    } catch (err) {
      const failure = saveFailureState(err, draft);
      if (failure.view === 'conflict') {
        setActiveConflictId(failure.conflictId);
        setShowConflicts(true);
        setConflictCount(count => Math.max(1, count));
      } else if (failure.view === 'refresh') {
        // The write may have applied; MailFlow recovered read-only and reconciles on
        // the next sync. Refresh confirmed state (surfacing the existing pending/sync
        // marker) and keep the draft so the user can verify and retry if needed.
        await load(search);
        if (!isNew && selected) {
          try { setSelected(await api.getContact(selected.id)); } catch { /* keep prior */ }
        }
        setError(t(failure.messageKey));
      } else {
        setError(failure.error);
      }
    } finally {
      setSaving(false);
    }
  };

  const saveContact = () => {
    if (saving || photoReadRef.current.pending) return;
    submitContact(form, showNew);
  };

  const deleteContact = async () => {
    if (!selected) return;
    if (!contactCarddavState(selected).canDelete) return;
    setSaving(true);
    try {
      await api.deleteContact(selected.id);
      setSelected(null);
      setConfirmDelete(false);
      if (isMobile) setMobilePanel('list');
      await load(search);
    } catch (err) {
      const failure = saveFailureState(err, null);
      if (failure.view === 'conflict') {
        setActiveConflictId(failure.conflictId);
        setShowConflicts(true);
        setConflictCount(count => Math.max(1, count));
      } else if (failure.view === 'refresh') {
        // The delete may have applied on the server; refresh the list and show honest
        // copy rather than re-issuing a delete that could race the recovery.
        await load(search);
        setError(t('contacts.carddavWriteUnconfirmed'));
      } else {
        setError(failure.error);
      }
    } finally {
      setSaving(false);
    }
  };

  // The deliberate one-way promotion: the backend exports the contact to the
  // write-target book and only then clears is_auto, so re-reading it here shows
  // the confirmed result rather than an optimistic guess.
  const promoteContact = async () => {
    if (!selected || saving) return;
    if (!contactPromotionState(selected, carddav).enabled) return;
    setSaving(true);
    setPromoting(true);
    setError(null);
    try {
      const promoted = await api.promoteContact(selected.id);
      await load(search);
      setSelected(await api.getContact(promoted.id));
    } catch (err) {
      setError(t(promoteFailureKey(err)));
      // A rejection means the stored roles differ from what this page read, so
      // refresh them: the affordance re-renders to match the real state.
      await loadCarddav();
    } finally {
      setPromoting(false);
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

  const setAdditionalField = (id, patch) => setForm(f => ({
    ...f,
    additionalFields: f.additionalFields.map(field => (
      field.id === id ? { ...field, ...patch } : field
    )),
  }));

  const setAdditionalKind = (id, kind) => setForm(f => ({
    ...f,
    additionalFields: f.additionalFields.map(field => {
      if (field.id !== id) return field;
      const replacement = newAdditionalField(kind, () => id);
      return { ...replacement, label: field.label };
    }),
  }));

  const addAdditionalField = () => setForm(f => ({
    ...f,
    additionalFields: [...f.additionalFields, newAdditionalField('custom-text')],
  }));

  const removeAdditionalField = id => setForm(f => ({
    ...f,
    additionalFields: f.additionalFields.filter(field => field.id !== id),
  }));

  const readPhotoFile = (file, onPhotoData) => {
    const validationKey = validateContactPhoto(file);
    if (validationKey) {
      invalidateCurrentPhotoRead();
      setError(t(validationKey));
      return;
    }
    const reading = beginPhotoRead(photoReadRef.current);
    updatePhotoRead(reading);
    const generation = reading.generation;
    const reader = new FileReader();
    reader.onload = () => {
      const completed = completePhotoRead(photoReadRef.current, generation);
      if (!completed.accepted) return;
      updatePhotoRead(completed.state);
      setError(null);
      onPhotoData(reader.result);
    };
    reader.onerror = () => {
      const completed = completePhotoRead(photoReadRef.current, generation);
      if (!completed.accepted) return;
      updatePhotoRead(completed.state);
      setError(t('contacts.photo.readFailed'));
    };
    reader.readAsDataURL(file);
  };

  const setPhoto = file => readPhotoFile(file, photoData => {
    setForm(f => ({ ...f, photoData, hasPhoto: true }));
  });

  // The read view has no draft: the picked photo goes straight through the edit form's
  // save path, so a CardDAV contact keeps its pending/sync markers and remote push.
  const uploadDetailPhoto = file => {
    if (saving || !canUploadContactPhoto(selected)) return;
    readPhotoFile(file, photoData => submitContact(
      { ...contactToForm(selected), photoData, hasPhoto: true },
      false,
    ));
  };

  const removePhoto = () => {
    invalidateCurrentPhotoRead();
    setForm(removeContactPhoto);
  };

  const refreshAfterResolution = async resolvedConflict => {
    await load(search);
    if (shouldRefreshContactAfterResolution(selected, resolvedConflict)) {
      try {
        const updated = await api.getContact(selected.id);
        invalidateCurrentPhotoRead();
        setSelected(updated);
        setEditing(false);
      } catch (err) {
        if (err.status === 404) {
          setSelected(null);
          setEditing(false);
        } else {
          setError(t('contacts.conflicts.refreshFailed'));
        }
      }
    }
  };

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
                overflowWrap: 'anywhere', wordBreak: 'break-word',
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
      {showConflicts && (
        <CardDavConflicts
          initialConflictId={activeConflictId}
          onClose={() => { setShowConflicts(false); setActiveConflictId(null); }}
          onCountChange={setConflictCount}
          onResolved={refreshAfterResolution}
        />
      )}
      {!showConflicts && !selected && !showNew && !isMobile && (
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
      {!showConflicts && inForm && (
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
          onSetAdditional={setAdditionalField}
          onSetAdditionalKind={setAdditionalKind}
          onAddAdditional={addAdditionalField}
          onRemoveAdditional={removeAdditionalField}
          onSetPhoto={setPhoto}
          onRemovePhoto={removePhoto}
          photoReading={photoRead.pending}
          onSave={saveContact}
          onCancel={cancelEdit}
          t={t}
        />
      )}
      {!showConflicts && selected && !inForm && (
        <ContactDetail
          key={selected.id}
          contact={selected}
          promotion={contactPromotionState(selected, carddav)}
          confirmDelete={confirmDelete}
          saving={saving}
          photoReading={photoRead.pending}
          onSetPhoto={uploadDetailPhoto}
          promoting={promoting}
          error={error}
          onEdit={startEdit}
          onPromote={promoteContact}
          onDeleteRequest={() => setConfirmDelete(true)}
          onDeleteConfirm={deleteContact}
          onDeleteCancel={() => setConfirmDelete(false)}
          onOpenConflict={conflictId => {
            setActiveConflictId(conflictId);
            setShowConflicts(true);
          }}
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
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {conflictCount > 0 && (
                <button
                  onClick={() => { setActiveConflictId(null); setShowConflicts(true); setMobilePanel('detail'); }}
                  title={t('contacts.conflicts.openCount', { count: conflictCount })}
                  style={{
                    background: 'none', border: 'none', color: 'var(--red, #f87171)',
                    cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 600,
                    minWidth: 44, minHeight: 44,
                  }}
                >
                  {conflictCount}
                </button>
              )}
              <button
                onClick={startNew}
                title={t('contacts.newContact')}
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
            </div>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('contacts.title')}
            </span>
            <div style={{ display: 'flex', gap: 5 }}>
              {conflictCount > 0 && (
                <button
                  onClick={() => { setActiveConflictId(null); setShowConflicts(true); }}
                  title={t('contacts.conflicts.openCount', { count: conflictCount })}
                  style={{
                    background: 'var(--red-dim, rgba(248,113,113,0.1))',
                    border: '1px solid var(--red-border, rgba(248,113,113,0.3))',
                    borderRadius: 6, color: 'var(--red, #f87171)', fontSize: 11,
                    fontWeight: 600, padding: '4px 8px', cursor: 'pointer',
                  }}
                >
                  {conflictCount}
                </button>
              )}
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

function ContactDetail({ contact: c, promotion, confirmDelete, saving, photoReading, promoting, error, onEdit, onSetPhoto, onPromote, onDeleteRequest, onDeleteConfirm, onDeleteCancel, onOpenConflict, t }) {
  const carddav = contactCarddavState(c);
  const pendingSync = carddav.labelKey === 'contacts.carddavPending';
  const photoInputRef = useRef(null);
  const canUploadPhoto = canUploadContactPhoto(c);
  const photoBusy = saving || photoReading;
  const avatar = c.photo_data ? (
    <img
      src={c.photo_data}
      alt={t('contacts.photo.contactAlt')}
      style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
    />
  ) : <Avatar name={c.display_name} email={c.primary_email} size={60} />;

  return (
    <div style={{ width: '100%', maxWidth: 560, animation: 'pane-fade-in var(--motion-normal) var(--ease-emphasized) both' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 18, marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, flex: '1 1 260px', minWidth: 0 }}>
          {canUploadPhoto ? (
            <>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/jpeg,image/png"
                disabled={photoBusy}
                tabIndex={-1}
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) onSetPhoto(file);
                  event.target.value = '';
                }}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={photoBusy}
                title={t('contacts.photo.choose')}
                aria-label={t('contacts.photo.choose')}
                style={{
                  display: 'flex', padding: 0, borderRadius: '50%',
                  background: 'none', border: 'none', flexShrink: 0,
                  cursor: photoBusy ? 'not-allowed' : 'pointer',
                  opacity: photoBusy ? 0.6 : 1,
                }}
              >
                {avatar}
              </button>
            </>
          ) : avatar}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
              {c.display_name || c.primary_email}
            </h2>
            {c.organization && (
              <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 2 }}>{c.organization}</div>
            )}
            {c.is_auto && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{t('contacts.autoHint')}</div>
            )}
            {promotion.reasonKey && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{t(promotion.reasonKey)}</div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginLeft: 'auto' }}>
          {promotion.visible && (
            <ActionBtn
              onClick={onPromote}
              disabled={saving || !promotion.enabled}
              title={t('contacts.promote.hint')}
            >
              {promoting ? t('common.saving') : t('contacts.promote.action')}
            </ActionBtn>
          )}
          {carddav.labelKey && (
            <button
              onClick={carddav.conflictId ? () => onOpenConflict(carddav.conflictId) : undefined}
              disabled={!carddav.conflictId}
              style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 100,
                background: carddav.conflictId
                  ? 'var(--red-dim, rgba(248,113,113,0.1))'
                  : pendingSync ? 'var(--amber-dim, rgba(245,158,11,0.12))' : 'var(--bg-tertiary)',
                color: carddav.conflictId
                  ? 'var(--red, #f87171)'
                  : pendingSync ? 'var(--amber, #f59e0b)' : 'var(--text-tertiary)',
                border: '1px solid var(--border)', whiteSpace: 'nowrap',
                cursor: carddav.conflictId ? 'pointer' : 'default',
              }}
            >
              {t(carddav.labelKey)}
            </button>
          )}
          {carddav.canEdit && <ActionBtn onClick={onEdit} disabled={saving}>{t('common.edit')}</ActionBtn>}
          {carddav.canDelete && <ActionBtn onClick={onDeleteRequest} danger disabled={saving}>{t('common.delete')}</ActionBtn>}
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

      {((c.emails?.length > 0) || (c.phones?.length > 0) || c.notes || (c.additional_fields?.length > 0) || c.has_photo) && (
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
          {(c.additional_fields || []).map(field => (
            <DetailRow key={field.id} label={humanizeContactLabel(field.label, t) || t(`contacts.additional.types.${field.kind}`)}>
              {formatContactValue(field.value, t)}
            </DetailRow>
          ))}
          {c.has_photo && !c.photo_data && (
            <DetailRow label={t('contacts.photo.title')}>{t('contacts.photo.present')}</DetailRow>
          )}
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
  form, isNew, saving, photoReading, error,
  onField, onSetEmail, onAddEmail, onRemoveEmail,
  onSetPhone, onAddPhone, onRemovePhone,
  onSetAdditional, onSetAdditionalKind, onAddAdditional, onRemoveAdditional,
  onSetPhoto, onRemovePhoto,
  onSave, onCancel, t,
}) {
  const photoInputRef = useRef(null);
  const [rawLabelIds, setRawLabelIds] = useState(() => new Set());
  const savePending = saving || photoReading;
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

      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>{t('contacts.photo.title')}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {form.photoData ? (
            <img
              src={form.photoData}
              alt={t('contacts.photo.previewAlt')}
              style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 11 }}>
              {form.hasPhoto ? t('contacts.photo.present') : t('contacts.photo.none')}
            </div>
          )}
          <input
            ref={photoInputRef}
            type="file"
            accept="image/jpeg,image/png"
            disabled={saving}
            tabIndex={-1}
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) onSetPhoto(file);
              event.target.value = '';
            }}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => photoInputRef.current?.click()}
            disabled={saving}
            style={{ ...addFieldBtn, cursor: saving ? 'not-allowed' : 'pointer' }}
          >
            {t('contacts.photo.choose')}
          </button>
          {photoReading && (
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{t('common.loading')}</span>
          )}
          {form.hasPhoto && (
            <button type="button" onClick={onRemovePhoto} disabled={saving} style={addFieldBtn}>
              {t('contacts.photo.remove')}
            </button>
          )}
        </div>
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
              style={{ ...inputStyle, width: 80, cursor: 'pointer' }}
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
              style={{ ...inputStyle, width: 90, cursor: 'pointer' }}
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

      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>{t('contacts.additional.title')}</label>
        {form.additionalFields.map(field => (
          <div key={field.id} style={{ padding: 10, marginBottom: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr auto', gap: 6, marginBottom: 8 }}>
              <select
                value={field.kind}
                onChange={event => onSetAdditionalKind(field.id, event.target.value)}
                style={{ ...inputStyle, padding: '7px 6px' }}
              >
                {ADDITIONAL_FIELD_KINDS.map(kind => (
                  <option key={kind} value={kind}>{t(`contacts.additional.types.${kind}`)}</option>
                ))}
              </select>
              <input
                style={inputStyle}
                // Display-only humanizing: the raw label is what the retained vCard
                // round-trips, so focusing the control reveals the value actually stored.
                value={rawLabelIds.has(field.id) ? field.label : humanizeContactLabel(field.label, t)}
                placeholder={t('contacts.additional.label')}
                onFocus={() => setRawLabelIds(ids => new Set(ids).add(field.id))}
                onChange={event => onSetAdditional(field.id, { label: event.target.value })}
              />
              <button onClick={() => onRemoveAdditional(field.id)} style={removeBtn}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <AdditionalFieldInput
              field={field}
              inputStyle={inputStyle}
              onChange={value => onSetAdditional(field.id, { value })}
              t={t}
            />
          </div>
        ))}
        <button onClick={onAddAdditional} style={addFieldBtn}>+ {t('contacts.additional.add')}</button>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onSave}
          disabled={savePending}
          style={{
            background: 'var(--accent)', border: 'none', borderRadius: 7,
            color: 'var(--accent-text)', fontSize: 13, fontWeight: 500,
            padding: '8px 20px', cursor: savePending ? 'not-allowed' : 'pointer',
            opacity: savePending ? 0.7 : 1,
          }}
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <ActionBtn onClick={onCancel} disabled={saving}>{t('common.cancel')}</ActionBtn>
      </div>
    </div>
  );
}

function AdditionalFieldInput({ field, inputStyle, onChange, t }) {
  const value = field.value;
  if (field.kind === 'postal-address') {
    const address = value || {};
    const addressParts = [
      ['street', 'contacts.additional.street'],
      ['extendedAddress', 'contacts.additional.extendedAddress'],
      ['locality', 'contacts.additional.locality'],
      ['region', 'contacts.additional.region'],
      ['postalCode', 'contacts.additional.postalCode'],
      ['country', 'contacts.additional.country'],
      ['poBox', 'contacts.additional.poBox'],
    ];
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {addressParts.map(([key, labelKey]) => (
          <input
            key={key}
            style={inputStyle}
            value={address[key] || ''}
            placeholder={t(labelKey)}
            onChange={event => onChange({ ...address, [key]: event.target.value })}
          />
        ))}
      </div>
    );
  }
  if (field.kind === 'im') {
    const im = value || {};
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 6 }}>
        <input
          style={inputStyle}
          value={im.protocol || ''}
          placeholder={t('contacts.additional.protocol')}
          onChange={event => onChange({ ...im, protocol: event.target.value })}
        />
        <input
          style={inputStyle}
          value={im.handle || ''}
          placeholder={t('contacts.additional.handle')}
          onChange={event => onChange({ ...im, handle: event.target.value })}
        />
      </div>
    );
  }
  if (field.kind === 'geo') {
    const geo = value || {};
    const coordinate = raw => raw === '' ? '' : Number(raw);
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <input
          type="number"
          step="any"
          style={inputStyle}
          value={geo.latitude ?? ''}
          placeholder={t('contacts.additional.latitude')}
          onChange={event => onChange({ ...geo, latitude: coordinate(event.target.value) })}
        />
        <input
          type="number"
          step="any"
          style={inputStyle}
          value={geo.longitude ?? ''}
          placeholder={t('contacts.additional.longitude')}
          onChange={event => onChange({ ...geo, longitude: coordinate(event.target.value) })}
        />
      </div>
    );
  }

  return (
    <input
      type={additionalFieldInputType(field.kind)}
      style={inputStyle}
      value={value || ''}
      placeholder={t('contacts.additional.value')}
      onChange={event => onChange(event.target.value)}
    />
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

function ActionBtn({ children, onClick, danger, disabled, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
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
