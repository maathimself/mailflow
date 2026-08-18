import { describe, expect, it } from 'vitest';
import {
  createEmptyModel,
  updateIncremental,
  classifyMessage,
  pruneVocabulary,
  blendScores,
  extractTopTokens,
  flagTokensFor,
  AUTH_WEIGHTS,
} from './spamModel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trainSpam(model, subject, body, flagFeatures = {}) {
  const tokens = tokenizeSimple(subject, body);
  return updateIncremental(model, tokens, flagFeatures, 'spam');
}

function trainHam(model, subject, body, flagFeatures = {}) {
  const tokens = tokenizeSimple(subject, body);
  return updateIncremental(model, tokens, flagFeatures, 'ham');
}

// Minimal deterministic tokenizer for tests (keeps the model tests focused
// on the math, not on spamTokenizer.js, which has its own suite).
function tokenizeSimple(subject, body) {
  return `${subject} ${body}`.toLowerCase().match(/[a-z]+/g) || [];
}

// Build a model with `spamCount` spam examples and `hamCount` ham examples
// using clearly separated vocabularies.
function trainedModel(spamCount = 10, hamCount = 10) {
  let model = createEmptyModel();
  for (let i = 0; i < spamCount; i += 1) {
    model = trainSpam(model, `cheap viagra pill`, `click buy now offer`);
  }
  for (let i = 0; i < hamCount; i += 1) {
    model = trainHam(model, `meeting agenda notes`, `please review the attached document`);
  }
  return model;
}

// ---------------------------------------------------------------------------
// updateIncremental
// ---------------------------------------------------------------------------

describe('updateIncremental', () => {
  it('is pure: does not mutate the input model', () => {
    const model = createEmptyModel();
    const before = JSON.stringify(model);
    updateIncremental(model, ['viagra'], {}, 'spam');
    expect(JSON.stringify(model)).toBe(before);
  });

  it('increments vocabulary counts and training records', () => {
    let model = createEmptyModel();
    model = updateIncremental(model, ['viagra', 'click'], {}, 'spam');
    expect(model.vocabulary.viagra).toEqual({ spam: 1, ham: 0 });
    expect(model.vocabulary.click).toEqual({ spam: 1, ham: 0 });
    expect(model.trainingRecords).toBe(1);

    model = updateIncremental(model, ['viagra'], {}, 'ham');
    expect(model.vocabulary.viagra).toEqual({ spam: 1, ham: 1 });
    expect(model.trainingRecords).toBe(2);
  });

  it('learns heuristic flag tokens but not auth tokens', () => {
    let model = createEmptyModel();
    model = updateIncremental(model, [], {
      dkim_pass: 0,           // auth: fixed weight, NOT learned
      spf_pass: 0,
      dmarc_pass: 1,
      has_attachment: 1,      // heuristic: learned
      attachment_is_executable: 0,
      all_caps_subject_ratio: 0.9,
      from_equals_reply_to_mismatch: 0,
    }, 'spam');
    expect(model.vocabulary.__has_attachment__).toEqual({ spam: 1, ham: 0 });
    expect(model.vocabulary.__all_caps_subject_high__).toEqual({ spam: 1, ham: 0 });
    expect(model.vocabulary.__dkim_fail__).toBeUndefined();
    expect(model.vocabulary.__dmarc_pass__).toBeUndefined();
  });

  it('derives priors from the training set (token-count proxy, design §6.2)', () => {
    let model = createEmptyModel();
    model = trainSpam(model, 'spam subject', 'body');     // 3 spam tokens
    model = trainHam(model, 'ham subject', 'body');       // 3 ham tokens
    model = trainHam(model, 'ham2', 'body2');             // 2 ham tokens
    expect(model.priorSpam).toBeCloseTo(3 / 8);           // 3 spam / (3+5) total
    expect(model.priorHam).toBeCloseTo(5 / 8);
  });
});

