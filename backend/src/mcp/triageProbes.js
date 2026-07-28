import { EmbeddingClient } from '../services/embeddings/client.js';

// Fixed v1 probes: they are not user-tunable. Raw cosine scores are not
// calibrated across requests or users; only ranking candidates within one
// response is meaningful, so callers must not treat them as global thresholds.
export const TRIAGE_PROBES = {
  urgent:      'urgent, needs action today, deadline, time sensitive',
  needs_reply: 'a direct question addressed to me that expects a reply',
  financial:   'invoice, payment due, receipt, billing, subscription charge',
  scheduling:  'meeting request, calendar invite, reschedule, availability',
  bulk:        'newsletter, marketing promotion, unsubscribe, mass mailing',
};

const vectorsByFingerprint = new Map();

export async function getTriageProbeVectors(cfg, generation) {
  const fingerprint = generation?.fingerprint;
  if (!fingerprint) throw new Error('embedding generation fingerprint is required');
  if (vectorsByFingerprint.has(fingerprint)) {
    return vectorsByFingerprint.get(fingerprint);
  }

  const pending = (async () => {
    const names = Object.keys(TRIAGE_PROBES);
    const vectors = await new EmbeddingClient(cfg).embed(Object.values(TRIAGE_PROBES));
    if (!Array.isArray(vectors) || vectors.length !== names.length) {
      throw new Error(`embedder returned ${vectors?.length} probe vectors, want ${names.length}`);
    }
    return Object.fromEntries(names.map((name, index) => [name, vectors[index]]));
  })();
  vectorsByFingerprint.set(fingerprint, pending);

  try {
    return await pending;
  } catch (error) {
    if (vectorsByFingerprint.get(fingerprint) === pending) {
      vectorsByFingerprint.delete(fingerprint);
    }
    throw error;
  }
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    throw new Error('cosine similarity requires vector arrays');
  }
  if (left.length !== right.length) {
    throw new Error(`probe vector dimension mismatch: candidate=${left.length}, probe=${right.length}`);
  }

  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftSquared += left[index] * left[index];
    rightSquared += right[index] * right[index];
  }
  if (leftSquared === 0 || rightSquared === 0) return 0;
  return dot / (Math.sqrt(leftSquared) * Math.sqrt(rightSquared));
}

export function scoreTriageProbes(candidateVector, probeVectors) {
  return Object.fromEntries(
    Object.keys(TRIAGE_PROBES).map(name => [
      name,
      cosineSimilarity(candidateVector, probeVectors?.[name]),
    ]),
  );
}
