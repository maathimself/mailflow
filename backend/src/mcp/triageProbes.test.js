import { describe, it, expect, vi, beforeEach } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('../services/embeddings/client.js', () => ({
  EmbeddingClient: class {
    constructor(cfg) {
      clientMocks.construct(cfg);
    }

    embed(inputs) {
      return clientMocks.embed(inputs);
    }
  },
}));

const probesPromise = import('./triageProbes.js').catch(() => null);

const cfg = {
  endpoint: 'https://embeddings.example.test/v1',
  apiKey: 'secret',
  model: 'embed-model',
  dimension: 2,
};

const vectors = [
  [1, 0],
  [0.8, 0.2],
  [0, 1],
  [-0.5, 0.5],
  [-1, 0],
];

describe('getTriageProbeVectors', () => {
  beforeEach(() => {
    clientMocks.construct.mockReset();
    clientMocks.embed.mockReset();
  });

  it('embeds all five fixed probes in one client call', async () => {
    const probes = await probesPromise;
    expect(probes?.getTriageProbeVectors).toBeTypeOf('function');
    clientMocks.embed.mockResolvedValueOnce(vectors);

    const result = await probes.getTriageProbeVectors(cfg, { fingerprint: 'fp-all-five' });

    expect(clientMocks.construct).toHaveBeenCalledOnce();
    expect(clientMocks.construct).toHaveBeenCalledWith(cfg);
    expect(clientMocks.embed).toHaveBeenCalledOnce();
    expect(clientMocks.embed).toHaveBeenCalledWith(Object.values(probes.TRIAGE_PROBES));
    expect(result).toEqual(Object.fromEntries(
      Object.keys(probes.TRIAGE_PROBES).map((name, index) => [name, vectors[index]]),
    ));
  });

  it('reuses one cached result for a fingerprint and re-embeds for a new generation', async () => {
    const probes = await probesPromise;
    clientMocks.embed
      .mockResolvedValueOnce(vectors)
      .mockResolvedValueOnce(vectors.map(vector => [...vector].reverse()));

    const first = await probes.getTriageProbeVectors(cfg, { fingerprint: 'fp-cache-a' });
    const second = await probes.getTriageProbeVectors(cfg, { fingerprint: 'fp-cache-a' });

    expect(second).toBe(first);
    expect(clientMocks.embed).toHaveBeenCalledTimes(1);

    const changed = await probes.getTriageProbeVectors(cfg, { fingerprint: 'fp-cache-b' });
    expect(changed).not.toBe(first);
    expect(clientMocks.embed).toHaveBeenCalledTimes(2);
  });
});

describe('scoreTriageProbes', () => {
  it('ranks a hand-built candidate closer to the aligned probe', async () => {
    const probes = await probesPromise;
    expect(probes?.scoreTriageProbes).toBeTypeOf('function');

    const scores = probes.scoreTriageProbes([1, 0], {
      urgent: [0.9, 0.1],
      needs_reply: [0.5, 0.5],
      financial: [-1, 0],
      scheduling: [0.2, 0.8],
      bulk: [0, 1],
    });

    expect(Object.keys(scores)).toEqual(Object.keys(probes.TRIAGE_PROBES));
    expect(scores.urgent).toBeGreaterThan(scores.needs_reply);
    expect(scores.needs_reply).toBeGreaterThan(scores.bulk);
    expect(scores.bulk).toBeGreaterThan(scores.financial);
    expect(scores.urgent).toBeCloseTo(0.9939, 4);
  });
});
