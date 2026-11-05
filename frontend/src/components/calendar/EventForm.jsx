import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FREQS, FREQ_KEYS, REMINDER_KEYS, buildPayload, changeStart, emptyForm, formFromOccurrence, offeredCalendars,
  reminderOptions, toggleAllDay,
} from './calendarEvents.js';
import { Btn, ErrorBox, Modal, inputStyle, labelStyle } from './calendarUi.jsx';

const Field = ({ label, children, style }) => (
  <label style={{ display: 'block', ...style }}>
    <span style={labelStyle}>{label}</span>
    {children}
  </label>
);

export default function EventForm({ occ, scope, defaults, calendars, isMobile, onSave, onClose, formatError }) {
  const { t } = useTranslation();
  const editing = Boolean(occ);
  const own = editing ? calendars.find(c => c.id === occ.calendarId) : null;
  const offered = offeredCalendars(calendars, { editing, accountId: own?.accountId });
  const [form, setForm] = useState(() => (editing
    ? formFromOccurrence(occ)
    : emptyForm({ calendarId: offered[0]?.id || '', ...defaults })));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm(f => ({ ...f, ...patch }));
  const series = scope !== 'this';
  const custom = editing && occ.recurrenceCustom;
  const reminders = reminderOptions(form.reminder);

  const submit = async (e) => {
    e?.preventDefault();
    if (saving) return;
    const built = buildPayload(form, { scope, recurrenceCustom: custom });
    if (built.error) { setError(t(built.error)); return; }
    setError(null);
    setSaving(true);
    try {
      await onSave(built.payload);
    } catch (err) {
      setError(formatError(err));
      setSaving(false);
    }
  };

  const title = editing ? t('calendar.form.editTitle') : t('calendar.form.newTitle');
  return (
    <Modal title={title} onClose={onClose} width={520} mobile={isMobile}
      footer={(
        <>
          <Btn kind="plain" onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn kind="primary" onClick={submit} disabled={saving || offered.length === 0}>{saving ? t('common.saving') : t('common.save')}</Btn>
        </>
      )}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label={t('calendar.form.title')}>
          <input data-autofocus="" value={form.summary} onChange={e => set({ summary: e.target.value })} style={{ ...inputStyle, fontSize: 15 }} />
        </Field>

        <Field label={t('calendar.form.calendar')}>
          <select value={form.calendarId} onChange={e => set({ calendarId: e.target.value })} disabled={!series || offered.length === 0} style={inputStyle}>
            {offered.map(c => <option key={c.id} value={c.id}>{c.accountName ? `${c.name} (${c.accountName})` : c.name}</option>)}
          </select>
        </Field>
        {offered.length === 0 && <ErrorBox>{t('calendar.form.noWritable')}</ErrorBox>}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.allDay} onChange={() => setForm(toggleAllDay)} style={{ accentColor: 'var(--accent)' }} />
          {t('calendar.allDay')}
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12 }}>
          <Field label={t('calendar.form.start')}>
            {form.allDay
              ? <input type="date" value={form.startDay} onChange={e => setForm(f => changeStart(f, e.target.value))} style={inputStyle} />
              : <input type="datetime-local" value={form.startLocal} onChange={e => setForm(f => changeStart(f, e.target.value))} style={inputStyle} />}
          </Field>
          <Field label={t('calendar.form.end')}>
            {form.allDay
              ? <input type="date" value={form.endDay} min={form.startDay} onChange={e => set({ endDay: e.target.value })} style={inputStyle} />
              : <input type="datetime-local" value={form.endLocal} min={form.startLocal} onChange={e => set({ endLocal: e.target.value })} style={inputStyle} />}
          </Field>
        </div>

        <Field label={t('calendar.form.location')}>
          <input value={form.location} onChange={e => set({ location: e.target.value })} style={inputStyle} />
        </Field>
        <Field label={t('calendar.form.description')}>
          <textarea value={form.description} onChange={e => set({ description: e.target.value })} rows={4} style={{ ...inputStyle, resize: 'vertical' }} />
        </Field>

        {series && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {custom ? (
              <Field label={t('calendar.form.repeat')}>
                <div style={{ ...inputStyle, color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>{t('calendar.recurrence.custom')}</div>
                <span style={{ ...labelStyle, marginTop: 4, marginBottom: 0 }}>{t('calendar.form.customHint')}</span>
              </Field>
            ) : (
              <>
                <Field label={t('calendar.form.repeat')}>
                  <select value={form.freq} onChange={e => set({ freq: e.target.value })} style={inputStyle}>
                    <option value="">{t('calendar.recurrence.none')}</option>
                    {FREQS.map(f => <option key={f} value={f}>{t(FREQ_KEYS[f])}</option>)}
                  </select>
                </Field>
                {form.freq && (
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '110px 1fr 1fr', gap: 12, alignItems: 'end' }}>
                    <Field label={t('calendar.form.interval')}>
                      <input type="number" min={1} max={99} value={form.interval} onChange={e => set({ interval: e.target.value })} style={inputStyle} />
                    </Field>
                    <Field label={t('calendar.form.ends')}>
                      <select value={form.ends} onChange={e => set({ ends: e.target.value })} style={inputStyle}>
                        <option value="never">{t('calendar.form.endsNever')}</option>
                        <option value="until">{t('calendar.form.endsOn')}</option>
                        <option value="count">{t('calendar.form.endsAfter')}</option>
                      </select>
                    </Field>
                    {form.ends === 'until' && (
                      <Field label={t('calendar.form.endsOn')}>
                        <input type="date" value={form.until} onChange={e => set({ until: e.target.value })} style={inputStyle} />
                      </Field>
                    )}
                    {form.ends === 'count' && (
                      <Field label={t('calendar.form.count')}>
                        <input type="number" min={1} max={999} value={form.count} onChange={e => set({ count: e.target.value })} style={inputStyle} />
                      </Field>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <Field label={t('calendar.form.reminder')}>
          <select value={form.reminder} onChange={e => set({ reminder: e.target.value })} style={inputStyle}>
            <option value="">{t('calendar.reminder.none')}</option>
            {reminders.values.map(v => (
              <option key={v} value={String(v)}>{REMINDER_KEYS[v] ? t(REMINDER_KEYS[v]) : t('calendar.reminder.custom', { n: v })}</option>
            ))}
          </select>
        </Field>

        {error && <ErrorBox>{error}</ErrorBox>}
        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
