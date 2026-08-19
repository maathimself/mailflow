// Antispam API client (v0.2) — thin wrapper around the /api/spam endpoints.
// Kept separate from api.js so the antispam UI code speaks one vocabulary.
import { CSRF_HEADER, CSRF_VALUE } from './api.js';

const BASE = '/api/spam';

async function request(method, path, body) {
  const opts = {
    method,
    credentials: 'include',
    headers: { [CSRF_HEADER]: CSRF_VALUE },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    if (res.status === 423) window.dispatchEvent(new CustomEvent('mailflow:locked'));
    if (res.status === 401) window.dispatchEvent(new CustomEvent('mailflow:session_expired'));
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const spamApi = {
  getStatus: () => request('GET', '/status'),
  getThresholds: () => request('GET', '/thresholds'),
  updateThresholds: (patch) => request('PATCH', '/thresholds', patch),
  getDecayThreshold: () => request('GET', '/decay-threshold'),
  updateDecayThreshold: (decayThresholdDays) =>
    request('PATCH', '/decay-threshold', { decayThresholdDays }),
  retrainNow: () => request('POST', '/retrain-now'),
  enable: (enabled) => request('POST', '/enable', { enabled }),
  resetTrainingAll: () => request('POST', '/reset-training-all', { confirm: true }),
  getDeletions: () => request('GET', '/deletions'),
  explain: (messageId) => request('GET', `/explain?messageId=${encodeURIComponent(messageId)}`),
};