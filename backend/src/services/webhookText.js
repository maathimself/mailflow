// Only the notification presets are translated; generic JSON stays a stable API.
const locales = {
  en: { count: { one: '{n} new message', other: '{n} new messages' }, received: 'New mail received', from: 'From' },
  zhCN: { count: { other: '{n} 封新邮件' }, received: '收到新邮件', from: '发件人' },
  de: { count: { one: '{n} neue Nachricht', other: '{n} neue Nachrichten' }, received: 'Neue E-Mail erhalten', from: 'Von' },
  fr: { count: { one: '{n} nouveau message', other: '{n} nouveaux messages' }, received: 'Nouveau message reçu', from: 'De' },
  es: { count: { one: '{n} mensaje nuevo', other: '{n} mensajes nuevos' }, received: 'Nuevo correo recibido', from: 'De' },
  it: { count: { one: '{n} nuovo messaggio', other: '{n} nuovi messaggi' }, received: 'Nuova email ricevuta', from: 'Da' },
  ru: { count: { one: '{n} новое письмо', few: '{n} новых письма', many: '{n} новых писем', other: '{n} нового письма' }, received: 'Получено новое письмо', from: 'От' },
  pl: { count: { one: '{n} nowa wiadomość', few: '{n} nowe wiadomości', many: '{n} nowych wiadomości', other: '{n} nowej wiadomości' }, received: 'Otrzymano nową wiadomość', from: 'Od' },
  cs: { count: { one: '{n} nová zpráva', few: '{n} nové zprávy', other: '{n} nových zpráv' }, received: 'Přijata nová zpráva', from: 'Od' },
  ptBR: { count: { one: '{n} nova mensagem', other: '{n} novas mensagens' }, received: 'Novo e-mail recebido', from: 'De' },
  ko: { count: { other: '새 메일 {n}개' }, received: '새 메일을 받았습니다', from: '보낸 사람' },
};
const pluralRules = new Map();

export function webhookText(language, { account, count, sender, subject }) {
  const code = typeof language === 'string' && Object.hasOwn(locales, language) ? language : 'en';
  const text = locales[code];
  if (!pluralRules.has(code)) pluralRules.set(code, new Intl.PluralRules({ zhCN: 'zh-CN', ptBR: 'pt-BR' }[code] || code));
  const form = pluralRules.get(code).select(count);
  const summary = (text.count[form] || text.count.other).replace('{n}', String(count));
  return {
    title: `${account} · ${summary}`.replace(/[\r\n]+/g, ' '),
    message: [subject || text.received, sender ? `${text.from}: ${sender}` : null].filter(Boolean).join('\n'),
  };
}
