// Rules engine for the antispam classifier (v0.2) — Layer 1, always-on.
//
// 14 hand-crafted heuristic rules, evaluated as pure functions. The engine
// provides a deterministic baseline that works even with zero ML training
// records. Weights and logic are the authoritative values from
// .hermes/design/spam-rules-detailed.md (maintainer-reviewed); auth-header
// parsing follows RFC 7601 via spamParser.js (NOT RFC 8054, which is NNTP).
//
// scoreRules() returns a single number in [0, 1] (raw weighted sum clamped).
// explainRules() returns per-rule detail for the "Why?" modal.

import { parseAuthResults } from './spamParser.js';
import { EXECUTABLE_EXTENSIONS } from './spamTokenizer.js';

// ---------------------------------------------------------------------------
// Rule 3 — pharmaceutical spam keywords (highest-confidence rule, ~zero FP)
// ---------------------------------------------------------------------------
const PHARMA_KEYWORDS = [
  // English
  'viagra', 'cialis', 'kamagra', 'levitra', 'pharmacy', 'pharmacies',
  'prescription', 'xanax', 'valium', 'oxycontin', 'oxycodone', 'percocet',
  'sildenafil', 'tadalafil', 'finasteride', 'weight loss', 'diet pill',
  // Italian
  'farmacia', 'ricetta medica', 'dimagrire', 'pillola dimagrante',
  // German
  'apotheke', 'rezeptpflichtig', 'abnehmen',
  // Spanish
  'farmacia', 'receta medica', 'adelgazar',
  // French
  'pharmacie', 'ordonnance', 'mincir',
  // Russian (transliterated + Cyrillic)
  'виагра', 'сиалис', 'аптека', 'рецепт',
  // Chinese (simplified)
  '伟哥', '希爱力', '药店', '处方药', '减肥药',
];

// ---------------------------------------------------------------------------
// Rule 4 — lottery / money / advance-fee scam keywords
// ---------------------------------------------------------------------------
const MONEY_KEYWORDS = [
  // English
  'lottery', 'winner', 'you won', 'you have won', 'prize', 'jackpot',
  'claim your', 'claim now', 'million dollars', 'million euros', 'free money',
  'cash prize', 'inheritance', 'beneficiary', 'wire transfer', 'nigerian prince',
  // Currency symbols (3+ in a row)
  '$$$', '€€€', '£££',
  // Italian
  'lotteria', 'vincitore', 'hai vinto', 'premio', 'jackpot',
  'denaro gratis', 'eredità', 'beneficiario', 'bonifico',
  // German
  'lotterie', 'gewinn', 'sie haben gewonnen', 'preis', 'preisgeld',
  'kostenloses geld', 'erbschaft',
  // Spanish
  'lotería', 'ganador', 'has ganado', 'premio', 'dinero gratis',
  'herencia', 'transferencia',
  // French
  'loterie', 'gagnant', 'vous avez gagné', 'prix', 'argent gratuit',
  'héritage', 'virement',
  // Russian
  'лотерея', 'победитель', 'вы выиграли', 'приз', 'бесплатные деньги',
  'наследство', 'денежный перевод',
  // Chinese
  '彩票', '中奖', '您已中奖', '奖金', '免费赠品', '遗产', '汇款',
];

// ---------------------------------------------------------------------------
// Rule 5 — body call-to-action spam phrases (>= 2 unique matches required)
// ---------------------------------------------------------------------------
const BODY_SPAM_PHRASES = [
  // English
  'click here', 'click the link', 'click below',
  'buy now', 'order now', 'shop now',
  'limited time', 'limited offer', 'act now', 'act fast',
  'risk free', 'risk-free', 'no risk', '100% free', 'absolutely free',
  'guaranteed', 'satisfaction guaranteed',
  'no obligation', 'no purchase necessary',
  'congratulations', 'you have been selected',
  'this is not spam', 'this is not a scam',
  'unsubscribe below', 'remove me from this list',
  'make money', 'earn money', 'extra cash', 'work from home',
  'lose weight', 'miracle', 'cure',
  // Italian
  'clicca qui', 'clicca sotto', 'acquista ora', 'ordina ora',
  'offerta limitata', 'offerta a tempo', 'agisci ora', 'agisci subito',
  'senza rischi', 'senza impegno', 'senza obbligo',
  'complimenti', 'sei stato selezionato',
  'guadagnare', 'lavorare da casa', 'dimagrire',
  // German
  'hier klicken', 'jetzt kaufen', 'limitierte zeit', 'jetzt handeln',
  'risikofrei', 'ohne verpflichtung',
  'herzlichen glückwunsch', 'sie wurden ausgewählt',
  'geld verdienen', 'von zuhause arbeiten', 'abnehmen',
  // Spanish
  'haga clic aquí', 'compre ahora', 'oferta limitada', 'actúe ahora',
  'sin compromiso', 'sin riesgo',
  'felicidades', 'ha sido seleccionado',
  'ganar dinero', 'trabajar desde casa', 'adelgazar',
  // French
  'cliquez ici', 'achetez maintenant', 'offre limitée', 'agissez maintenant',
  'sans engagement', 'sans risque',
  'félicitations', 'vous avez été sélectionné',
  "gagner de l'argent", 'travailler depuis chez soi', 'mincir',
  // Russian
  'нажмите здесь', 'купить сейчас', 'ограниченное время', 'действуйте сейчас',
  'без обязательств', 'без риска',
  'поздравляем', 'вы были выбраны',
  'заработать деньги', 'работать из дома', 'похудеть',
  // Chinese
  '点击这里', '立即购买', '限时优惠', '立即行动',
  '无风险', '无义务',
  '恭喜', '您已被选中',
  '赚钱', '在家工作', '减肥',
];

