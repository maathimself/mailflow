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
  ko: 'Korean',
};

export function summarizePromptForLocale(locale) {
  const name = SUMMARIZE_LANGUAGE_NAMES[locale];
  return name ? `${SUMMARIZE_PROMPT} Respond in ${name}.` : SUMMARIZE_PROMPT;
}

// Kept in sync with validateMessages in backend/src/routes/ai.js, which rejects a message
// whose content is longer than this. Both sides measure JavaScript string length.
export const AI_MESSAGE_MAX_CHARS = 32_000;

// Where to cut text that must end at or before `end`: the last paragraph break, line or
// sentence end, or space in the final tenth, else exactly at `end`.
function cutPoint(text, end) {
  const floor = Math.floor(end * 0.9);
  const para = text.lastIndexOf('\n\n', end - 2);
  if (para >= floor) return para;
  for (let i = end - 1; i >= floor; i--) {
    if ('.!?\n\u3002\uff01\uff1f'.includes(text[i])) return i + 1;
  }
  const space = text.lastIndexOf(' ', end - 1);
  return space >= floor ? space : end;
}

// The user message for an AI action: the prompt, a blank line, then the email text (#633).
// The text gets all the room the prompt leaves under AI_MESSAGE_MAX_CHARS. A longer email is
// cut near the limit at a natural boundary and the model is told it is reading only the
// beginning, so it does not present a partial summary or translation as complete.
// Returns { content, truncated }, truncated being null or { shown, total } in characters.
export function buildAiActionContent(prompt, text, max = AI_MESSAGE_MAX_CHARS) {
  const head = `${prompt}\n\n`;
  const total = text.length;
  if (head.length + total <= max) return { content: head + text, truncated: null };
  const note = (shown) => `\n\n[Only the first ${shown} of ${total} characters of this email are included above. The rest was left out to fit the AI request size limit.]`;
  // note(total) is the longest the note can be, since shown <= total.
  let end = Math.max(0, max - head.length - note(total).length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // don't split a surrogate pair
  const shown = text.slice(0, cutPoint(text, end)).trimEnd();
  return { content: head + shown + note(shown.length), truncated: { shown: shown.length, total } };
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
