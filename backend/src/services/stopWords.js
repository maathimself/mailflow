// Stop-word lists for the antispam tokenizer (v0.2).
//
// One set per language, matching the 7 UI locales MailFlow ships
// (en, it, de, es, fr, ru, zhCN). Words here are excluded from the
// bag-of-words features because they carry no discriminative power
// for spam classification.
//
// Design reference: .hermes/design/spam-classifier-v0.2.md §6.1

const EN = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
  'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'onto', 'to',
  'with', 'without', 'about', 'after', 'before', 'between', 'during',
  'until', 'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'having', 'do', 'does', 'did', 'doing', 'will', 'would', 'shall',
  'should', 'can', 'could', 'may', 'might', 'must', 'i', 'me', 'my', 'mine',
  'we', 'us', 'our', 'ours', 'you', 'your', 'yours', 'he', 'him', 'his',
  'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their', 'theirs',
  'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'not', 'no', 'nor', 'so', 'too', 'very', 'just', 'only', 'also', 'here',
  'there', 'please', 'thanks', 'thank', 're', 'fw', 'fwd', 'subject', 'sent',
]);

const IT = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'un\'',
  'di', 'del', 'della', 'dei', 'delle', 'dello', 'a', 'al', 'alla', 'ai',
  'alle', 'allo', 'da', 'dal', 'dalla', 'dai', 'dalle', 'dallo', 'in', 'nel',
  'nella', 'nei', 'nelle', 'nello', 'con', 'su', 'sul', 'sulla', 'sui',
  'per', 'tra', 'fra', 'e', 'ed', 'o', 'od', 'ma', 'se', 'che', 'cui',
  'come', 'quando', 'dove', 'chi', 'quale', 'quali', 'questo', 'questa',
  'questi', 'queste', 'quello', 'quella', 'quelli', 'quelle', 'io', 'tu',
  'lui', 'lei', 'noi', 'voi', 'loro', 'mio', 'mia', 'miei', 'mie', 'tuo',
  'tua', 'tuoi', 'tue', 'suo', 'sua', 'suoi', 'sue', 'nostro', 'nostra',
  'vostro', 'vostra', 'essere', 'avere', 'sono', 'sei', 'è', 'siamo', 'siete',
  'ho', 'hai', 'ha', 'abbiamo', 'avete', 'hanno', 'non', 'più', 'meno',
  'molto', 'troppo', 'anche', 'solo', 'qui', 'lì', 'grazie', 'oggetto', 'risposta',
]);

const DE = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem',
  'eines', 'einer', 'und', 'oder', 'aber', 'wenn', 'dann', 'als', 'wie',
  'bei', 'mit', 'von', 'zu', 'auf', 'über', 'unter', 'für', 'gegen', 'um',
  'an', 'aus', 'nach', 'vor', 'bis', 'durch', 'ich', 'du', 'er', 'sie', 'es',
  'wir', 'ihr', 'mich', 'dich', 'ihn', 'uns', 'euch', 'mein', 'dein', 'sein',
  'ihr', 'unser', 'euer', 'ist', 'sind', 'war', 'waren', 'bin', 'bist', 'hat',
  'haben', 'hatte', 'hatten', 'wird', 'werden', 'wurde', 'würde', 'kann',
  'können', 'könnte', 'muss', 'müssen', 'soll', 'sollen', 'will', 'wollen',
  'nicht', 'kein', 'keine', 'nur', 'auch', 'noch', 'schon', 'sehr', 'hier',
  'dort', 'bitte', 'danke', 'betreff', 'antwort',
]);