// ---------------------------------------------------------------------------
// Rule 6 — URL shortener hosts
// ---------------------------------------------------------------------------
const URL_SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 'ow.ly', 't.co', 'goo.gl',
  'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at',
  'rb.gy', 'trib.al', 'short.io', 'lnkd.in', 'fb.me',
  'youtu.be', 'tiny.cc', 'bl.ink', 'soo.gd', 's.id', 'v.gd',
]);

// ---------------------------------------------------------------------------
// Rule 8/9 — attachment extensions
// ---------------------------------------------------------------------------
const PRESENTATION_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'rtf', 'odt', 'ods', 'odp', 'jpg', 'jpeg', 'png', 'gif',
  'mp3', 'mp4', 'mov', 'avi', 'wav',
]);

// Rule 10-12 — negative auth result sets (per rules-detail doc)
const DKIM_NEGATIVE_RESULTS = new Set(['fail', 'hardfail', 'permerror', 'softfail', 'absent', null]);
const SPF_NEGATIVE_RESULTS = new Set(['fail', 'softfail', 'permerror', 'temperror', 'absent', null]);
const DMARC_NEGATIVE_RESULTS = new Set(['fail', 'permerror', 'temperror', 'absent', null]);

// Mailing-list headers checked by rule 13 (see hasMailingListHeaders).

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSubject(subject) {
  return String(subject || '').toLowerCase().normalize('NFC');
}

function normalizeBody(body) {
  return String(body || '').toLowerCase().normalize('NFC');
}

function hasWordBoundaryKeyword(text, keyword) {
  // Escapes regex metacharacters in the keyword, then applies word boundaries
  // on the first and last characters (diacritics are word chars in \w under
  // Unicode-unaware mode only; we use explicit boundary checks with \p{L}).
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u').test(text);
}

function extractDomain(address) {
  if (!address) return null;
  const text = String(address);
  const angle = /<([^<>]+)>/.exec(text);
  const addr = (angle ? angle[1] : text).trim();
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  return addr.slice(at + 1).toLowerCase() || null;
}

// Registrable-domain comparison WITHOUT a PSL dependency (same pragmatic
// approach as senderFavicon.js): take the last two labels, except for a
// small set of multi-label public suffixes (co.uk, com.au, ...) where we
// take three. mail.brand.com ≡ brand.com, brand.co.uk ≡ brand.co.uk.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'co.nz', 'com.br', 'com.mx', 'com.ar', 'co.in', 'com.sg',
  'com.hk', 'co.za', 'com.tr', 'com.pl', 'co.kr',
]);

