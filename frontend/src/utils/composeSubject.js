const FALLBACK_TRANSLATIONS = {
  'compose.replySubjectPrefix': 'Re:',
  'compose.forwardSubjectPrefix': 'Fwd:',
};

const PREFIXES = /^(?:(?:re|aw|fwd|fw|wg|odp|p\u0159ep|rv|r\u00e9p|rep|tr|risp|inoltr|enc|resp|\u043E\u0442\u0432|\u043E\u0442\u0432\u0435\u0442|\u043F\u0435\u0440\u0435\u0441\u043B|\u56DE\u590D|\u8F6C\u53D1|\uB2F5\uC7A5|\uC804\uB2EC):(?:\s+|$))+/iu;

export function translated(key, t, fallback) {
  const value = typeof t === 'function' ? t(key) : '';
  return typeof value === 'string' && value && value !== key ? value : fallback;
}

export function subjectWithPrefix(subject, type, t) {
  const prefixKey = type === 'reply' ? 'compose.replySubjectPrefix' : 'compose.forwardSubjectPrefix';
  const prefix = translated(prefixKey, t, FALLBACK_TRANSLATIONS[prefixKey]);
  const text = String(subject ?? '').replace(/[\r\n]+/g, ' ').trim().replace(PREFIXES, '').trim();
  return text ? `${prefix} ${text}` : prefix;
}
