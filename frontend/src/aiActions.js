// AI actions (#202). An action is { id, label, prompt }; the prompt is prepended
// to the message text when sent to the /api/ai/chat proxy. User-defined actions
// live in the synced store (users.preferences.aiActions); the built-in Summarize
// action is fixed here so its persisted results have a stable key.

export const SUMMARIZE_PROMPT =
  'Summarize this email concisely in 2-4 sentences. Focus on the key points and any action items.';

// Fixed key so persisted summaries survive across sessions/devices.
export const BUILTIN_SUMMARIZE = { id: 'summarize', prompt: SUMMARIZE_PROMPT, builtin: true };

// The built-in Summarize prompt is uneditable, so (unlike custom actions, whose
// authors can specify a language) it needs to follow the user's UI language
// instead of defaulting to English (#255). Keyed by the i18n locale codes MailFlow
// ships; English and any unknown locale keep the base prompt unchanged.
const SUMMARIZE_LANGUAGE_NAMES = {
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pl: 'Polish', ru: 'Russian', zhCN: 'Simplified Chinese', cs: 'Czech',
  ptBR: 'Brazilian Portuguese',
};

export function summarizePromptForLocale(locale) {
  const name = SUMMARIZE_LANGUAGE_NAMES[locale];
  return name ? `${SUMMARIZE_PROMPT} Respond in ${name}.` : SUMMARIZE_PROMPT;
}

// Seeded once on first run (store.loadPreferences). Stable ids so that once a
// user edits or deletes one, the change sticks and we never re-seed over it.
export const DEFAULT_AI_ACTIONS = [
  {
    id: 'seed-translate-en',
    label: 'Translate to English',
    prompt: 'Translate this email into clear, natural English, preserving meaning and tone. Output only the translation.',
  },
  {
    id: 'seed-action-items',
    label: 'Action items',
    prompt: 'List the concrete action items and any deadlines from this email as a short bulleted list. If there are none, say so.',
  },
  {
    id: 'seed-reformat',
    label: 'Reformat & summarize',
    prompt: 'Reformat this email into a clean, well-structured summary using short headings and bullet points where helpful.',
  },
];

// Field limits — kept in sync with the backend validation in auth.js PATCH /preferences.
export const AI_ACTION_LIMITS = { max: 30, label: 60, prompt: 2000 };

export function newAiAction(label = '', prompt = '') {
  const id = globalThis.crypto?.randomUUID?.()
    || `a-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return { id, label, prompt };
}
