import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

// Backup and restore (#452), mounted as the admin-only "Backup" tab in AdminPanel: download a
// backup of this installation, or replace the installation with one.

const HEALTH_POLL_MS = 2000;
const RESTART_WAIT_MS = 120_000;
const QUIET_RELOAD_MS = 15_000;

// A restore outlives the tab that started it, so its progress is kept here rather than in the
// component: going to another settings tab and back shows it still running.
let restoreState = { phase: 'idle', rows: 0, error: '' }; // phase: idle | restoring | restarting | lost | failed | restartTimeout
const restoreListeners = new Set();
function setRestoreState(patch) {
  restoreState = { ...restoreState, ...patch };
  restoreListeners.forEach(listener => listener(restoreState));
}

function Row({ label, help, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 0' }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
      {help ? <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{help}</div> : null}
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, disabled, label }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      aria-label={label}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? 'var(--accent)' : 'var(--bg-hover)',
        position: 'relative', padding: 0, transition: 'background 0.12s', opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: 8,
        background: '#fff', transition: 'left 0.12s',
      }} />
    </button>
  );
}

// The server exits once the restore is committed, so the page reloads after the API has gone
// away and come back; a reload into the old process would show the old data. A restart too quick
// for the polling to see is covered by reloading after the API has answered for a while.
async function waitForRestart({ reload, sleep, now }) {
  const healthy = () => fetch(`/api/health?_=${now()}`, { cache: 'no-store' }).then(r => r.ok, () => false);
  const started = now();
  let down = false;
  while (now() - started < RESTART_WAIT_MS) {
    const ok = await healthy();
    if (!ok) down = true;
    else if (down || now() - started > QUIET_RELOAD_MS) return reload();
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error('restart-timeout');
}

export default function BackupSettings({
  reload = () => window.location.reload(),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = Date.now,
}) {
  const { t } = useTranslation();
  const addNotification = useStore(s => s.addNotification);
  const [loaded, setLoaded] = useState(false);
  const [includeMail, setIncludeMail] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [file, setFile] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [{ phase, rows, error }, setShown] = useState(restoreState);

  useEffect(() => {
    // A finished failure was already reported; coming back to the tab starts clean.
    if (restoreState.phase === 'failed' || restoreState.phase === 'restartTimeout') setRestoreState({ phase: 'idle', error: '' });
    setShown(restoreState);
    restoreListeners.add(setShown);
    return () => { restoreListeners.delete(setShown); };
  }, []);

  useEffect(() => {
    api.admin.getSettings()
      .then(({ settings }) => setIncludeMail(settings.backup_include_mail === 'true'))
      .catch(err => addNotification({ type: 'error', title: err.message }))
      .finally(() => setLoaded(true));
  }, [addNotification]);

  // The switch is the default for every backup, so it is stored as soon as it is flipped.
  const toggleIncludeMail = async (value) => {
    setIncludeMail(value);
    try {
      await api.admin.updateSettings({ backup_include_mail: value });
    } catch (err) {
      setIncludeMail(!value);
      addNotification({ type: 'error', title: t('admin.backup.includeMailSaveError'), body: err.message });
    }
  };

  // A navigation rather than a fetch, so the browser streams a file of any size to disk. The
  // check first catches what would otherwise only show as a failed download.
  const download = async () => {
    const scope = includeMail ? 'full' : 'setup';
    setDownloading(true);
    try {
      await api.admin.checkBackup(scope);
      const a = document.createElement('a');
      a.href = api.admin.backupUrl(scope);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      addNotification({ type: 'error', title: t('admin.backup.downloadFailed'), body: err.message });
    } finally {
      setDownloading(false);
    }
  };

  const restore = async () => {
    setConfirming(false);
    setRestoreState({ phase: 'restoring', rows: 0, error: '' });
    try {
      await api.admin.restoreBackup(file, progress => setRestoreState({ rows: progress.rows }));
      setRestoreState({ phase: 'restarting' });
    } catch (err) {
      if (!err.lost) {
        const message = err.status === 413 ? t('admin.backup.tooLarge') : err.message;
        setRestoreState({ phase: 'failed', error: message });
        // Shown wherever the admin is by now, not only on this tab.
        addNotification({ type: 'error', title: t('admin.backup.failed', { message }) });
        return;
      }
      // The reply stopped before its result: the restore may still have committed and restarted.
      setRestoreState({ phase: 'lost' });
    }
    try {
      await waitForRestart({ reload, sleep, now });
    } catch {
      setRestoreState({ phase: 'restartTimeout' });
    }
  };

  const chooseFile = e => {
    setFile(e.target.files?.[0] || null);
    setConfirming(false);
    if (phase === 'failed') setRestoreState({ phase: 'idle', error: '' });
  };

  const busy = phase === 'restoring' || phase === 'restarting' || phase === 'lost';
  const status = {
    restoring: t('admin.backup.restoring', { rows }),
    restarting: t('admin.backup.done'),
    lost: t('admin.backup.connectionLost'),
    restartTimeout: t('admin.backup.restartTimeout'),
  }[phase];

  return (
    <div style={{ padding: '4px 2px', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h3 style={{ margin: '16px 0 4px', fontSize: 16 }}>{t('admin.backup.title')}</h3>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.backup.intro')}</p>
      <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>{t('admin.backup.sensitive')}</p>

      <Row label={t('admin.backup.includeMail')} help={t('admin.backup.includeMailDesc')}>
        <Toggle on={includeMail} onChange={toggleIncludeMail} disabled={!loaded || busy} label={t('admin.backup.includeMail')} />
      </Row>

      <button type="button" onClick={download} disabled={!loaded || busy || downloading}
        style={{ ...primaryBtn, alignSelf: 'flex-start', opacity: !loaded || busy || downloading ? 0.5 : 1 }}>
        {t('admin.backup.create')}
      </button>

      <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 16 }}>
        <Row label={t('admin.backup.restoreTitle')} help={`${t('admin.backup.restoreIntro')} ${t('admin.backup.versionNote')}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span>{t('admin.backup.chooseFile')}</span>
              <input type="file" accept=".gz,application/gzip" disabled={busy} onChange={chooseFile} />
            </label>
            {confirming ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--danger, #dc2626)' }}>
                  {t('admin.backup.confirmWarn', { name: file?.name })}
                </span>
                <button type="button" onClick={restore} style={dangerBtn}>{t('admin.backup.confirmYes')}</button>
                <button type="button" onClick={() => setConfirming(false)} style={secondaryBtn}>{t('common.cancel')}</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} disabled={!file || busy}
                style={{ ...dangerBtn, alignSelf: 'flex-start', opacity: !file || busy ? 0.5 : 1 }}>
                {t('admin.backup.restore')}
              </button>
            )}
            {status && <div role="status" style={{ fontSize: 13 }}>{status}</div>}
            {phase === 'failed' && (
              <div role="alert" style={{ fontSize: 13, color: 'var(--danger, #dc2626)' }}>
                {t('admin.backup.failed', { message: error })}
              </div>
            )}
          </div>
        </Row>
      </div>
    </div>
  );
}

const primaryBtn = {
  marginTop: 10, padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600,
};
const dangerBtn = {
  padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--danger, #dc2626)', color: '#fff', fontSize: 13, fontWeight: 600,
};
const secondaryBtn = {
  padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)',
  cursor: 'pointer', background: 'transparent', color: 'var(--text-primary)', fontSize: 13,
};
