import { useEffect } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

export default function ElectronNotificationBridge() {
  const addNotification = useStore(state => state.addNotification);
  const openCompose = useStore(state => state.openCompose);

  useEffect(() => {
    const unsubscribe = window.mailflowNative?.notifications?.onPush?.((notification) => {
      addNotification({
        type: notification.type === 'negative' ? 'error' : notification.type,
        title: notification.title,
        body: notification.body || notification.message,
      });
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification]);

  useEffect(() => {
    const handleNativeAction = async (event) => {
      const action = event.detail?.action;

      if (action === 'new-mail') {
        openCompose({});
        return;
      }

      if (action === 'sync') {
        try {
          addNotification({
            type: 'info',
            title: 'Sync started',
            body: 'MailFlow is checking for new mail.',
          });
          await api.syncNow();
        } catch (error) {
          addNotification({
            type: 'error',
            title: 'Sync failed',
            body: error.message || 'Could not sync mail.',
          });
        }
      }
    };

    window.addEventListener('mailflow:native-action', handleNativeAction);
    return () => window.removeEventListener('mailflow:native-action', handleNativeAction);
  }, [addNotification, openCompose]);

  return null;
}
