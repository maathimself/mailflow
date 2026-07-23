export function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

export function sanitizeText(value, maxLength = 1000) {
  if (typeof value !== 'string') return '';
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export async function readLimited(response, limitBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (bytes < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limitBytes - bytes;
      const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
      bytes += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
      if (value.byteLength > remaining || bytes >= limitBytes) break;
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function* readSseData(response, { signal, maxEventBytes, createError } = {}) {
  const error = (reason) => createError?.(reason) || new Error(reason);
  if (!response.body) throw error('empty_body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });

  function parseBlock(block) {
    if (byteLength(block) > maxEventBytes) throw error('event_too_large');
    return block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
  }

  try {
    for (;;) {
      if (signal?.aborted) throw error('aborted');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw error('aborted');
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.match(/\r?\n\r?\n/);
        if (!boundary || boundary.index === undefined) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = parseBlock(block);
        if (data) yield data;
      }
      if (byteLength(buffer) > maxEventBytes) throw error('event_too_large');
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = parseBlock(buffer);
      if (data) yield data;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
  }
}

export function createRequestSignal(callerSignal, timeoutMs, timeoutMessage = 'request timed out') {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(callerSignal?.reason || new Error('request aborted'));
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    },
  };
}
