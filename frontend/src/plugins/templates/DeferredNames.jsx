import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../utils/api.js';
import { useStore } from '../../store/index.js';
import { fillNames, fillNameHtml, findRecipientContact, needsContact, recipientAddress } from './variables.js';

// Mounted independently of More. Observe committed recipients rather than editor updates so
// edits and Undo never cause a name the user changed to be filled again.
export default function DeferredNames({ context }) {
  const { t } = useTranslation();
  const current = useRef(context);
  const translate = useRef(t);
  current.current = context;
  translate.current = t;
  const address = recipientAddress(context.getRecipients({ committedOnly: true })[0]);
  const { sessionId, disabled, editor } = context;
  useEffect(() => {
    if (!address || disabled) return;
    const initial = current.current;
    if (!needsContact(initial.getBody() + initial.getSubject())) return;
    let cancelled = false;
    findRecipientContact(api, address).then(contact => {
      const latest = current.current;
      if (cancelled || !contact || latest.disabled || latest.sessionId !== sessionId
        || recipientAddress(latest.getRecipients({ committedOnly: true })[0]) !== address) return;
      latest.transformContent({
        text: value => fillNames(value, contact),
        html: value => fillNameHtml(value, contact),
        subject: value => fillNames(value, contact).replace(/[\r\n]+/g, ' ').slice(0, 2000),
      });
    }).catch(failure => {
      if (!cancelled) useStore.getState().addNotification({ pluginId: 'templates', type: 'error', title: translate.current('templates.title'), body: failure.message });
    });
    return () => { cancelled = true; };
  }, [address, sessionId, disabled, editor]);
  return null;
}