const ES = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al',
  'a', 'en', 'con', 'sin', 'por', 'para', 'sobre', 'entre', 'hasta', 'desde',
  'y', 'e', 'o', 'u', 'ni', 'pero', 'si', 'como', 'cuando', 'donde', 'que',
  'cual', 'cuales', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos',
  'esas', 'aquel', 'aquella', 'yo', 'tu', 'el', 'ella', 'nosotros', 'vosotros',
  'ellos', 'ellas', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'nuestro', 'nuestra',
  'vuestro', 'vuestra', 'es', 'son', 'era', 'eran', 'soy', 'eres', 'está',
  'están', 'estaba', 'he', 'has', 'ha', 'hemos', 'han', 'había', 'será', 'serán',
  'puede', 'pueden', 'puedo', 'no', 'nunca', 'solo', 'también', 'muy', 'aquí',
  'allí', 'gracias', 'asunto', 'respuesta',
]);

const FR = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd\'', 'l\'', 'au', 'aux',
  'et', 'ou', 'mais', 'si', 'comme', 'quand', 'où', 'que', 'qui', 'quoi',
  'dont', 'ce', 'cet', 'cette', 'ces', 'celui', 'celle', 'ceux', 'celles',
  'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'mon', 'ma',
  'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'notre', 'nos', 'votre',
  'vos', 'leur', 'leurs', 'est', 'sont', 'était', 'étaient', 'suis', 'es',
  'a', 'avait', 'ont', 'sera', 'seront', 'peut', 'peuvent', 'pour', 'avec',
  'sans', 'dans', 'sur', 'sous', 'entre', 'vers', 'depuis', 'pendant', 'avant',
  'après', 'ne', 'pas', 'plus', 'moins', 'très', 'aussi', 'ici', 'là', 'merci',
  'objet', 'réponse',
]);

const RU = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то',
  'все', 'она', 'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за',
  'бы', 'по', 'только', 'ее', 'мне', 'было', 'вот', 'от', 'меня', 'еще',
  'нет', 'о', 'из', 'ему', 'теперь', 'когда', 'даже', 'ну', 'вдруг', 'ли',
  'если', 'уже', 'или', 'ни', 'быть', 'был', 'него', 'до', 'вас', 'нибудь',
  'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей',
  'может', 'они', 'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя',
  'их', 'чем', 'была', 'сам', 'чтоб', 'без', 'будто', 'чего', 'раз', 'тоже',
  'себе', 'под', 'будет', 'ж', 'тогда', 'кто', 'этот', 'того', 'потому',
  'этого', 'какой', 'совсем', 'ним', 'здесь', 'этом', 'один', 'почти', 'мой',
  'тем', 'чтобы', 'нее', 'сейчас', 'были', 'куда', 'зачем', 'всех', 'никогда',
  'можно', 'при', 'наконец', 'два', 'об', 'другой', 'хоть', 'после', 'над',
  'больше', 'тот', 'через', 'эти', 'нас', 'про', 'всего', 'них', 'какая',
  'много', 'разве', 'три', 'эту', 'моя', 'впрочем', 'хорошо', 'свою', 'этой',
  'перед', 'иногда', 'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им', 'более',
  'всегда', 'конечно', 'всю', 'между', 'спасибо', 'тема',
]);

// Chinese has no whitespace-delimited words; the tokenizer segments on
// individual CJK characters, so the stop set is small and only contains
// common function words / particles that carry no spam signal.
const ZHCN = new Set([
  '的', '了', '和', '是', '在', '我', '有', '这', '就', '不', '也', '他',
  '你', '我们', '你们', '他们', '它', '一个', '这个', '那个', '为', '之',
  '与', '及', '或', '但', '而', '被', '把', '对', '从', '到', '去', '来',
  '会', '能', '要', '想', '说', '看', '听', '写', '请', '谢谢', '主题',
  '回复', '邮件', '内容', '您好', '你好', '大家', '什么', '怎么', '为什么',
]);

export const STOP_WORDS = { en: EN, it: IT, de: DE, es: ES, fr: FR, ru: RU, zhCN: ZHCN };

// Default stop-word set for messages whose language cannot be detected.
// English is the safest fallback: it is the most common spam language and
// the set is the most conservative (fewest false positives).
export const STOP_WORDS_DEFAULT = EN;
