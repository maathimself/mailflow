// Multinomial Naive Bayes spam classifier — pure logic, no I/O (v0.2).
//
// The model is a per-user JSONB vocabulary {word: {spam, ham}} with running
// counts (incremental training) plus cached totals and priors, persisted in
// the spam_models table (migration 0049). This module implements the math;
// DB access lives in spamModelStore.js (V2-4).
//
// Scoring is done in LOG-PROBABILITY SPACE. The auth flags (DKIM/SPF/DMARC)
// carry FIXED asymmetric weights from ADR-001 v2 — they are NOT learned
// counts, so they are not stored in the vocabulary (that would double-count
// them). Heuristic flags (attachment, reply-to mismatch, all-caps) ARE
// learned tokens with the special `__name__` convention.
//
// References:
//   - .hermes/design/ADR-001-v0.2-ml-classifier-architecture.md (auth weights)
//   - .hermes/design/spam-classifier-v0.2.md §6.2 (MNB formula, priors)

export const MODEL_VERSION = 1;

export const ALPHA = 1.0; // Laplace smoothing

// Fixed auth-feature weights in log-space (ADR-001 v2, authoritative).
// Direction: fail -> spam (strong), pass -> ham (weak nudge).
export const AUTH_WEIGHTS = {
  dkim: { fail: 0.7, pass: -0.2 },
  spf: { fail: 0.7, pass: -0.1 },
  dmarc: { fail: 0.5, pass: -0.1 },
};

// Heuristic flags learned as special vocabulary tokens (design §6.1).
export const FLAG_TOKENS = {
  has_attachment: '__has_attachment__',
  attachment_is_executable: '__attachment_is_executable__',
  from_equals_reply_to_mismatch: '__from_replyto_mismatch__',
  all_caps_subject_high: '__all_caps_subject_high__',
};

const ALL_CAPS_RATIO_THRESHOLD = 0.5; // matches rules rule SUBJECT_ALL_CAPS

// ---------------------------------------------------------------------------
// Model shape
// ---------------------------------------------------------------------------
// {
//   vocabulary: { word: { spam: number, ham: number } },
//   totalSpam: number,          // sum of all spam counts (design §6.2 proxy)
//   totalHam: number,           // sum of all ham counts
//   priorSpam: number,          // 0..1, derived from totals (0.5 cold start)
//   priorHam: number,
//   trainingRecords: number,
//   modelVersion: number,
//   lastTrainedAt: string|null,
// }

