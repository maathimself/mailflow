import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as aiConfig from './aiConfig.js';

const {
  AI_ACCOUNT_PROVIDER_OPTIONS,
  AI_CONNECTION_METHOD_OPTIONS,
  DEFAULT_CODEX_MODEL,
  OPENAI_MODELS_URL,
  buildAiSavePayload,
  createCodexDevicePoller,
  isAiFormValid,
  normalizeAiForm,
  selectAiConnectionMethod,
} = aiConfig;

const englishAiCopy = JSON.parse(
  readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'),
).admin.ai;

describe('AI connection choices', () => {
  it('offers generic API and account methods before selecting an account provider', () => {
    assert.deepEqual(AI_CONNECTION_METHOD_OPTIONS, [
      { value: 'api', labelKey: 'admin.ai.connectionMethodApi' },
      { value: 'account', labelKey: 'admin.ai.connectionMethodAccount' },
    ]);
    assert.deepEqual(AI_ACCOUNT_PROVIDER_OPTIONS, [
      { value: 'chatgpt', labelKey: 'admin.ai.subscriptionProviderChatgpt' },
    ]);
  });

  it('uses the current lightweight GPT-5.6 model and canonical model directory', () => {
    assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.6-luna');
    assert.equal(OPENAI_MODELS_URL, 'https://developers.openai.com/api/docs/models');
  });

  it('uses the approved subscription wording exactly', () => {
    assert.equal(englishAiCopy.connectionMethodApi, 'Use an API key');
    assert.equal(englishAiCopy.connectionMethodAccount, 'Use a subscription');
    assert.equal(englishAiCopy.subscriptionProvider, 'Subscription provider');
    assert.equal(englishAiCopy.subscriptionProviderChatgpt, 'ChatGPT Plus/Pro (Codex Subscription)');
    assert.equal(englishAiCopy.chatgptModelDocs, 'View available models');
    assert.equal(Object.hasOwn(englishAiCopy, 'chatgptModelHelp'), false);
  });
});

