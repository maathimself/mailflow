import { useTranslation } from 'react-i18next';
import { Btn, Modal } from './calendarUi.jsx';

const COPY = {
  edit: { title: 'calendar.scope.editTitle', all: 'calendar.scope.editAll' },
  move: { title: 'calendar.scope.moveTitle', all: 'calendar.scope.moveAll' },
  delete: { title: 'calendar.scope.deleteTitle', all: 'calendar.scope.deleteAll' },
};

export default function ScopeDialog({ kind, summary, isMobile, onChoose, onClose }) {
  const { t } = useTranslation();
  const copy = COPY[kind];
  const danger = kind === 'delete';
  return (
    <Modal title={t(copy.title)} onClose={onClose} width={400} mobile={isMobile}>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{summary}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Btn data-autofocus="" kind={danger ? 'danger' : 'ghost'} onClick={() => onChoose('this')} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 13.5 }}>
          {t('calendar.scope.thisOne')}
        </Btn>
        <Btn kind={danger ? 'danger' : 'primary'} onClick={() => onChoose('all')} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 13.5 }}>
          {t(copy.all)}
        </Btn>
        <Btn kind="plain" onClick={onClose} style={{ alignSelf: 'flex-end' }}>{t('common.cancel')}</Btn>
      </div>
    </Modal>
  );
}
