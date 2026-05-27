import { useEffect } from 'react';
import { useStore } from '../store/index.js';

export default function ElectronNotificationBridge() {
  const addNotification = useStore(state => state.addNotification);

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

  return null;
}
