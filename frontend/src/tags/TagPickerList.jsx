import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';
import { useMessageTags, invalidateTags, useTagDefinitionsRevision } from './tagStore.js';

// The user's tags as a checkbox list to put on or take off one message.
export default function TagPickerList({ messageId }) {
  const { t } = useTranslation();
  const [defs, setDefs] = useState(null);
  const [error, setError] = useState(null);
  const current = useMessageTags(messageId);

  const revision = useTagDefinitionsRevision();
  useEffect(() => { api.tagDefinitions().then(setDefs).catch((e) => setError(e.message)); }, [revision]);

  const toggle = async (def, on) => {
    try {
      await api.tagSet(messageId, def.id, on);
      invalidateTags([messageId]);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };

  const row = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', fontSize: 13, color: 'var(--text-primary)' };
  if (!defs) return <div style={{ ...row, color: 'var(--text-tertiary)' }}>{error || '...'}</div>;
  if (!defs.length) return <div style={{ ...row, color: 'var(--text-tertiary)' }}>{t('tags.header.none')}</div>;

  return (
    <div>
      {defs.map((def) => {
        const on = current.some((x) => x.tagId === def.id);
        return (
          <div key={def.id} style={row}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer' }}>
              <input type="checkbox" checked={on} onChange={() => toggle(def, !on)} />
              <span style={{ width: 9, height: 9, borderRadius: 3, background: def.color }} />
              <span style={{ flex: 1 }}>{def.name}</span>
            </label>
          </div>
        );
      })}
      {error && <div style={{ ...row, color: 'var(--red, #ef4444)' }}>{error}</div>}
    </div>
  );
}