function registrableDomain(domain) {
  if (!domain) return null;
  const labels = domain.split('.');
  if (labels.length <= 2) return domain;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

function attachmentExtension(filename) {
  const base = String(filename || '').trim();
  const lastDot = base.lastIndexOf('.');
  if (lastDot > 0 && lastDot < base.length - 1) {
    return base.slice(lastDot + 1).toLowerCase();
  }
  return null;
}

function listOfHeaders(headers) {
  if (!headers) return {};
  const map = {};
  if (Array.isArray(headers)) {
    for (const line of headers) {
      const m = /^([^:]+):\s*(.*)$/.exec(String(line));
      if (m) map[m[1].toLowerCase()] = (map[m[1].toLowerCase()] || '') + ' ' + m[2];
    }
    return map;
  }
  // Object map: lowercase keys.
  for (const [key, value] of Object.entries(headers)) {
    map[String(key).toLowerCase()] = Array.isArray(value) ? value.join(' ') : String(value);
  }
  return map;
}

// True when at least one Authentication-Results header exists. When it is
// entirely absent (a server that does not evaluate auth), the AUTH_*_FAIL
// rules stay neutral instead of firing on every message (a client-side
// mailbox would otherwise score +1.2 on everything and clamp to 1.0).
function hasAuthHeader(headers) {
  const map = listOfHeaders(headers);
  return Boolean((map['authentication-results'] || '').trim());
}

function hasMailingListHeaders(headers) {
  const map = listOfHeaders(headers);
  const listId = (map['list-id'] || '').trim();
  const listUnsub = (map['list-unsubscribe'] || '').trim();
  if (!/^<[^<>]+>$/.test(listId)) return false;
  // RFC 8058 form: <mailto:...>, <https://...> — strip angle brackets and
  // accept either scheme in any comma-separated option.
  const unsubOptions = listUnsub.replace(/[<>]/g, '').split(',');
  if (!unsubOptions.some(opt => /^(mailto:|https?:\/\/)/.test(opt.trim()))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The 14 rules. Signature: (email, ctx) => boolean
// ctx = { authResults, userContacts, headers }
// ---------------------------------------------------------------------------

const RULES = [
  {
    name: 'SUBJECT_ALL_CAPS',
    weight: 0.3,
    test: (email) => {
      const subject = String(email.subject || '');
      const letters = (subject.match(/\p{L}/gu) || []).length;
      if (letters === 0) return false;
      const upper = (subject.match(/\p{Lu}/gu) || []).length;
      return upper / letters > 0.5;
    },
  },
  {
    name: 'SUBJECT_MANY_EXCLAMATIONS',
    weight: 0.2,
    test: (email) => {
      const subject = String(email.subject || '');
      const exclaims = (subject.match(/!/g) || []).length;
      return exclaims > 3 || /!{3,}/.test(subject);
    },
  },
  {
    name: 'SUBJECT_PHARMA_KEYWORDS',
    weight: 0.5,
    test: (email) => {
      const subject = normalizeSubject(email.subject);
      return PHARMA_KEYWORDS.some(kw => hasWordBoundaryKeyword(subject, kw));
    },
  },
  {
    name: 'SUBJECT_MONEY_KEYWORDS',
    weight: 0.4,
    test: (email) => {
      const subject = normalizeSubject(email.subject);
      return MONEY_KEYWORDS.some(kw => hasWordBoundaryKeyword(subject, kw));
    },
  },
  {
    name: 'BODY_SPAM_KEYWORDS',
    weight: 0.4,
    test: (email) => {
      const body = normalizeBody(email.body);
      if (!body) return false;
      const matched = BODY_SPAM_PHRASES.filter(phrase => body.includes(phrase));
      return new Set(matched).size >= 2;
    },
  },
  {
    name: 'BODY_URL_SHORTENER',
    weight: 0.3,
    test: (email) => {
      const body = String(email.body || '');
      const urls = body.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
      for (const url of urls) {
        try {
          const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
          if (URL_SHORTENERS.has(host)) return true;
        } catch { /* malformed URL, ignore */ }
      }
      return false;
    },
  },
  {
    name: 'FROM_REPLYTO_MISMATCH',
    weight: 0.4,
    test: (email) => {
      if (!email.replyTo) return false; // absent Reply-To: not a mismatch
      const from = registrableDomain(extractDomain(email.from));
      const replyTo = registrableDomain(extractDomain(email.replyTo));
      return Boolean(from && replyTo && from !== replyTo);
    },
  },
  {
    name: 'ATTACHMENT_EXECUTABLE',
    weight: 0.6,
    test: (email) => {
      const attachments = Array.isArray(email.attachments) ? email.attachments : [];
      return attachments.some(a => {
        const ext = attachmentExtension(a.filename || a.name);
        return ext !== null && EXECUTABLE_EXTENSIONS.has(ext);
      });
    },
  },
  {
    name: 'ATTACHMENT_DOUBLE_EXT',
    weight: 0.3,
    test: (email) => {
      const attachments = Array.isArray(email.attachments) ? email.attachments : [];
      return attachments.some(a => {
        const base = String(a.filename || a.name || '').trim();
        const parts = base.split('.');
        if (parts.length < 3) return false; // need name + 2 extensions
        const last = parts[parts.length - 1].toLowerCase();
        const penultimate = parts[parts.length - 2].toLowerCase();
        return EXECUTABLE_EXTENSIONS.has(last) && PRESENTATION_EXTENSIONS.has(penultimate);
      });
    },
  },
  {
    name: 'AUTH_DKIM_FAIL',
    weight: 0.4,
    test: (_email, ctx) =>
      ctx.authHeaderPresent && DKIM_NEGATIVE_RESULTS.has(ctx.authResults.dkim ?? null),
  },
  {
    name: 'AUTH_SPF_FAIL',
    weight: 0.4,
    test: (_email, ctx) =>
      ctx.authHeaderPresent && SPF_NEGATIVE_RESULTS.has(ctx.authResults.spf ?? null),
  },
  {
    name: 'AUTH_DMARC_FAIL',
    weight: 0.4,
    test: (_email, ctx) =>
      ctx.authHeaderPresent && DMARC_NEGATIVE_RESULTS.has(ctx.authResults.dmarc ?? null),
  },
  {
    name: 'MAILING_LIST_HEADERS',
    weight: -0.2,
    test: (_email, ctx) => hasMailingListHeaders(ctx.headers),
  },
  {
    name: 'FROM_IN_USER_CONTACTS',
    weight: -0.5,
    test: (email, ctx) => {
      if (!ctx.userContacts || ctx.userContacts.size === 0) return false;
      const from = extractDomain(email.from);
      if (!from) return false;
      const normalized = normalizeContactAddress(email.from);
      return ctx.userContacts.has(normalized);
    },
  },
];

// Gmail-local-part normalization (rule 14): lowercase, strip +tag, strip
// dots on gmail/googlemail (john.doe@gmail.com ≡ johndoe@gmail.com).
export function normalizeContactAddress(address) {
  if (!address) return null;
  const text = String(address);
  const angle = /<([^<>]+)>/.exec(text);
  const raw = (angle ? angle[1] : text).trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at < 0) return raw;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  let stripped = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    stripped = stripped.replace(/\./g, '');
  }
  return `${stripped}@${domain}`;
}

// Attachment rules deduplicate: if both ATTACHMENT_EXECUTABLE and
// ATTACHMENT_DOUBLE_EXT fire, keep only the max weight (0.6), not the
// sum (0.9) — same threat counted once.
const ATTACHMENT_RULES = new Set(['ATTACHMENT_EXECUTABLE', 'ATTACHMENT_DOUBLE_EXT']);

/**
 * Score an email with the 14-rule engine.
 *
 * @param {Object} email
 *   { subject, body, from?, replyTo?, attachments?, headers? }
 * @param {Object} [ctx]
 *   { userContacts?: Set<string> } — normalized addresses, built once per
 *   classification call by the caller (contactsService).
 * @returns {{ score: number, fired: Array<{name, weight}> }}
 *   score in [0, 1]; fired rules in evaluation order.
 */
export function scoreRules(email, ctx = {}) {
  const fullCtx = {
    authResults: parseAuthResults(email.headers || []),
    authHeaderPresent: hasAuthHeader(email.headers || []),
    userContacts: ctx.userContacts || new Set(),
    headers: email.headers || [],
  };

  const fired = RULES.filter(rule => rule.test(email, fullCtx));

  // Dedup attachment signals in the SCORE only: if both ATTACHMENT_EXECUTABLE
  // and ATTACHMENT_DOUBLE_EXT fire (e.g. invoice.pdf.exe), count the max
  // (0.6) once instead of the sum (0.9) — same threat counted twice. The
  // fired list keeps both original rule names for explainability.
  const attachmentFired = fired.filter(r => ATTACHMENT_RULES.has(r.name));
  let rawScore = fired.reduce((sum, r) => sum + r.weight, 0);
  if (attachmentFired.length > 1) {
    const maxWeight = Math.max(...attachmentFired.map(r => r.weight));
    rawScore = rawScore - attachmentFired.reduce((s, r) => s + r.weight, 0) + maxWeight;
  }

  const score = Math.max(0, Math.min(1, rawScore));
  return { score, fired };
}

/**
 * Per-rule explanation for the "Why?" modal. Same evaluation as
 * scoreRules() but returns every rule's fire status.
 *
 * @returns {Array<{name: string, weight: number, fired: boolean}>}
 */
export function explainRules(email, ctx = {}) {
  const fullCtx = {
    authResults: parseAuthResults(email.headers || []),
    authHeaderPresent: hasAuthHeader(email.headers || []),
    userContacts: ctx.userContacts || new Set(),
    headers: email.headers || [],
  };
  return RULES.map(rule => ({
    name: rule.name,
    weight: rule.weight,
    fired: rule.test(email, fullCtx),
  }));
}

export { RULES };
