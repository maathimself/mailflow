import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

export default function JevRuleTester({ condition, accountId }) {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState(null);
  const [samples, setSamples] = useState([]);
  const [selected, setSelected] = useState([]);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const conditionKey = JSON.stringify([accountId, condition?.question, condition?.threshold]);
  const latestConditionKey = useRef(conditionKey);
  latestConditionKey.current = conditionKey;
  const latestAccountId = useRef(accountId);
  latestAccountId.current = accountId;

  useEffect(() => {
    let active = true;
    api.getJevStatus().then(status => { if (active) setConfigured(status.configured); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => { setSamples([]); setSelected([]); setResults([]); }, [accountId]);
  useEffect(() => { setResults([]); }, [condition?.question, condition?.threshold]);

  async function loadSamples() {
    const requestedAccountId = accountId;
    setBusy(true); setError(''); setResults([]); setSelected([]);
    try {
      const data = await api.getJevSamples(accountId);
      if (latestAccountId.current === requestedAccountId) setSamples(data.messages || []);
    } catch { if (latestAccountId.current === requestedAccountId) setError(t('admin.rules.jev.errorSamples')); }
    finally { setBusy(false); }
  }

  function toggle(id) {
    setSelected(current => current.includes(id) ? current.filter(x => x !== id) :
      current.length < 3 ? [...current, id] : current);
  }

  async function testCondition() {
    if (!selected.length || !condition?.question?.trim() || busy) return;
    const requestedConditionKey = conditionKey;
    setBusy(true); setError(''); setResults([]);
    try {
      const data = await api.testJevCondition(condition, selected);
      if (latestConditionKey.current === requestedConditionKey) setResults(data.results || []);
    } catch { if (latestConditionKey.current === requestedConditionKey) setError(t('admin.rules.jev.errorTest')); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 12, marginBottom: 14, border: '1px solid var(--border)', borderRadius: 8 }}>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('admin.rules.jev.testDisclosure')}</p>
      {configured === false && <p role="status">{t('admin.rules.jev.missingKey')}</p>}
      <button onClick={loadSamples} disabled={busy}>{t('admin.rules.jev.loadSamples')}</button>
      {samples.map(sample => (
        <label key={sample.id} style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
          <input type="checkbox" checked={selected.includes(sample.id)}
            disabled={!selected.includes(sample.id) && selected.length >= 3} onChange={() => toggle(sample.id)} />
          {sample.subject || t('common.noSubject')} — {sample.fromEmail}
        </label>
      ))}
      {samples.length > 0 && <button onClick={testCondition} disabled={busy || !selected.length || !condition?.question?.trim()}>
        {t('admin.rules.jev.test')}
      </button>}
      {results.map(result => <p key={result.id} style={{ fontSize: 12 }}>
        {result.subject || t('common.noSubject')}: {result.available
          ? `${result.probability.toFixed(2)} — ${result.match ? t('admin.rules.jev.match') : t('admin.rules.jev.noMatch')}`
          : result.reason === 'busy' ? t('admin.rules.jev.busyRetry') : t('admin.rules.jev.unavailable')}
      </p>)}
      {error && <p role="alert" style={{ color: 'var(--red)' }}>{error}</p>}
    </div>
  );
}
