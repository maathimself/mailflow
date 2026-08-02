import { query } from '../db.js';
import { decrypt } from '../encryption.js';

// Bump when preprocess.js changes its output for the same flags (tighten a regex,
// add a tracking param, add a default-on transform). Folds into the generation
// fingerprint so a policy change forces a new generation. Port of config.go preprocessVersion.
export const PREPROCESS_VERSION = 1;
// Bump when worker.js/chunk.js change the vector layout for the same preprocess
// output (chunk window/overlap/cap). Port of config.go embedPolicyVersion.
export const EMBED_POLICY_VERSION = 1;

const PREPROCESS_FLAG_ORDER = [
  'stripQuotes', 'stripSignatures', 'stripHTML', 'stripBase64', 'stripURLTracking', 'collapseWhitespace',
];

export function preprocessFingerprint(pp) {
  const bits = PREPROCESS_FLAG_ORDER.map((k) => (pp[k] ? '1' : '0')).join('');
  return `p${PREPROCESS_VERSION}-${bits}`;
}

export function generationFingerprint(cfg) {
  return `${cfg.model}:${cfg.dimension}:${preprocessFingerprint(cfg.preprocess)}:c${cfg.maxInputChars}:e${EMBED_POLICY_VERSION}`;
}

function resolveFlag(v) { return v === undefined || v === null ? true : v === true; }

export function applyEmbedDefaults(raw) {
  const pp = raw.preprocess || {};
  return {
    enabled: raw.enabled === true,
    endpoint: (raw.endpoint || '').trim().replace(/\/+$/, ''),
    apiKey: raw.apiKey || null,
    model: (raw.model || '').trim(),
    dimension: Number(raw.dimension) || 0,
    maxInputChars: Number(raw.maxInputChars) > 0 ? Number(raw.maxInputChars) : 32768,
    batchSize: Number(raw.batchSize) > 0 ? Number(raw.batchSize) : 32,
    skipExtensionCreate: raw.skipExtensionCreate === true,
    preprocess: {
      stripQuotes: resolveFlag(pp.stripQuotes),
      stripSignatures: resolveFlag(pp.stripSignatures),
      stripHTML: resolveFlag(pp.stripHTML),
      stripBase64: resolveFlag(pp.stripBase64),
      stripURLTracking: resolveFlag(pp.stripURLTracking),
      collapseWhitespace: resolveFlag(pp.collapseWhitespace),
    },
  };
}

export async function resolveEmbedConfig() {
  const result = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!result.rows.length) return null;
  let cfg;
  try { cfg = JSON.parse(result.rows[0].value); } catch { return null; }
  if (!cfg.embeddings) return null;
  const resolved = applyEmbedDefaults(cfg.embeddings);
  resolved.apiKey = resolved.apiKey ? decrypt(resolved.apiKey) : null;
  return resolved;
}
