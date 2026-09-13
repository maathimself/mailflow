import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.js';
import { api } from '../../utils/api.js';
import GtdZeroPet from '../../components/GtdZeroPet.jsx';
import { DEFAULT_GTD_FOLDERS, GTD_STATES, resolveAccountGtdFolders, diffGtdFolders, findGtdFolderCollisions } from '../../utils/gtd.js';

// GTD's settings UI, extracted from AdminPanel's CategoriesSection into the plugin. Registered into
// the 'settings-categories' slot, which renders it only while GTD is activated — so the former
// `gtdPluginActive` gate is now the registry's activation gate. `GtdSettings` (the default export)
// owns GTD's disclosure state machine; the per-account/pet blocks below are moved verbatim.
const TOGGLE_OFF_BACKGROUND = 'var(--border)';

// Read a File as a base64 data-URL (data:<mime>;base64,…), the transport the pet import expects.
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

// User-level (not per-account) cosmetic: the inbox-zero pet. Import your own by uploading
// pet.json + a spritesheet directly; the chosen slug persists as a flat user preference.
// The preview reuses the live GtdZeroPet, so it shows the dog when cleared and the chosen
// pet (hover to animate) once set.
function GtdPetBlock() {
  const { t } = useTranslation();
  const gtdPetSlug = useStore(s => s.gtdPetSlug);
  const setGtdPetSlug = useStore(s => s.setGtdPetSlug);
  const [msg, setMsg] = useState(null);
  const [petJsonFile, setPetJsonFile] = useState(null);
  const [sheetFile, setSheetFile] = useState(null);
  const [importing, setImporting] = useState(false);
  // Bumped after a successful import to remount the file inputs empty (a file input's
  // value can't be set programmatically, so a changed key is the clean reset).
  const [fileResetKey, setFileResetKey] = useState(0);

  const handleImport = async () => {
    if (!petJsonFile || !sheetFile) return;
    setImporting(true); setMsg(null);
    try {
      const petJson = await petJsonFile.text();
      const sheet = await readFileAsDataURL(sheetFile);
      const pet = await api.importGtdPet({ petJson, sheet });
      setGtdPetSlug(pet.slug);
      setPetJsonFile(null); setSheetFile(null); setFileResetKey(k => k + 1);
      setMsg({ type: 'ok', text: t('admin.gtd.pet.imported', { name: pet.displayName || pet.slug }) });
    } catch (err) {
      setMsg({ type: 'error', text: err.message || t('admin.gtd.pet.importFailed') });
    } finally { setImporting(false); }
  };

  const handleClear = () => { setGtdPetSlug(null); setMsg(null); };

  const fileLabelStyle = { fontSize: 11, color: 'var(--text-tertiary)', display: 'block', marginBottom: 4 };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', background: 'var(--bg-secondary)', marginTop: 16 }}>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{t('admin.gtd.pet.title')}</div>
      <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4, marginBottom: 12 }}>{t('admin.gtd.pet.description')}</p>

      <div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>{t('admin.gtd.pet.importTitle')}</div>
        <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, marginBottom: 10 }}>{t('admin.gtd.pet.importHint')}</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={fileLabelStyle}>{t('admin.gtd.pet.chooseJson')}</label>
            <input
              key={`petjson-${fileResetKey}`}
              type="file"
              accept=".json,application/json"
              aria-label={t('admin.gtd.pet.chooseJson')}
              onChange={e => setPetJsonFile(e.target.files?.[0] || null)}
              style={{ fontSize: 12, color: 'var(--text-secondary)' }}
            />
          </div>
          <div>
            <label style={fileLabelStyle}>{t('admin.gtd.pet.chooseSheet')}</label>
            <input
              key={`sheet-${fileResetKey}`}
              type="file"
              accept="image/png,image/webp,image/gif"
              aria-label={t('admin.gtd.pet.chooseSheet')}
              onChange={e => setSheetFile(e.target.files?.[0] || null)}
              style={{ fontSize: 12, color: 'var(--text-secondary)' }}
            />
          </div>
        </div>

        <button onClick={handleImport} disabled={importing || !petJsonFile || !sheetFile} style={{
          marginTop: 12, padding: '7px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6,
          color: 'white', fontSize: 13, whiteSpace: 'nowrap',
          cursor: (importing || !petJsonFile || !sheetFile) ? 'default' : 'pointer',
          opacity: (importing || !petJsonFile || !sheetFile) ? 0.5 : 1,
        }}>
          {importing ? t('admin.gtd.pet.importing') : t('admin.gtd.pet.import')}
        </button>
      </div>

      {msg && (
        <div style={{ padding: '7px 11px', borderRadius: 6, marginTop: 10, fontSize: 12,
          background: msg.type === 'ok' ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
          color: msg.type === 'ok' ? 'var(--green)' : 'var(--red)',
          border: `1px solid ${msg.type === 'ok' ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'}`,
        }}>{msg.text}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 14 }}>
        <div style={{ width: 88, height: 88, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)', borderRadius: 8, flexShrink: 0 }}>
          <GtdZeroPet size={72} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {gtdPetSlug ? t('admin.gtd.pet.current', { slug: gtdPetSlug }) : t('admin.gtd.pet.usingDog')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t('admin.gtd.pet.hoverHint')}</div>
          {gtdPetSlug && (
            <button onClick={handleClear} style={{
              marginTop: 8, padding: '5px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
            }}>
              {t('admin.gtd.pet.clear')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Per-account GTD block: an enable toggle, and (only while enabled) the five
// state→folder inputs with "save" + "create missing folders" actions. A disabled
// account shows just the toggle so the tab stays quiet for non-GTD accounts.
function GtdAccountBlock({ account }) {
  const { t } = useTranslation();
  const { updateAccount } = useStore();
  const enabled = !!account.gtd_enabled;
  const [folders, setFolders] = useState(() => resolveAccountGtdFolders(account));
  const [toggling, setToggling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState(null);
  // Set right before handleCreate's own updateAccount so the re-seed effect below skips
  // that one self-inflicted gtd_folders change — which would otherwise stomp fields the
  // user is mid-editing. External gtd_folders changes still re-seed as normal.
  const skipReseedRef = useRef(false);

  // Re-seed the inputs when the stored mapping changes (e.g. after a save round-trip).
  // Intentionally keyed on gtd_folders only — reacting to the whole account object
  // would clobber in-progress edits on unrelated account updates.
  useEffect(() => {
    if (skipReseedRef.current) { skipReseedRef.current = false; return; }
    setFolders(resolveAccountGtdFolders(account));
  }, [account.gtd_folders]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = async () => {
    if (toggling) return;
    const next = !enabled;
    setToggling(true); setMsg(null);
    try {
      await api.updateAccount(account.id, { gtd_enabled: next });
      updateAccount(account.id, { gtd_enabled: next });
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    } finally { setToggling(false); }
  };

  // Comma-joined, translated state labels for the collision / rejection notices.
  const stateNames = (states) => [...new Set(states)].map(s => t(`gtd.state.${s}`)).join(', ');

  const handleSave = async () => {
    // Mirror the backend guard: block a save that would point two states at the same
    // folder (which would double-list every thread there across two rail/tab sections).
    const collisions = findGtdFolderCollisions(folders);
    if (collisions.length) {
      setMsg({ type: 'error', text: t('admin.gtd.duplicateFolder', { states: stateNames(collisions.flatMap(c => c.states)) }) });
      return;
    }
    setSaving(true); setMsg(null);
    try {
      const gtd_folders = diffGtdFolders(folders);
      const res = await api.updateAccount(account.id, { gtd_folders });
      updateAccount(account.id, { gtd_folders });
      // Some submitted names may have been rejected (over-long / traversal) and reset
      // to defaults — surface which so the user knows their input didn't stick.
      const rejected = res?.gtd_folders_rejected;
      if (rejected?.length) {
        setMsg({ type: 'error', text: t('admin.gtd.rejectedFolders', { states: stateNames(rejected) }) });
      } else {
        setMsg({ type: 'ok', text: t('admin.gtd.savedOk') });
      }
    } catch {
      setMsg({ type: 'error', text: t('admin.gtd.saveFailed') });
    } finally { setSaving(false); }
  };

  const handleCreate = async () => {
    setCreating(true); setMsg(null);
    try {
      const { results, folders: persisted } = await api.gtdEnsureFolders(account.id, diffGtdFolders(folders));
      const created = results.filter(r => r.created).length;
      const existing = results.filter(r => !r.created && !r.error).length;
      // On a prefixed-namespace server the folders land under a real path (INBOX.Todo) and
      // the backend persists those effective paths; reflect them so the inputs show where
      // labels actually live. Merge the returned states directly onto the current form so a
      // field the user is mid-editing (that ensure didn't return) survives, and suppress the
      // re-seed effect for this self-inflicted account update so it can't stomp those edits.
      if (persisted) {
        skipReseedRef.current = true;
        setFolders(prev => ({ ...prev, ...persisted }));
        updateAccount(account.id, { gtd_folders: persisted });
      }
      setMsg({ type: 'ok', text: t('admin.gtd.createResult', { created, existing }) });
    } catch (err) {
      // The 400 collision case carries a specific server message (e.g. which two states
      // clash); show it over the generic fallback. English-only — acceptable for this
      // admin-surface error detail, so no new i18n key.
      setMsg({ type: 'error', text: err.message || t('admin.gtd.createFailed') });
    } finally { setCreating(false); }
  };

  const inputStyle = { width: '100%', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          disabled={toggling}
          onClick={handleToggle}
          style={{
            width: 36, height: 20, borderRadius: 10, border: 'none', cursor: toggling ? 'default' : 'pointer', padding: 0,
            background: enabled ? 'var(--accent)' : TOGGLE_OFF_BACKGROUND,
            position: 'relative', transition: 'background 0.2s', flexShrink: 0,
          }}
        >
          <span style={{
            position: 'absolute', top: 2, left: enabled ? 18 : 2, width: 16, height: 16,
            borderRadius: '50%', background: 'white', transition: 'left 0.2s',
          }} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {account.name || account.email_address}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
            {enabled ? t('admin.gtd.enableDesc') : t('admin.gtd.enableHint')}
          </div>
        </div>
      </div>

      {enabled && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: 4 }}>
            {t('admin.gtd.foldersTitle')}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 0, marginBottom: 12 }}>
            {t('admin.gtd.foldersDesc')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            {GTD_STATES.map(state => (
              <div key={state} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ flex: '0 0 96px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {t(`gtd.state.${state}`)}
                </label>
                <input
                  value={folders[state] ?? ''}
                  onChange={e => setFolders(prev => ({ ...prev, [state]: e.target.value }))}
                  placeholder={DEFAULT_GTD_FOLDERS[state]}
                  style={{ ...inputStyle, flex: 1 }}
                />
              </div>
            ))}
          </div>

          {msg && (
            <div style={{ padding: '7px 11px', borderRadius: 6, marginBottom: 10, fontSize: 12,
              background: msg.type === 'ok' ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
              color: msg.type === 'ok' ? 'var(--green)' : 'var(--red)',
              border: `1px solid ${msg.type === 'ok' ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'}`,
            }}>{msg.text}</div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving} style={{
              padding: '7px 14px', background: 'var(--accent)', border: 'none', borderRadius: 6,
              color: 'white', fontSize: 13, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.5 : 1,
            }}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button onClick={handleCreate} disabled={creating} style={{
              padding: '7px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6,
              color: 'var(--text-secondary)', fontSize: 13, cursor: creating ? 'default' : 'pointer', opacity: creating ? 0.5 : 1,
            }}>
              {creating ? t('admin.gtd.creating') : t('admin.gtd.createFolders')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function GtdSection() {
  const { t } = useTranslation();
  const { accounts } = useStore();

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 20 }}>
        {t('admin.gtd.description')}
      </p>
      {accounts.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('admin.gtd.noAccounts')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {accounts.map(account => <GtdAccountBlock key={account.id} account={account} />)}
        </div>
      )}

      <GtdPetBlock />
    </div>
  );
}

// The GTD settings block within the Categories tab: a local disclosure toggle over GtdSection. The
// reveal never writes to the backend — the per-account toggles inside are the real gates. Default
// open if any account already has GTD on; a manual choice persists in localStorage so it sticks
// across reopens. A settings-search deep-link (initialSubTab === 'gtd') forces it open.
export default function GtdSettings({ initialSubTab }) {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const [gtdRevealed, setGtdRevealed] = useState(() => {
    const stored = localStorage.getItem('mailexpert_gtd_settings_reveal');
    if (stored === '1') return true;
    if (stored === '0') return false;
    return accounts.some(a => a.gtd_enabled);
  });
  // True once the reveal was set by an explicit choice this session (manual toggle or the
  // settings-search deep-link) — the accounts-arrived recompute below then stands down.
  const gtdRevealTouched = useRef(false);

  // Arriving from the settings-search "GTD" result reveals the block.
  useEffect(() => {
    if (initialSubTab === 'gtd') { gtdRevealTouched.current = true; setGtdRevealed(true); }
  }, [initialSubTab]);

  // If this mounted before accounts resolved, gtdRevealed defaulted to collapsed even for a GTD
  // user. Once accounts arrive, recompute the default — but only when the user has neither persisted
  // a manual choice nor revealed/collapsed the block this session.
  useEffect(() => {
    if (gtdRevealTouched.current) return;
    if (localStorage.getItem('mailexpert_gtd_settings_reveal') != null) return;
    if (accounts.length === 0) return;
    setGtdRevealed(accounts.some(a => a.gtd_enabled));
  }, [accounts]);

  const handleToggleGtd = () => {
    gtdRevealTouched.current = true;
    setGtdRevealed(prev => {
      const next = !prev;
      localStorage.setItem('mailexpert_gtd_settings_reveal', next ? '1' : '0');
      return next;
    });
  };

  return (
    <>
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '24px 0 20px' }} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: gtdRevealed ? 20 : 0 }}>
        <button
          type="button"
          onClick={handleToggleGtd}
          style={{
            width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0,
            background: gtdRevealed ? 'var(--accent)' : TOGGLE_OFF_BACKGROUND,
            position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginTop: 1,
          }}
        >
          <span style={{
            position: 'absolute', top: 2, left: gtdRevealed ? 18 : 2, width: 16, height: 16,
            borderRadius: '50%', background: 'white', transition: 'left 0.2s',
          }} />
        </button>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>{t('admin.categories.gtdReveal')}</span>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '1px 4px', borderRadius: 3, background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}>BETA</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{t('admin.categories.gtdRevealDesc')}</div>
        </div>
      </div>

      {gtdRevealed && <GtdSection />}
    </>
  );
}
