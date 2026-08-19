import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { spamApi } from '../utils/spamApi.js';

// Antispam settings panel (v0.2) — mounted as the "Antispam" tab in AdminPanel.
// Global-per-user scope: model status, thresholds, decay, master switch,
// retrain-now (admin), GDPR reset-all, and the deletion audit trail.
// Per-account toggle lives on the account edit page, not here (design §19).

const TOGGLE_OFF_BACKGROUND = 'var(--bg-hover)';

function Row({ label, help, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 0' }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
      {help ? <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{help}</div> : null}
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? 'var(--accent)' : TOGGLE_OFF_BACKGROUND,
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

function Slider({ value, min, max, step = 0.01, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, accentColor: 'var(--accent)' }}
      />
      <span style={{ fontSize: 13, minWidth: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {value.toFixed(2)}
      </span>
    </div>
  );
}

export default function SpamSettings() {
  const { t } = useTranslation();
  const addNotification = useStore(s => s.addNotification);
  const [status, setStatus] = useState(null);
  const [thresholds, setThresholds] = useState(null);
  const [decay, setDecay] = useState(90);
  const [deletions, setDeletions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [st, th, dc, del] = await Promise.all([
        spamApi.getStatus(), spamApi.getThresholds(), spamApi.getDecayThreshold(), spamApi.getDeletions(),
      ]);
      setStatus(st);
      setThresholds(th);
      setDecay(dc.decayThresholdDays);
      setDeletions(del);
    } catch (err) {
      addNotification({ type: 'error', title: err.message });
    }
  }, [addNotification]);

  useEffect(() => { refresh(); }, [refresh]);

  const notifyOk = (title) => addNotification({ type: 'ok', title });
  const notifyErr = (err) => addNotification({ type: 'error', title: err?.message || err });

  const saveThresholds = async () => {
    setSaving(true);
    try {
      const updated = await spamApi.updateThresholds({
        spamThreshold: thresholds.spamThreshold,
        autoMoveThreshold: thresholds.autoMoveThreshold,
      });
      setThresholds(updated);
      notifyOk(t('spam.saved'));
    } catch (err) {
      notifyErr(err);
    } finally {
      setSaving(false);
    }
  };

  const saveDecay = async () => {
    setSaving(true);
    try {
      await spamApi.updateDecayThreshold(decay);
      notifyOk(t('spam.saved'));
    } catch (err) {
      notifyErr(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleMaster = async (value) => {
    setBusy(true);
    try {
      await spamApi.enable(value);
      await refresh();
      notifyOk(t('spam.saved'));
    } catch (err) {
      notifyErr(err);
    } finally {
      setBusy(false);
    }
  };

  const doResetAll = async () => {
    setBusy(true);
    try {
      const res = await spamApi.resetTrainingAll();
      await refresh();
      setConfirmReset(false);
      notifyOk(t('spam.resetAllDone', { n: res.deletedTrainingRecords ?? 0 }));
    } catch (err) {
      notifyErr(err);
      setConfirmReset(false);
    } finally {
      setBusy(false);
    }
  };

  const doRetrain = async () => {
    setBusy(true);
    try {
      const res = await spamApi.retrainNow();
      await refresh();
      notifyOk(t('spam.retrainDone', { n: res.usersProcessed ?? 0 }));
    } catch (err) {
      notifyErr(err);
    } finally {
      setBusy(false);
    }
  };

  if (!status || !thresholds) {
    return <div style={{ padding: 24, color: 'var(--text-secondary)' }}>{t('common.loading')}</div>;
  }

  return (
    <div style={{ padding: '4px 2px', maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h3 style={{ margin: '16px 0 4px', fontSize: 16 }}>{t('spam.title')}</h3>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
        {t('spam.subtitle')}
      </p>

      {/* Model status */}
      <Row label={t('spam.statusTitle')} help={t('spam.statusHelp')}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <Stat label={t('spam.statMaturity')} value={t(`spam.maturity.${status.maturity}`)} />
          <Stat label={t('spam.statRecords')} value={String(status.trainingRecords)} />
          <Stat label={t('spam.statVersion')} value={String(status.modelVersion ?? '—')} />
          <Stat label={t('spam.statLastTrained')}
            value={status.lastTrainedAt ? new Date(status.lastTrainedAt).toLocaleString() : t('spam.never')} />
          <Stat label={t('spam.statDecay')} value={`${status.decayThresholdDays ?? 90} ${t('spam.days')}`} />
        </div>
      </Row>

      {/* Master switch + per-account hint */}
      <Row label={t('spam.masterEnable')} help={t('spam.masterEnableHelp')}>
        <Toggle on={status.masterEnabled} onChange={toggleMaster} disabled={busy} />
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginTop: 8 }}>
          {t('spam.perAccountHint')}
        </div>
      </Row>

      {/* Thresholds */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8 }}>
        <Row label={t('spam.thresholdsTitle')} help={t('spam.thresholdsHelp')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, marginBottom: 2 }}>{t('spam.spamThreshold')}</div>
              <Slider min={0.5} max={0.99} value={thresholds.spamThreshold}
                onChange={v => setThresholds({ ...thresholds, spamThreshold: v })} />
            </div>
            <div>
              <div style={{ fontSize: 13, marginBottom: 2 }}>{t('spam.autoMoveThreshold')}</div>
              <Slider min={0.7} max={0.99} value={thresholds.autoMoveThreshold}
                onChange={v => setThresholds({ ...thresholds, autoMoveThreshold: v })} />
            </div>
          </div>
          <button type="button" onClick={saveThresholds} disabled={saving}
            style={primaryBtn}>
            {t('spam.save')}
          </button>
        </Row>
      </div>

      {/* Decay */}
      <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <Row label={t('spam.decayTitle')} help={t('spam.decayHelp')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="number" min={7} max={365} step={1}
              value={decay}
              onChange={e => setDecay(Math.max(7, Math.min(365, parseInt(e.target.value, 10) || 90)))}
              style={{ width: 80, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-input, transparent)', color: 'var(--text-primary)' }}
            />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('spam.days')}</span>
            <button type="button" onClick={saveDecay} disabled={saving} style={primaryBtn}>
              {t('spam.save')}
            </button>
          </div>
        </Row>
      </div>

      {/* Danger zone */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8 }}>
        <Row label={t('spam.dangerTitle')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button type="button" onClick={doRetrain} disabled={busy}
              style={{ ...primaryBtn, alignSelf: 'flex-start' }}>
              {t('spam.retrainNow')}
            </button>
            {confirmReset ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--danger, #dc2626)' }}>{t('spam.resetConfirmWarn')}</span>
                <button type="button" onClick={doResetAll} disabled={busy}
                  style={{ ...dangerBtn }}>
                  {t('spam.resetConfirmYes')}
                </button>
                <button type="button" onClick={() => setConfirmReset(false)} style={secondaryBtn}>
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmReset(true)}
                style={{ ...dangerBtn, alignSelf: 'flex-start' }}>
                {t('spam.resetAll')}
              </button>
            )}
          </div>
        </Row>
      </div>

      {/* Audit trail */}
      {deletions.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8 }}>
          <Row label={t('spam.deletionsTitle')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 }}>
              {deletions.map((d, i) => (
                <div key={i} style={{ color: 'var(--text-secondary)' }}>
                  • {t(`spam.deleteScope.${d.scope}`)} — {d.records_deleted} {t('spam.records')} — {new Date(d.requested_at).toLocaleString()}
                </div>
              ))}
            </div>
          </Row>
        </div>
      )}

      {/* Explainability blurb */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8, padding: '12px 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        {t('spam.howItWorks')}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background: 'var(--bg-hover)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  );
}

const primaryBtn = {
  marginTop: 10, padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600,
};
const dangerBtn = {
  marginTop: 8, padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: 'var(--danger, #dc2626)', color: '#fff', fontSize: 13, fontWeight: 600,
};
const secondaryBtn = {
  marginTop: 8, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)',
  cursor: 'pointer', background: 'transparent', color: 'var(--text-primary)', fontSize: 13,
};