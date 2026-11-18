export const AI_PROVIDER_API_KEY = 'api-key';
export const AI_PROVIDER_CHATGPT = 'chatgpt';
export const AI_CONNECTION_METHOD_API = 'api';
export const AI_CONNECTION_METHOD_ACCOUNT = 'account';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
export const OPENAI_MODELS_URL = 'https://developers.openai.com/api/docs/models';
// What the server sends back in place of a stored secret (the API key, an extra header's value).
export const MASKED_SECRET = '••••••••';
export const MAX_EXTRA_HEADERS = 10;

export const AI_CONNECTION_METHOD_OPTIONS = [
  { value: AI_CONNECTION_METHOD_API, labelKey: 'admin.ai.connectionMethodApi' },
  { value: AI_CONNECTION_METHOD_ACCOUNT, labelKey: 'admin.ai.connectionMethodAccount' },
];
export const AI_ACCOUNT_PROVIDER_OPTIONS = [
  { value: AI_PROVIDER_CHATGPT, labelKey: 'admin.ai.subscriptionProviderChatgpt' },
];

const CONNECTION_METHODS = new Set(AI_CONNECTION_METHOD_OPTIONS.map(({ value }) => value));
const ACCOUNT_PROVIDERS = new Set(AI_ACCOUNT_PROVIDER_OPTIONS.map(({ value }) => value));

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanBaseUrl(value) {
  return cleanString(value).replace(/\/+$/, '');
}

// Extra request headers for the API connection (#746). A row read back from the server carries
// its value masked; storedName remembers the name it was stored under, since the server keeps a
// masked value only under that name.
function normalizeExtraHeaders(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(header => header && typeof header === 'object').map((header) => {
    const name = typeof header.name === 'string' ? header.name : '';
    const headerValue = typeof header.value === 'string' ? header.value : '';
    const storedName = typeof header.storedName === 'string'
      ? header.storedName
      : (headerValue === MASKED_SECRET ? name.trim() : '');
    return { name, value: headerValue, storedName };
  });
}

// Renaming a stored header takes its masked value with it: the server cannot know which value a
// new name means, so it is entered again.
export function renameExtraHeader(header, name) {
  const keepsStored = header.storedName && name.trim().toLowerCase() === header.storedName.toLowerCase();
  return { ...header, name, value: header.value === MASKED_SECRET && !keepsStored ? '' : header.value };
}

// Typing into a masked value starts a new one rather than adding to the mask, and deleting part
// of the mask clears it. Text that replaced the whole mask is the new value.
export function editExtraHeaderValue(header, value) {
  if (header.value !== MASKED_SECRET) return { ...header, value };
  if (value.startsWith(MASKED_SECRET)) return { ...header, value: value.slice(MASKED_SECRET.length) };
  return { ...header, value: value.includes(MASKED_SECRET[0]) ? '' : value };
}