describe('flagTokensFor', () => {
  it('maps flag features to special tokens', () => {
    const tokens = flagTokensFor({
      has_attachment: 1,
      attachment_is_executable: 1,
      from_equals_reply_to_mismatch: 1,
      all_caps_subject_ratio: 0.9,
    });
    expect(tokens).toEqual([
      '__has_attachment__',
      '__attachment_is_executable__',
      '__from_replyto_mismatch__',
      '__all_caps_subject_high__',
    ]);
  });

  it('excludes auth flags (fixed weights, not learned)', () => {
    const tokens = flagTokensFor({ dkim_pass: 0, spf_pass: 0, dmarc_pass: 0 });
    expect(tokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// classifyMessage
// ---------------------------------------------------------------------------

describe('classifyMessage', () => {
  it('returns uncertain on a zero-training model', () => {
    const result = classifyMessage(createEmptyModel(), ['viagra'], {});
    expect(result.verdict).toBe('uncertain');
    expect(result.probability).toBe(0.5);
  });

  it('classifies a clearly spam message as spam', () => {
    const model = trainedModel(10, 10);
    const result = classifyMessage(model, ['viagra', 'click', 'buy', 'offer'], {});
    expect(result.verdict).toBe('spam');
    expect(result.probability).toBeGreaterThan(0.5);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('classifies a clearly ham message as ham', () => {
    const model = trainedModel(10, 10);
    const result = classifyMessage(model, ['meeting', 'agenda', 'notes', 'document'], {});
    expect(result.verdict).toBe('ham');
    expect(result.probability).toBeLessThan(0.5);
  });

  it('applies asymmetric auth weights (ADR v2)', () => {
    // Sanity: ADR v2 weights are asymmetric and fail-heavy.
    expect(AUTH_WEIGHTS.dkim).toEqual({ fail: 0.7, pass: -0.2 });
    expect(AUTH_WEIGHTS.spf).toEqual({ fail: 0.7, pass: -0.1 });
    expect(AUTH_WEIGHTS.dmarc).toEqual({ fail: 0.5, pass: -0.1 });
  });

  it('moves the verdict toward spam when all auth flags fail', () => {
    const model = trainedModel(10, 10);
    const neutral = classifyMessage(model, ['the', 'of', 'and'], {});
    const allFail = classifyMessage(model, ['the', 'of', 'and'], {
      dkim_pass: 0, spf_pass: 0, dmarc_pass: 0,
    });
    expect(allFail.probability).toBeGreaterThan(neutral.probability);
  });

  it('treats absent auth headers as neutral', () => {
    const model = trainedModel(10, 10);
    const absent = classifyMessage(model, ['meeting', 'agenda'], { dkim_pass: null });
    const explicitPass = classifyMessage(model, ['meeting', 'agenda'], { dkim_pass: 1 });
    // dkim_pass=1 is a weak ham nudge (-0.2): probability should drop slightly
    expect(explicitPass.probability).toBeLessThan(absent.probability);
  });

  it('classifies on a spam-heavy prior (unseen tokens contribute nothing)', () => {
    let model = trainedModel(10, 2); // spam-heavy: 70 spam tokens vs 16 ham
    // Tokens never seen in training: no vocabulary contribution, so the
    // derived prior (≈0.81) alone decides → spam.
    const result = classifyMessage(model, ['zzzqqq', 'yyyxxx'], {});
    expect(result.probability).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// pruneVocabulary
// ---------------------------------------------------------------------------

describe('pruneVocabulary', () => {
  it('drops words with total count < 3', () => {
    let model = createEmptyModel();
    model = updateIncremental(model, ['rareword'], {}, 'spam'); // count 1 → dropped
    // 30 distinct words x3 counts + common x3 = 93 tokens:
    // tf('common') = 3/93 ≈ 0.032 < 0.05 → survives the term-frequency filter.
    for (let i = 0; i < 30; i += 1) {
      model = updateIncremental(model, [`filler${i}`, `filler${i}`, `filler${i}`], {}, 'spam');
    }
    model = updateIncremental(model, ['common', 'common', 'common'], {}, 'spam');
    const pruned = pruneVocabulary(model);
    expect(pruned.vocabulary.rareword).toBeUndefined();
    expect(pruned.vocabulary.common).toBeDefined();
  });

  it('keeps at most maxSize words', () => {
    let model = createEmptyModel();
    for (let i = 0; i < 20; i += 1) {
      model = updateIncremental(model, [`word${i}`, `word${i}`, `word${i}`], {}, 'spam');
    }
    const pruned = pruneVocabulary(model, 5);
    expect(Object.keys(pruned.vocabulary).length).toBeLessThanOrEqual(5);
  });

  it('recomputes totals and priors after pruning', () => {
    let model = createEmptyModel();
    model = trainSpam(model, 'viagra click', 'buy now');
    model = trainSpam(model, 'viagra click', 'buy now');
    model = trainHam(model, 'meeting agenda', 'notes doc');
    const before = model.totalSpam;
    const pruned = pruneVocabulary(model);
    expect(pruned.totalSpam).toBeLessThanOrEqual(before);
    const sum = pruned.totalSpam + pruned.totalHam;
    expect(pruned.priorSpam).toBeCloseTo(sum === 0 ? 0.5 : pruned.totalSpam / sum);
  });

  it('is a no-op on an empty model', () => {
    const pruned = pruneVocabulary(createEmptyModel());
    expect(pruned).toEqual(createEmptyModel());
  });
});

// ---------------------------------------------------------------------------
// blendScores
// ---------------------------------------------------------------------------

describe('blendScores', () => {
  it('uses rules-only below 50 records', () => {
    expect(blendScores(0.9, 0.2, 10)).toBe(0.2);
  });

  it('blends 60/40 rules/ML between 50 and 500', () => {
    expect(blendScores(0.5, 0.5, 100)).toBe(0.5);
    expect(blendScores(1, 0, 100)).toBe(0.4);
  });

  it('blends 20/80 rules/ML above 500', () => {
    expect(blendScores(1, 0, 600)).toBe(0.8);
    expect(blendScores(0, 1, 600)).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// extractTopTokens
// ---------------------------------------------------------------------------

describe('extractTopTokens', () => {
  it('returns the most discriminative tokens first', () => {
    const model = trainedModel(10, 10);
    const tokens = ['viagra', 'click', 'meeting', 'agenda', 'document', 'buy'];
    const top = extractTopTokens(model, tokens, 5);
    expect(top.length).toBe(5);
    expect(top[0].token).toBe('viagra'); // strongest spam signal
    // contributions are ordered by |contribution| descending
    for (let i = 1; i < top.length; i += 1) {
      expect(Math.abs(top[i - 1].contribution)).toBeGreaterThanOrEqual(
        Math.abs(top[i].contribution),
      );
    }
  });

  it('returns [] for a zero-training model', () => {
    expect(extractTopTokens(createEmptyModel(), ['viagra'], 5)).toEqual([]);
  });

  it('ignores tokens not in the vocabulary', () => {
    const model = trainedModel(5, 5);
    expect(extractTopTokens(model, ['never-seen-word'], 5)).toEqual([]);
  });
});
