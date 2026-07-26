import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { normalizeConversation } from '../utils/conversation.js';

export function useConversation(threadId) {
  const cachedMessages = useStore(state => (threadId ? state.threadMessages[threadId] : null));
  const setThreadMessages = useStore(state => state.setThreadMessages);
  const [loading, setLoading] = useState(Boolean(threadId && !cachedMessages));
  const [error, setError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const requestSequence = useRef(0);

  const retry = useCallback(() => setRetryKey(key => key + 1), []);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    if (!threadId || Array.isArray(cachedMessages)) {
      setLoading(false);
      setError(null);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getThread(threadId)
      .then(data => {
        if (cancelled || sequence !== requestSequence.current) return;
        setThreadMessages(threadId, data.messages || []);
      })
      .catch(requestError => {
        if (cancelled || sequence !== requestSequence.current) return;
        setError(requestError.message || 'Failed to load conversation');
      })
      .finally(() => {
        if (cancelled || sequence !== requestSequence.current) return;
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [cachedMessages, retryKey, setThreadMessages, threadId]);

  const messages = useMemo(() => normalizeConversation(cachedMessages || []), [cachedMessages]);
  return { messages, loading, error, retry };
}
