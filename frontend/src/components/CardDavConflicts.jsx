import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  beginConflictResolution,
  beginConflictLoad,
  CARDDAV_RESOLUTIONS,
  completeConflictLoad,
  completeConflictResolution,
  conflictComparison,
  CONFLICT_FIELD_LABELS,
  failConflictResolution,
  failConflictLoad,
  initialConflictQueueState,
} from '../carddavConflictState.js';
import { api } from '../utils/api.js';
import { formatContactValue } from '../contactLabels.js';

function ComparisonCell({ cell, t }) {
  if (cell.kind === 'tombstone') {
    return <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{t('contacts.conflicts.deleted')}</span>;
  }
  if (cell.kind === 'photo') {
    return <span>{t(cell.present ? 'contacts.conflicts.photoPresent' : 'contacts.conflicts.photoAbsent')}</span>;
  }
  const values = formatContactValue(cell.value, t);
  if (Array.isArray(values)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {values.map((value, index) => <span key={index}>{value}</span>)}
      </div>
    );
  }
  return <span>{values}</span>;
}

export default function CardDavConflicts({
  initialConflictId = null,
  onClose,
  onCountChange,
  onResolved,
}) {
  const { t } = useTranslation();
  const [queue, setQueue] = useState(() => initialConflictQueueState(null, initialConflictId));
  const queueRef = useRef(queue);
  const initialConflictIdRef = useRef(initialConflictId);

  const updateQueue = useCallback(next => {
    queueRef.current = next;
    setQueue(next);
  }, []);

  const load = useCallback(async () => {
    const loading = beginConflictLoad(queueRef.current);
    updateQueue(loading);
    const generation = loading.loadGeneration;
    try {
      const result = await api.carddav.getConflicts();
      updateQueue(completeConflictLoad(
        queueRef.current,
        generation,
        result.conflicts,
        initialConflictIdRef.current,
      ));
      initialConflictIdRef.current = null;
    } catch {
      updateQueue(failConflictLoad(queueRef.current, generation));
    }
  }, [updateQueue]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (queue.countKnown) onCountChange?.(queue.conflicts.length);
  }, [onCountChange, queue.conflicts.length, queue.countKnown]);

  const selected = queue.conflicts.find(conflict => conflict.id === queue.selectedId) || null;
  const rows = useMemo(() => selected ? conflictComparison(selected) : [], [selected]);

  // Edge fades cue the horizontally-scrollable comparison when a column is off-screen
  // at narrow widths, and hide once the user reaches that end.
  const comparisonScrollRef = useRef(null);
  const [scrollEdges, setScrollEdges] = useState({ start: false, end: false });
  const syncScrollEdges = useCallback(() => {
    const element = comparisonScrollRef.current;
    if (!element) return;
    const maxScroll = element.scrollWidth - element.clientWidth;
    setScrollEdges({
      start: element.scrollLeft > 1,
      end: maxScroll > 1 && element.scrollLeft < maxScroll - 1,
    });
  }, []);
  useEffect(() => {
    syncScrollEdges();
    window.addEventListener('resize', syncScrollEdges);
    return () => window.removeEventListener('resize', syncScrollEdges);
  }, [syncScrollEdges, rows]);

  const resolve = async resolution => {
    const current = queueRef.current;
    const target = current.conflicts.find(conflict => conflict.id === current.selectedId) || null;
    if (!target || current.pendingResolution) return;
    updateQueue(beginConflictResolution(current, resolution));
    try {
      await api.carddav.resolveConflict(target.id, resolution);
      await onResolved?.(target);
      updateQueue(completeConflictResolution(queueRef.current));
      await load();
    } catch {
      updateQueue(failConflictResolution(queueRef.current));
    }
  };

  return (
    <div style={{ width: '100%', maxWidth: 760, color: 'var(--text-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{t('contacts.conflicts.title')}</h2>
          <div style={{ marginTop: 3, color: 'var(--text-tertiary)', fontSize: 12 }}>
            {t('contacts.conflicts.count', { count: queue.conflicts.length })}
          </div>
        </div>
        {onClose && (
          <button onClick={onClose} style={secondaryButtonStyle}>{t('contacts.conflicts.close')}</button>
        )}
      </div>

      {queue.loading && <div style={noticeStyle}>{t('common.loading')}</div>}
      {!queue.loading && queue.loadError && <div style={errorStyle}>{t('contacts.conflicts.loadFailed')}</div>}
      {!queue.loading && !queue.loadError && queue.conflicts.length === 0 && (
        <div style={noticeStyle}>{t('contacts.conflicts.empty')}</div>
      )}

      {!queue.loading && selected && (
        <>
          {queue.conflicts.length > 1 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {queue.conflicts.map((conflict, index) => (
                <button
                  key={conflict.id}
                  onClick={() => updateQueue({
                    ...queueRef.current,
                    selectedId: conflict.id,
                    errorKey: null,
                  })}
                  disabled={Boolean(queue.pendingResolution)}
                  style={{
                    ...secondaryButtonStyle,
                    borderColor: conflict.id === selected.id ? 'var(--accent)' : 'var(--border)',
                    color: conflict.id === selected.id ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  {t('contacts.conflicts.item', { number: index + 1 })}
                </button>
              ))}
            </div>
          )}

          <div style={{ position: 'relative' }}>
            <div
              ref={comparisonScrollRef}
              onScroll={syncScrollEdges}
              style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}
            >
              <div style={{ minWidth: 600 }}>
                <div style={comparisonHeaderStyle}>
                  <div />
                  <strong>{t('contacts.conflicts.mailflowSide')}</strong>
                  <strong>{t('contacts.conflicts.carddavSide')}</strong>
                </div>
                {rows.map(row => (
                  <div key={row.key} style={comparisonRowStyle}>
                    <strong style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                      {t(CONFLICT_FIELD_LABELS[row.key])}
                    </strong>
                    <div style={comparisonCellStyle}><ComparisonCell cell={row.local} t={t} /></div>
                    <div style={comparisonCellStyle}><ComparisonCell cell={row.remote} t={t} /></div>
                  </div>
                ))}
              </div>
            </div>
            {scrollEdges.start && <div aria-hidden style={comparisonFadeStyle('left')} />}
            {scrollEdges.end && <div aria-hidden style={comparisonFadeStyle('right')} />}
          </div>

          {queue.errorKey && <div style={{ ...errorStyle, marginTop: 12 }}>{t(queue.errorKey)}</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
            {CARDDAV_RESOLUTIONS.map(resolution => (
              <button
                key={resolution}
                onClick={() => resolve(resolution)}
                disabled={Boolean(queue.pendingResolution)}
                style={resolution === 'keep-mailflow' ? primaryButtonStyle : secondaryButtonStyle}
              >
                {queue.pendingResolution === resolution
                  ? t('contacts.conflicts.resolving')
                  : t(resolution === 'keep-mailflow'
                    ? 'contacts.conflicts.keepMailflow'
                    : 'contacts.conflicts.keepCarddav')}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const primaryButtonStyle = {
  padding: '8px 14px',
  border: 'none',
  borderRadius: 7,
  background: 'var(--accent)',
  color: 'white',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
};

const secondaryButtonStyle = {
  padding: '7px 12px',
  border: '1px solid var(--border)',
  borderRadius: 7,
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: 13,
};

const noticeStyle = {
  padding: 18,
  borderRadius: 9,
  background: 'var(--bg-secondary)',
  color: 'var(--text-tertiary)',
  fontSize: 13,
};

const errorStyle = {
  padding: '10px 12px',
  borderRadius: 8,
  background: 'var(--red-dim, rgba(248,113,113,0.1))',
  border: '1px solid var(--red-border, rgba(248,113,113,0.3))',
  color: 'var(--red, #f87171)',
  fontSize: 13,
};

const comparisonHeaderStyle = {
  display: 'grid',
  gridTemplateColumns: '140px minmax(220px, 1fr) minmax(220px, 1fr)',
  gap: 12,
  padding: '10px 12px',
  background: 'var(--bg-tertiary)',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
};

const comparisonRowStyle = {
  display: 'grid',
  gridTemplateColumns: '140px minmax(220px, 1fr) minmax(220px, 1fr)',
  gap: 12,
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-subtle)',
};

const comparisonCellStyle = {
  minWidth: 0,
  overflowWrap: 'anywhere',
  color: 'var(--text-primary)',
  fontSize: 13,
};

function comparisonFadeStyle(side) {
  return {
    position: 'absolute',
    top: 1,
    bottom: 1,
    [side]: 1,
    width: 36,
    pointerEvents: 'none',
    borderRadius: side === 'right' ? '0 10px 10px 0' : '10px 0 0 10px',
    // A scroll shadow reads on any surface (unlike a fade to the panel colour, which
    // vanishes over same-coloured rows) so the off-screen column is always cued.
    background: `linear-gradient(to ${side}, rgba(0,0,0,0), rgba(0,0,0,0.38))`,
  };
}