export function normalizeAiForm(raw = {}) {
  const structured = raw.apiKeyConfig && typeof raw.apiKeyConfig === 'object';
  const apiKeyConfig = structured ? raw.apiKeyConfig : raw;
  const chatgptConfig = raw.chatgptConfig && typeof raw.chatgptConfig === 'object'
    ? raw.chatgptConfig
    : {};
  const explicitConnectionMethod = cleanString(raw.connectionMethod);
  if (explicitConnectionMethod && !CONNECTION_METHODS.has(explicitConnectionMethod)) {
    throw new TypeError(`Unsupported connection method: ${explicitConnectionMethod}`);
  }
  const explicitAccountProvider = cleanString(raw.accountProvider);
  if (explicitAccountProvider && !ACCOUNT_PROVIDERS.has(explicitAccountProvider)) {
    throw new TypeError(`Unsupported account provider: ${explicitAccountProvider}`);
  }
  const hasLegacyApiConfig = !structured && Boolean(
    cleanString(raw.baseUrl) || cleanString(raw.model) || typeof raw.apiKey === 'string',
  );
  const inferredConnectionMethod = ACCOUNT_PROVIDERS.has(raw.provider)
    ? AI_CONNECTION_METHOD_ACCOUNT
    : raw.provider === AI_PROVIDER_API_KEY || hasLegacyApiConfig
      ? AI_CONNECTION_METHOD_API
      : '';
  const connectionMethod = explicitConnectionMethod || inferredConnectionMethod;
  const accountProvider = explicitAccountProvider
    || (ACCOUNT_PROVIDERS.has(raw.provider) ? raw.provider : '')
    || (connectionMethod === AI_CONNECTION_METHOD_ACCOUNT ? AI_PROVIDER_CHATGPT : '');
  return {
    enabled: raw.enabled !== false,
    connectionMethod,
    accountProvider,
    apiKeyConfig: {
      baseUrl: cleanBaseUrl(apiKeyConfig.baseUrl),
      apiKey: typeof apiKeyConfig.apiKey === 'string' ? apiKeyConfig.apiKey : '',
      model: cleanString(apiKeyConfig.model),
      extraHeaders: normalizeExtraHeaders(apiKeyConfig.extraHeaders),
    },
    chatgptConfig: {
      model: cleanString(chatgptConfig.model) || DEFAULT_CODEX_MODEL,
    },
    features: {
      compose: raw.features?.compose !== false,
      summarize: raw.features?.summarize !== false,
    },
    newUsersEnabled: raw.newUsersEnabled !== false,
  };
}

export function selectAiConnectionMethod(form, connectionMethod) {
  if (!CONNECTION_METHODS.has(connectionMethod)) {
    throw new TypeError(`Unsupported connection method: ${connectionMethod}`);
  }
  return normalizeAiForm({ ...form, connectionMethod });
}

export function isAiFormValid(form = {}) {
  if (!CONNECTION_METHODS.has(form.connectionMethod)) return false;
  if (form.enabled === false) return true;
  if (form.connectionMethod === AI_CONNECTION_METHOD_API) {
    return !!cleanBaseUrl(form.apiKeyConfig?.baseUrl) && !!cleanString(form.apiKeyConfig?.model);
  }
  if (form.connectionMethod === AI_CONNECTION_METHOD_ACCOUNT
      && form.accountProvider === AI_PROVIDER_CHATGPT) {
    return !!cleanString(form.chatgptConfig?.model);
  }
  return false;
}

