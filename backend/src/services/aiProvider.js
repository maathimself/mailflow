import { decrypt, encrypt } from './encryption.js';
import { query } from './db.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { validateHost } from './hostValidation.js';
import { createRequestSignal, parseJson, readLimited, readSseData, sanitizeText } from './aiHttp.js';
import { completeCodexText, streamCodexResponses } from './openaiCodexResponses.js';
import { getCodexAccess, getCodexStatus } from './openaiCodexAuth.js';

export const AI_PROVIDER_API_KEY = 'api-key';
export const AI_PROVIDER_CHATGPT = 'chatgpt';
export const MASKED_API_KEY = '••••••••';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';

const PROVIDERS = new Set([AI_PROVIDER_API_KEY, AI_PROVIDER_CHATGPT]);
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const SSE_EVENT_LIMIT_BYTES = 256 * 1024;
const OUTPUT_LIMIT_CHARS = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export class AiProviderError extends Error {
  constructor(message, { status = 503 } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.status = status;
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  return cleanString(value).replace(/\/+$/, '');
}

export function normalizeAiConfig(raw = {}) {
  const hasStructuredConfig = raw.apiKeyConfig && typeof raw.apiKeyConfig === 'object';
  const apiSource = hasStructuredConfig ? raw.apiKeyConfig : raw;
  const chatgptSource = raw.chatgptConfig && typeof raw.chatgptConfig === 'object'
    ? raw.chatgptConfig
    : {};
  const provider = PROVIDERS.has(raw.provider) ? raw.provider : AI_PROVIDER_API_KEY;
  return {
    enabled: raw.enabled !== false,
    provider,
    apiKeyConfig: {
      baseUrl: normalizeBaseUrl(apiSource.baseUrl),
      apiKey: apiSource.apiKey || null,
      model: cleanString(apiSource.model),
    },
    chatgptConfig: {
      model: cleanString(chatgptSource.model) || DEFAULT_CODEX_MODEL,
    },
    features: {
      compose: raw.features?.compose !== false,
      summarize: raw.features?.summarize !== false,
    },
  };
}

function publicConfig(config) {
  if (!config) return null;
  return {
    ...config,
    apiKeyConfig: {
      ...config.apiKeyConfig,
      apiKey: config.apiKeyConfig.apiKey ? MASKED_API_KEY : '',
    },
  };
}

function redactSecrets(value, secrets = []) {
  let redacted = value;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function providerError(status, text, secrets = []) {
  const parsed = parseJson(text);
  const raw = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message;
  const detail = sanitizeText(redactSecrets(raw || text, secrets));
  return new AiProviderError(`AI provider error (${status})${detail ? `: ${detail}` : ''}`, { status: 502 });
}

function providerRequestError(error, request, callerSignal) {
  if (request.timedOut()) return new AiProviderError('AI provider request timed out', { status: 504 });
  if (callerSignal?.aborted) return new AiProviderError('AI provider request was aborted', { status: 499 });
  if (error instanceof AiProviderError) return error;
  return new AiProviderError(
    `AI provider request failed: ${sanitizeText(error?.message) || 'network error'}`,
    { status: 502 },
  );
}

async function openProviderRequest(fetchFn, url, init, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const request = createRequestSignal(signal, timeoutMs, 'AI request timed out');
  try {
    const response = await fetchFn(url, { ...init, signal: request.signal });
    return { ...request, response };
  } catch (error) {
    request.cleanup();
    throw providerRequestError(error, request, signal);
  }
}

async function* parseChatCompletionsSse(response, { signal, secrets } = {}) {
  let outputChars = 0;
  const createError = (reason) => {
    if (reason === 'empty_body') return new AiProviderError('AI provider returned an empty stream', { status: 502 });
    if (reason === 'aborted') return new AiProviderError('AI provider request was aborted', { status: 499 });
    return new AiProviderError('AI provider stream event was too large', { status: 502 });
  };

  for await (const data of readSseData(response, {
    signal,
    maxEventBytes: SSE_EVENT_LIMIT_BYTES,
    createError,
  })) {
    if (data.trim() === '[DONE]') return;
    const event = parseJson(data);
    if (!event) throw new AiProviderError('AI provider returned a malformed stream event', { status: 502 });
    if (event.error) throw providerError(502, JSON.stringify({ error: event.error }), secrets);
    const delta = event.choices?.[0]?.delta?.content;
    if (typeof delta !== 'string' || !delta) continue;
    outputChars += delta.length;
    if (outputChars > OUTPUT_LIMIT_CHARS) throw new AiProviderError('AI provider output was too large', { status: 502 });
    yield delta;
  }
}

export function createAiProvider({
  queryFn = query,
  encryptFn = encrypt,
  decryptFn = decrypt,
  validateHostFn = validateHost,
  getConnectionPolicyFn = getConnectionPolicy,
  fetchFn = (...args) => fetch(...args),
  getCodexAccessFn = getCodexAccess,
  getCodexStatusFn = getCodexStatus,
  streamCodexResponsesFn = streamCodexResponses,
  completeCodexTextFn = completeCodexText,
} = {}) {
  async function loadAiConfig() {
    const result = await queryFn("SELECT value FROM system_settings WHERE key = 'ai_config'");
    if (!result.rows.length) return null;
    const parsed = parseJson(result.rows[0].value);
    return parsed ? normalizeAiConfig(parsed) : null;
  }

  async function getAdminAiConfig() {
    return publicConfig(await loadAiConfig());
  }

  async function saveAiConfig(input = {}) {
    if (!PROVIDERS.has(input.provider)) throw new AiProviderError('Unknown AI provider', { status: 400 });
    if (input.enabled !== false && input.provider === AI_PROVIDER_CHATGPT
        && !cleanString(input.chatgptConfig?.model)) {
      throw new AiProviderError('ChatGPT model name is required', { status: 400 });
    }
    const existing = await loadAiConfig();
    const incomingApi = input.apiKeyConfig || {};
    const incomingKey = incomingApi.apiKey;
    const storedKey = typeof incomingKey === 'string' && incomingKey && incomingKey !== MASKED_API_KEY
      ? encryptFn(incomingKey)
      : (existing?.apiKeyConfig.apiKey || null);
    const config = normalizeAiConfig({
      ...input,
      apiKeyConfig: { ...incomingApi, apiKey: storedKey },
    });

    if (config.enabled && config.provider === AI_PROVIDER_API_KEY
        && (!config.apiKeyConfig.baseUrl || !config.apiKeyConfig.model)) {
      throw new AiProviderError('API base URL and model name are required', { status: 400 });
    }
    if (config.provider === AI_PROVIDER_API_KEY && config.apiKeyConfig.baseUrl) {
      let hostname;
      try {
        hostname = new URL(config.apiKeyConfig.baseUrl).hostname;
      } catch {
        throw new AiProviderError('Invalid API base URL', { status: 400 });
      }
      const policy = await getConnectionPolicyFn();
      const hostError = await validateHostFn(hostname, { allowPrivate: policy.allowPrivateHosts });
      if (hostError) throw new AiProviderError(`API base URL: ${hostError}`, { status: 400 });
    }

    await queryFn(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('ai_config', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(config)],
    );
    return publicConfig(config);
  }

  async function deleteAiConfig() {
    await queryFn("DELETE FROM system_settings WHERE key = 'ai_config'");
  }

  async function requireSelectedConfig() {
    const config = await loadAiConfig();
    if (!config) throw new AiProviderError('AI provider not configured');
    if (!config.enabled) throw new AiProviderError('AI features are disabled');
    if (config.provider === AI_PROVIDER_API_KEY
        && (!config.apiKeyConfig.baseUrl || !config.apiKeyConfig.model)) {
      throw new AiProviderError('AI provider not fully configured');
    }
    return config;
  }

  function apiKeyCredential(config) {
    return config.apiKeyConfig.apiKey ? decryptFn(config.apiKeyConfig.apiKey) : null;
  }

  function apiKeyHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  async function completeApiKey(config, messages, { signal, maxTokens } = {}) {
    const apiKey = apiKeyCredential(config);
    const body = {
      model: config.apiKeyConfig.model,
      messages,
      ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
      stream: false,
      think: false,
    };
    const request = await openProviderRequest(fetchFn, `${config.apiKeyConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify(body),
    }, { signal });
    try {
      const { response } = request;
      const text = await readLimited(response, response.ok ? JSON_BODY_LIMIT_BYTES : ERROR_BODY_LIMIT_BYTES);
      if (!response.ok) throw providerError(response.status, text, [apiKey]);
      const parsed = parseJson(text);
      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AiProviderError('AI provider returned an invalid completion', { status: 502 });
      return content;
    } catch (error) {
      throw providerRequestError(error, request, signal);
    } finally {
      request.cleanup();
    }
  }

  async function* streamApiKey(config, messages, { signal } = {}) {
    const apiKey = apiKeyCredential(config);
    const request = await openProviderRequest(fetchFn, `${config.apiKeyConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: apiKeyHeaders(apiKey),
      body: JSON.stringify({ model: config.apiKeyConfig.model, messages, stream: true }),
    }, { signal, timeoutMs: 120_000 });
    try {
      const { response } = request;
      if (!response.ok) {
        const text = await readLimited(response, ERROR_BODY_LIMIT_BYTES);
        throw providerError(response.status, text, [apiKey]);
      }
      yield* parseChatCompletionsSse(response, { signal: request.signal, secrets: [apiKey] });
    } catch (error) {
      throw providerRequestError(error, request, signal);
    } finally {
      request.cleanup();
    }
  }

  function codexRequest(config, messages, options, credentials) {
    return {
      ...credentials,
      model: config.chatgptConfig.model,
      messages,
      signal: options.signal,
    };
  }

  async function completeText(messages, options = {}) {
    const config = await requireSelectedConfig();
    if (config.provider === AI_PROVIDER_API_KEY) return completeApiKey(config, messages, options);
    let credentials = await getCodexAccessFn();
    try {
      return await completeCodexTextFn(codexRequest(config, messages, options, credentials));
    } catch (error) {
      if (error?.status !== 401) throw error;
      credentials = await getCodexAccessFn({ forceRefresh: true });
      return completeCodexTextFn(codexRequest(config, messages, options, credentials));
    }
  }

  async function* streamChat(messages, options = {}) {
    const config = await requireSelectedConfig();
    if (config.provider === AI_PROVIDER_API_KEY) {
      yield* streamApiKey(config, messages, options);
      return;
    }

    let forceRefresh = false;
    for (;;) {
      const credentials = forceRefresh
        ? await getCodexAccessFn({ forceRefresh: true })
        : await getCodexAccessFn();
      let emitted = false;
      try {
        for await (const delta of streamCodexResponsesFn(codexRequest(config, messages, options, credentials))) {
          emitted = true;
          yield delta;
        }
        return;
      } catch (error) {
        if (forceRefresh || emitted || error?.status !== 401) throw error;
        forceRefresh = true;
      }
    }
  }

  async function getAiStatus() {
    const config = await loadAiConfig();
    if (!config || !config.enabled) {
      return {
        enabled: false,
        provider: config?.provider || AI_PROVIDER_API_KEY,
        features: config?.features || {},
        reconnectRequired: false,
      };
    }
    if (config.provider === AI_PROVIDER_API_KEY) {
      const enabled = Boolean(config.apiKeyConfig.baseUrl && config.apiKeyConfig.model);
      return { enabled, provider: config.provider, features: config.features, reconnectRequired: false };
    }
    const connection = await getCodexStatusFn();
    return {
      enabled: connection.connected === true && Boolean(config.chatgptConfig.model),
      provider: config.provider,
      features: config.features,
      reconnectRequired: connection.reconnectRequired === true,
      connection,
    };
  }

  async function testAiProvider() {
    await completeText([{ role: 'user', content: 'Reply with only the word "ok".' }], { maxTokens: 5 });
    return { ok: true };
  }

  return {
    loadAiConfig,
    getAdminAiConfig,
    saveAiConfig,
    deleteAiConfig,
    getAiStatus,
    testAiProvider,
    streamChat,
    completeText,
  };
}

const defaultProvider = createAiProvider();

export const loadAiConfig = defaultProvider.loadAiConfig;
export const getAdminAiConfig = defaultProvider.getAdminAiConfig;
export const saveAiConfig = defaultProvider.saveAiConfig;
export const deleteAiConfig = defaultProvider.deleteAiConfig;
export const getAiStatus = defaultProvider.getAiStatus;
export const testAiProvider = defaultProvider.testAiProvider;
export const streamChat = defaultProvider.streamChat;
export const completeText = defaultProvider.completeText;