function fakeScheduler() {
  const tasks = [];
  return {
    setTimer(fn, delay) {
      const task = { fn, delay, cancelled: false };
      tasks.push(task);
      return task;
    },
    clearTimer(task) {
      if (task) task.cancelled = true;
    },
    delays() {
      return tasks.filter((task) => !task.cancelled).map((task) => task.delay);
    },
    async runNext() {
      const task = tasks.find((candidate) => !candidate.cancelled);
      if (!task) return undefined;
      task.cancelled = true;
      return task.fn();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function deviceResponse(overrides = {}) {
  return {
    flowId: '11111111-1111-4111-8111-111111111111',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://auth.openai.com/codex/device',
    intervalMs: 5000,
    expiresAt: 100_000,
    status: 'pending',
    ...overrides,
  };
}

function pollerFixture(overrides = {}) {
  const scheduler = fakeScheduler();
  const states = [];
  let currentTime = 10_000;
  const calls = { start: 0, poll: [], cancel: [] };
  const startDevice = overrides.startDevice || (async () => {
    calls.start++;
    return deviceResponse();
  });
  const pollDevice = overrides.pollDevice || (async (flowId) => {
    calls.poll.push(flowId);
    return { status: 'pending', retryAfterMs: 5000 };
  });
  const cancelDevice = overrides.cancelDevice || (async (flowId) => {
    calls.cancel.push(flowId);
    return { status: 'cancelled' };
  });
  const poller = createCodexDevicePoller({
    startDevice,
    pollDevice,
    cancelDevice,
    onState: (state) => states.push(state),
    now: () => currentTime,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  return {
    poller,
    scheduler,
    states,
    calls,
    setNow(value) { currentTime = value; },
  };
}

describe('normalizeAiForm', () => {
  it('requires a new configuration to choose a connection method first', () => {
    assert.deepEqual(normalizeAiForm(), {
      enabled: true,
      connectionMethod: '',
      accountProvider: '',
      apiKeyConfig: { baseUrl: '', apiKey: '', model: '' },
      chatgptConfig: { model: 'gpt-5.6-luna' },
      features: { compose: true, summarize: true },
    });
  });

  it('normalizes legacy API-key configuration without losing values', () => {
    assert.deepEqual(normalizeAiForm({
      enabled: true,
      baseUrl: 'http://ollama:11434/v1',
      apiKey: '••••••••',
      model: 'llama3',
      features: { compose: false, summarize: true },
    }), {
      enabled: true,
      connectionMethod: 'api',
      accountProvider: '',
      apiKeyConfig: { baseUrl: 'http://ollama:11434/v1', apiKey: '••••••••', model: 'llama3' },
      chatgptConfig: { model: 'gpt-5.6-luna' },
      features: { compose: false, summarize: true },
    });
  });

  it('normalizes structured configuration and defaults feature flags', () => {
    assert.deepEqual(normalizeAiForm({
      enabled: false,
      provider: 'chatgpt',
      apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: '••••••••', model: 'fallback' },
      chatgptConfig: { model: 'gpt-5.4' },
    }), {
      enabled: false,
      connectionMethod: 'account',
      accountProvider: 'chatgpt',
      apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: '••••••••', model: 'fallback' },
      chatgptConfig: { model: 'gpt-5.4' },
      features: { compose: true, summarize: true },
    });
  });

  it('rejects an unknown account provider instead of silently selecting ChatGPT', () => {
    assert.throws(
      () => normalizeAiForm({ connectionMethod: 'account', accountProvider: 'another-lab' }),
      /unsupported account provider/i,
    );
  });
});

describe('selectAiConnectionMethod', () => {
  it('selects the only subscription provider when account mode is chosen', () => {
    const form = selectAiConnectionMethod(normalizeAiForm(), 'account');
    assert.equal(form.connectionMethod, 'account');
    assert.equal(form.accountProvider, 'chatgpt');
    assert.equal(form.chatgptConfig.model, 'gpt-5.6-luna');
  });

  it('switches connection method without losing either provider configuration', () => {
    assert.equal(typeof selectAiConnectionMethod, 'function');
    const original = normalizeAiForm({
      provider: 'chatgpt',
      apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: '••••••••', model: 'fallback' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    });

    const apiForm = selectAiConnectionMethod(original, 'api');
    const accountForm = selectAiConnectionMethod(apiForm, 'account');

    assert.equal(apiForm.connectionMethod, 'api');
    assert.equal(accountForm.connectionMethod, 'account');
    assert.equal(accountForm.accountProvider, 'chatgpt');
    assert.deepEqual(accountForm.apiKeyConfig, original.apiKeyConfig);
    assert.deepEqual(accountForm.chatgptConfig, original.chatgptConfig);
    assert.equal(original.connectionMethod, 'account');
  });

  it('rejects an unknown connection method', () => {
    assert.equal(typeof selectAiConnectionMethod, 'function');
    assert.throws(
      () => selectAiConnectionMethod(normalizeAiForm(), 'automatic'),
      /unsupported connection method/i,
    );
  });
});

describe('isAiFormValid', () => {
  it('does not allow saving before a connection method is chosen', () => {
    assert.equal(isAiFormValid(normalizeAiForm()), false);
    assert.equal(isAiFormValid({ ...normalizeAiForm(), enabled: false }), false);
  });

  it('validates only the selected connection method', () => {
    assert.equal(typeof isAiFormValid, 'function');
    assert.equal(isAiFormValid({
      enabled: true,
      connectionMethod: 'api',
      apiKeyConfig: { baseUrl: 'https://api.example/v1', model: 'fallback' },
      chatgptConfig: { model: '' },
    }), true);
    assert.equal(isAiFormValid({
      enabled: true,
      connectionMethod: 'account',
      accountProvider: 'chatgpt',
      apiKeyConfig: { baseUrl: '', model: '' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    }), true);
  });

  it('rejects incomplete or unsupported active connection settings', () => {
    assert.equal(typeof isAiFormValid, 'function');
    assert.equal(isAiFormValid({
      enabled: true,
      connectionMethod: 'api',
      apiKeyConfig: { baseUrl: '', model: 'fallback' },
    }), false);
    assert.equal(isAiFormValid({
      enabled: true,
      connectionMethod: 'account',
      accountProvider: 'chatgpt',
      chatgptConfig: { model: '' },
    }), false);
    assert.equal(isAiFormValid({
      enabled: true,
      connectionMethod: 'account',
      accountProvider: 'future-provider',
      chatgptConfig: { model: 'gpt-5.4-mini' },
    }), false);
    assert.equal(isAiFormValid({ enabled: false }), false);
  });
});

describe('buildAiSavePayload', () => {
  it('rejects an ambiguous save before a connection method is chosen', () => {
    assert.throws(
      () => buildAiSavePayload(normalizeAiForm()),
      /connection method/i,
    );
  });

  it('maps API connection mode to the existing backend provider contract', () => {
    const payload = buildAiSavePayload(normalizeAiForm({
      provider: 'api-key',
      apiKeyConfig: { baseUrl: 'https://api.example/v1/', apiKey: '••••••••', model: 'fallback' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    }));

    assert.deepEqual(payload, {
      enabled: true,
      provider: 'api-key',
      apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: '••••••••', model: 'fallback' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
      features: { compose: true, summarize: true },
    });
    assert.equal('connectionMethod' in payload, false);
    assert.equal('accountProvider' in payload, false);
  });

  it('preserves inactive API-key values while switching to ChatGPT', () => {
    const form = normalizeAiForm({
      enabled: true,
      provider: 'api-key',
      apiKeyConfig: { baseUrl: 'https://api.example/v1/', apiKey: '••••••••', model: 'fallback' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
    });
    const accountForm = selectAiConnectionMethod(form, 'account');
    accountForm.device = { accessToken: 'must-not-leak' };
    assert.deepEqual(buildAiSavePayload(accountForm), {
      enabled: true,
      provider: 'chatgpt',
      apiKeyConfig: { baseUrl: 'https://api.example/v1', apiKey: '••••••••', model: 'fallback' },
      chatgptConfig: { model: 'gpt-5.4-mini' },
      features: { compose: true, summarize: true },
    });
    assert.equal('connectionMethod' in buildAiSavePayload(accountForm), false);
    assert.equal('accountProvider' in buildAiSavePayload(accountForm), false);
  });
});


describe('createCodexDevicePoller', () => {
  it('publishes only the display code, link, and timing state on start', async () => {
    const fixture = pollerFixture();
    const state = await fixture.poller.start();
    assert.deepEqual(state, {
      phase: 'pending',
      flowId: '11111111-1111-4111-8111-111111111111',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: 100_000,
      retryAfterMs: 5000,
    });
    assert.deepEqual(fixture.scheduler.delays(), [5000]);
    assert.equal(JSON.stringify(fixture.states).includes('token'), false);
  });

  it('resumes a server-backed pending flow without requesting a second code', async () => {
    const fixture = pollerFixture();
    const state = await fixture.poller.start(deviceResponse({ intervalMs: 7000 }));
    assert.equal(fixture.calls.start, 0);
    assert.equal(state.flowId, '11111111-1111-4111-8111-111111111111');
    assert.deepEqual(fixture.scheduler.delays(), [7000]);
  });

  it('uses each server retry delay and never overlaps polls', async () => {
    const firstPoll = deferred();
    let pollCalls = 0;
    const fixture = pollerFixture({
      pollDevice: async () => {
        pollCalls++;
        return firstPoll.promise;
      },
    });
    await fixture.poller.start();
    const running = fixture.scheduler.runNext();
    assert.equal(pollCalls, 1);
    assert.deepEqual(fixture.scheduler.delays(), []);
    await fixture.scheduler.runNext();
    assert.equal(pollCalls, 1);

    firstPoll.resolve({ status: 'pending', retryAfterMs: 9000 });
    await running;
    assert.deepEqual(fixture.scheduler.delays(), [9000]);
  });

  it('expires locally before issuing another poll', async () => {
    const fixture = pollerFixture();
    await fixture.poller.start();
    fixture.setNow(100_000);
    await fixture.scheduler.runNext();
    assert.equal(fixture.calls.poll.length, 0);
    assert.deepEqual(fixture.states.at(-1), { phase: 'expired' });
    assert.deepEqual(fixture.scheduler.delays(), []);
  });

  it('cancels the owned flow and ignores a stale in-flight poll', async () => {
    const pending = deferred();
    const fixture = pollerFixture({ pollDevice: () => pending.promise });
    await fixture.poller.start();
    const running = fixture.scheduler.runNext();
    await fixture.poller.cancel();
    assert.deepEqual(fixture.calls.cancel, ['11111111-1111-4111-8111-111111111111']);
    assert.deepEqual(fixture.states.at(-1), { phase: 'cancelled' });

    pending.resolve({ status: 'pending', retryAfterMs: 5000 });
    await running;
    assert.deepEqual(fixture.scheduler.delays(), []);
    assert.deepEqual(fixture.states.at(-1), { phase: 'cancelled' });
  });

  for (const [response, expected] of [
    [{ status: 'connected' }, { phase: 'connected' }],
    [{ status: 'failed', reconnectRequired: true, reason: 'authorization_failed' }, {
      phase: 'failed', reconnectRequired: true, reason: 'authorization_failed',
    }],
    [{ status: 'cancelled' }, { phase: 'cancelled' }],
    [{ status: 'expired' }, { phase: 'expired' }],
  ]) {
    it(`maps terminal poll response ${response.status} to UI state`, async () => {
      const fixture = pollerFixture({ pollDevice: async () => response });
      await fixture.poller.start();
      await fixture.scheduler.runNext();
      assert.deepEqual(fixture.states.at(-1), expected);
      assert.deepEqual(fixture.scheduler.delays(), []);
    });
  }

  it('disposes timers and suppresses late state updates', async () => {
    const pending = deferred();
    const fixture = pollerFixture({ pollDevice: () => pending.promise });
    await fixture.poller.start();
    const running = fixture.scheduler.runNext();
    const stateCount = fixture.states.length;
    fixture.poller.dispose();
    pending.resolve({ status: 'connected' });
    await running;
    assert.equal(fixture.states.length, stateCount);
    assert.deepEqual(fixture.scheduler.delays(), []);
  });

});
