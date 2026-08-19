import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { spamApi } from '../utils/spamApi.js';

// "Why was this marked as spam?" modal (v0.2) — shows the rule and ML
// contributions that produced the verdict for a message. Opened from the
// auto-spam badge in MessageList / MessagePane.

export default function SpamExplainModal({ messageId, onClose }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    spamApi.explain(messageId)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [messageId]);

  const overlayStyle = {
    position: 'fixed', inset: 0, zIndex: 9000,
    background: 'rgba(0,0,0,.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24,
  };
  const cardStyle = {
    background: 'var(--bg-primary, #1f1f28)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    maxWidth: 520, width: '100%',
    maxHeight: '80vh', overflowY: 'auto',
    padding: 20,
    display: 'flex', flexDirection: 'column', gap: 12,
    color: 'var(--text-primary)',
  };
  const sectionTitle = { fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-tertiary)', margin: '8px 0 4px' };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{t('spam.explainTitle')}</h3>
          <button type="button" onClick={onClose} aria-label={t('common.close')}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 18 }}>
            ✕
          </button>
        </div>

        {error && <div style={{ color: 'var(--danger, #dc2626)', fontSize: 13 }}>{error}</div>}

        {data && !error && (
          <>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
              <div>
                <span style={{ color: 'var(--text-tertiary)' }}>{t('spam.explainVerdict')}: </span>
                <strong style={{ color: data.verdict === 'spam' ? 'var(--danger, #dc2626)' : 'var(--text-primary)' }}>
                  {t(`spam.verdict.${data.verdict || 'ham'}`)}
                </strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-tertiary)' }}>{t('spam.explainMethod')}: </span>
                <strong>{t(`spam.method.${data.method || 'rules'}`)}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-tertiary)' }}>{t('spam.explainConfidence')}: </span>
                <strong>
                  {data.mlProbability != null
                    ? `${Math.round(data.mlProbability * 100)}%`
                    : `${Math.round((data.confidence ?? 0) * 100)}%`}
                </strong>
              </div>
            </div>

            <div>
              <div style={sectionTitle}>{t('spam.rulesFiredTitle')}</div>
              {data.rulesFired?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {data.rulesFired.map((r, i) => (
                    <div key={i} style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                      <span>✓ {r.name}</span>
                      <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                        {r.weight > 0 ? '+' : ''}{r.weight.toFixed(1)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('spam.noRulesFired')}</div>
              )}
            </div>

            <div>
              <div style={sectionTitle}>{t('spam.mlTokensTitle')}</div>
              {data.mlTopTokens?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {data.mlTopTokens.map((tok, i) => (
                    <div key={i} style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                      <span>&ldquo;{tok.token}&rdquo;</span>
                      <span style={{ color: tok.contribution > 0 ? 'var(--danger, #dc2626)' : 'var(--text-secondary)' }}>
                        {tok.contribution > 0 ? '+' : ''}{tok.contribution.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('spam.noMlTokens')}</div>
              )}
            </div>
          </>
        )}

        {!data && !error && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('common.loading')}</div>
        )}
      </div>
    </div>
  );
}