export function createEmptyModel() {
  return {
    vocabulary: {},
    totalSpam: 0,
    totalHam: 0,
    priorSpam: 0.5,
    priorHam: 0.5,
    trainingRecords: 0,
    modelVersion: MODEL_VERSION,
    lastTrainedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

/**
 * Map flag features to the learned special tokens to count for a message.
 * Auth flags are intentionally NOT included (fixed weights, not learned).
 *
 * @param {Object} flagFeatures — shape of extractFlagFeatures()
 * @returns {string[]} special tokens present in this message
 */
export function flagTokensFor(flagFeatures) {
  const tokens = [];
  if (!flagFeatures) return tokens;
  if (flagFeatures.has_attachment === 1) tokens.push(FLAG_TOKENS.has_attachment);
  if (flagFeatures.attachment_is_executable === 1) {
    tokens.push(FLAG_TOKENS.attachment_is_executable);
  }
  if (flagFeatures.from_equals_reply_to_mismatch === 1) {
    tokens.push(FLAG_TOKENS.from_equals_reply_to_mismatch);
  }
  if ((flagFeatures.all_caps_subject_ratio ?? 0) > ALL_CAPS_RATIO_THRESHOLD) {
    tokens.push(FLAG_TOKENS.all_caps_subject_high);
  }
  return tokens;
}

/**
 * Incrementally train on one labeled message. Pure: returns a NEW model,
 * does not mutate the input.
 *
 * @param {Object} model — model shape above
 * @param {string[]} tokens — bag-of-words from spamTokenizer.tokenize()
 * @param {Object} flagFeatures — from spamTokenizer.extractFlagFeatures()
 * @param {'spam'|'ham'} label
 * @returns {Object} updated model
 */
export function updateIncremental(model, tokens, flagFeatures, label) {
  const key = label === 'spam' ? 'spam' : 'ham';
  const next = {
    ...model,
    vocabulary: { ...model.vocabulary },
    trainingRecords: model.trainingRecords + 1,
    lastTrainedAt: model.lastTrainedAt,
  };

  const allTokens = [...tokens, ...flagTokensFor(flagFeatures)];
  let added = 0;
  for (const token of allTokens) {
    const entry = next.vocabulary[token];
    if (entry) {
      next.vocabulary[token] = { ...entry, [key]: entry[key] + 1 };
    } else {
      next.vocabulary[token] = { spam: 0, ham: 0, [key]: 1 };
    }
    added += 1;
  }

  if (key === 'spam') next.totalSpam = model.totalSpam + added;
  else next.totalHam = model.totalHam + added;

  // Priors derived from the training set (design §6.2). total_spam/ham are
  // the documented proxy for per-class record counts.
  const sum = next.totalSpam + next.totalHam;
  next.priorSpam = sum === 0 ? 0.5 : next.totalSpam / sum;
  next.priorHam = sum === 0 ? 0.5 : next.totalHam / sum;
  return next;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function vocabSize(model) {
  return Object.keys(model.vocabulary).length;
}

/**
 * Classify a message. Pure.
 *
 * @param {Object} model
 * @param {string[]} tokens
 * @param {Object} flagFeatures — auth flags used for fixed ADR weights
 * @returns {{ verdict: 'spam'|'ham'|'uncertain', probability: number,
 *             confidence: number, method: 'ml' }}
 *   probability = sigmoid(logOdds) in [0,1]; confidence = |logOdds|
 *   (design §6.2); verdict = 'uncertain' on a zero-training model.
 */
export function classifyMessage(model, tokens, flagFeatures) {
  if (!model || model.trainingRecords === 0) {
    return { verdict: 'uncertain', probability: 0.5, confidence: 0, method: 'ml' };
  }

  const V = vocabSize(model);
  const { totalSpam, totalHam } = model;
  const alpha = ALPHA;

  // log P(w|spam) = log((n_w_spam + alpha) / (totalSpam + alpha*V))
  const logTerm = (count, total) => Math.log((count + alpha) / (total + alpha * V));

  // Priors in log space.
  let logOdds = Math.log(model.priorSpam) - Math.log(model.priorHam);

  for (const token of tokens) {
    const entry = model.vocabulary[token];
    if (!entry) continue; // unseen tokens contribute nothing (smoothing cancels)
    logOdds += logTerm(entry.spam, totalSpam) - logTerm(entry.ham, totalHam);
  }

  // Fixed auth weights (ADR v2). dkim_pass: 1=pass, 0=fail-like, null=absent.
  for (const method of ['dkim', 'spf', 'dmarc']) {
    const value = flagFeatures?.[`${method}_pass`];
    if (value === null || value === undefined) continue; // absent = neutral
    const weight = value === 1 ? AUTH_WEIGHTS[method].pass : AUTH_WEIGHTS[method].fail;
    logOdds += weight;
  }

  const probability = 1 / (1 + Math.exp(-logOdds));
  const confidence = Math.abs(logOdds);
  const verdict = logOdds > 0 ? 'spam' : 'ham';
  return { verdict, probability, confidence, method: 'ml' };
}

// ---------------------------------------------------------------------------
// Vocabulary pruning (chi-square feature selection)
// ---------------------------------------------------------------------------

/**
 * Prune the vocabulary with chi-square feature selection.
 *
 * Rules (design §14 / migration 0049 comment):
 *   - drop words with total count < 3 (too rare)
 *   - drop words with term frequency > 0.05 (likely stop-words)
 *   - keep the top maxSize (default 10000) words by chi-square
 *
 * Pure: returns a new model. Recomputes totals and priors.
 *
 * @param {Object} model
 * @param {number} [maxSize=10000]
 * @returns {Object} pruned model
 */
export function pruneVocabulary(model, maxSize = 10000) {
  const totalTokens = model.totalSpam + model.totalHam;
  if (totalTokens === 0) return model;

  const scored = [];
  for (const [word, { spam, ham }] of Object.entries(model.vocabulary)) {
    const count = spam + ham;
    if (count < 3) continue; // too rare
    const tf = count / totalTokens;
    if (tf > 0.05) continue; // likely stop-word
    scored.push({ word, spam, ham, chi2: chiSquare(spam, ham, model.totalSpam, model.totalHam, totalTokens) });
  }

  scored.sort((a, b) => b.chi2 - a.chi2);
  const kept = scored.slice(0, maxSize);

  const vocabulary = {};
  let totalSpam = 0;
  let totalHam = 0;
  for (const { word, spam, ham } of kept) {
    vocabulary[word] = { spam, ham };
    totalSpam += spam;
    totalHam += ham;
  }

  const sum = totalSpam + totalHam;
  return {
    ...model,
    vocabulary,
    totalSpam,
    totalHam,
    priorSpam: sum === 0 ? 0.5 : totalSpam / sum,
    priorHam: sum === 0 ? 0.5 : totalHam / sum,
  };
}

// 2x2 chi-square of a word's counts against the rest of the corpus.
function chiSquare(a, b, totalSpam, totalHam, totalTokens) {
  const c = totalSpam - a; // spam count of all other words
  const d = totalHam - b;  // ham count of all other words
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const col2 = b + d;
  if (row1 === 0 || row2 === 0 || col1 === 0 || col2 === 0) return 0;
  const numerator = totalTokens * (a * d - b * c) ** 2;
  const denominator = row1 * row2 * col1 * col2;
  return denominator === 0 ? 0 : numerator / denominator;
}

// ---------------------------------------------------------------------------
// Blending (design §6.3 / rules-detail §Integration with ML)
// ---------------------------------------------------------------------------

/**
 * Blend rules score with ML score based on training maturity.
 *
 * @param {number} mlScore — probability from classifyMessage() in [0,1]
 * @param {number} rulesScore — scoreRules() score in [0,1]
 * @param {number} trainingRecords
 * @returns {number} blended score in [0,1]
 */
export function blendScores(mlScore, rulesScore, trainingRecords) {
  if (trainingRecords < 50) return rulesScore; // rules-only
  if (trainingRecords <= 500) return 0.6 * rulesScore + 0.4 * mlScore;
  return 0.2 * rulesScore + 0.8 * mlScore;
}

// ---------------------------------------------------------------------------
// Explainability (SpamExplainModal)
// ---------------------------------------------------------------------------

/**
 * Top-N most discriminative tokens of a message for the "Why?" modal.
 *
 * @param {Object} model
 * @param {string[]} tokens
 * @param {number} [n=5]
 * @returns {Array<{token: string, contribution: number}>}
 *   contribution = log P(w|spam) - log P(w|ham); positive pushes toward spam.
 */
export function extractTopTokens(model, tokens, n = 5) {
  if (!model || model.trainingRecords === 0) return [];
  const V = vocabSize(model);
  const alpha = ALPHA;
  const logTerm = (count, total) => Math.log((count + alpha) / (total + alpha * V));

  const contributions = [];
  for (const token of tokens) {
    const entry = model.vocabulary[token];
    if (!entry) continue;
    const contribution =
      logTerm(entry.spam, model.totalSpam) - logTerm(entry.ham, model.totalHam);
    contributions.push({ token, contribution });
  }
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return contributions.slice(0, n);
}