export function buildAiSavePayload(form = {}) {
  const normalized = normalizeAiForm(form);
  if (!CONNECTION_METHODS.has(normalized.connectionMethod)) {
    throw new TypeError('Select an AI connection method before saving');
  }
  return {
    enabled: normalized.enabled,
    provider: normalized.connectionMethod === AI_CONNECTION_METHOD_ACCOUNT
      ? normalized.accountProvider
      : AI_PROVIDER_API_KEY,
    apiKeyConfig: {
      baseUrl: normalized.apiKeyConfig.baseUrl,
      apiKey: normalized.apiKeyConfig.apiKey,
      model: normalized.apiKeyConfig.model,
      // A row left completely empty is not a header; the server checks the rest.
      extraHeaders: normalized.apiKeyConfig.extraHeaders
        .filter(header => header.name.trim() || header.value.trim())
        .map(header => ({ name: header.name.trim(), value: header.value })),
    },
    chatgptConfig: normalized.chatgptConfig,
    features: normalized.features,
    newUsersEnabled: normalized.newUsersEnabled,
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createCodexDevicePoller({
  startDevice,
  pollDevice,
  cancelDevice,
  onState,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof startDevice !== 'function' || typeof pollDevice !== 'function'
      || typeof cancelDevice !== 'function' || typeof onState !== 'function') {
    throw new TypeError('ChatGPT device poller dependencies are required');
  }

  let timer = null;
  let flow = null;
  let generation = 0;
  let disposed = false;

  function clearScheduledPoll() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function isCurrent(expectedGeneration) {
    return !disposed && expectedGeneration === generation;
  }

  function emit(state, expectedGeneration = generation) {
    if (!isCurrent(expectedGeneration)) return null;
    onState(state);
    return state;
  }

  function schedule(delay, expectedGeneration) {
    if (!isCurrent(expectedGeneration) || !flow) return;
    clearScheduledPoll();
    const boundedDelay = Math.max(0, finiteNumber(delay) ?? flow.intervalMs);
    timer = setTimer(() => pollOnce(expectedGeneration), boundedDelay);
  }

  function expireIfNeeded(expectedGeneration) {
    if (!flow || now() < flow.expiresAt) return false;
    flow = null;
    clearScheduledPoll();
    emit({ phase: 'expired' }, expectedGeneration);
    return true;
  }

  async function pollOnce(expectedGeneration) {
    timer = null;
    if (!isCurrent(expectedGeneration) || !flow || expireIfNeeded(expectedGeneration)) return;
    const activeFlow = flow;
    try {
      const response = await pollDevice(activeFlow.flowId);
      if (!isCurrent(expectedGeneration) || flow !== activeFlow) return;
      if (expireIfNeeded(expectedGeneration)) return;

      if (response?.status === 'pending') {
        schedule(response.retryAfterMs, expectedGeneration);
        return;
      }

      flow = null;
      clearScheduledPoll();
      if (response?.status === 'connected') {
        emit({ phase: 'connected' }, expectedGeneration);
      } else if (response?.status === 'failed') {
        emit({
          phase: 'failed',
          reconnectRequired: response.reconnectRequired === true,
          reason: cleanString(response.reason) || 'authorization_failed',
        }, expectedGeneration);
      } else if (['cancelled', 'expired'].includes(response?.status)) {
        emit({ phase: response.status }, expectedGeneration);
      } else {
        emit({ phase: 'error', message: 'ChatGPT authorization failed' }, expectedGeneration);
      }
    } catch {
      if (!isCurrent(expectedGeneration) || flow !== activeFlow) return;
      flow = null;
      clearScheduledPoll();
      emit({ phase: 'error', message: 'ChatGPT authorization failed' }, expectedGeneration);
    }
  }

  async function start(existingDevice = null) {
    if (disposed) throw new Error('ChatGPT device poller is disposed');
    const expectedGeneration = ++generation;
    flow = null;
    clearScheduledPoll();
    try {
      const response = existingDevice || await startDevice();
      if (!isCurrent(expectedGeneration)) return null;
      const flowId = cleanString(response?.flowId);
      const userCode = cleanString(response?.userCode);
      const verificationUrl = cleanString(response?.verificationUrl);
      const expiresAt = finiteNumber(response?.expiresAt);
      const intervalMs = finiteNumber(response?.intervalMs);
      if (!flowId || !userCode || !verificationUrl || expiresAt === null || intervalMs === null) {
        throw new Error('Invalid ChatGPT authorization response');
      }
      flow = { flowId, expiresAt, intervalMs };
      const state = emit({
        phase: 'pending',
        flowId,
        userCode,
        verificationUrl,
        expiresAt,
        retryAfterMs: intervalMs,
      }, expectedGeneration);
      schedule(intervalMs, expectedGeneration);
      return state;
    } catch (error) {
      if (isCurrent(expectedGeneration)) {
        flow = null;
        clearScheduledPoll();
        emit({ phase: 'error', message: 'Unable to start ChatGPT authorization' }, expectedGeneration);
      }
      throw error;
    }
  }

  async function cancel() {
    if (disposed) return;
    const flowId = flow?.flowId;
    const expectedGeneration = ++generation;
    flow = null;
    clearScheduledPoll();
    try {
      if (flowId) {
        await cancelDevice(flowId);
      }
      emit({ phase: 'cancelled' }, expectedGeneration);
    } catch (error) {
      emit({ phase: 'error', message: 'Unable to cancel ChatGPT authorization' }, expectedGeneration);
      throw error;
    }
  }

  function dispose() {
    disposed = true;
    generation++;
    flow = null;
    clearScheduledPoll();
  }

  return { start, cancel, dispose };
}
