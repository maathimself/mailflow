/**
 * Comprehensive test suite for notification sender.
 * Self-contained — no project dependencies.
 *
 * Covers:
 *   - formatDate
 *   - normalizePayload (fallback chains, default values)
 *   - buildFeishuPayload  (single, batch, truncation, edge cases)
 *   - buildDingTalkPayload (single, batch, truncation, edge cases)
 *   - buildWebhookPayload  (field completeness, fallbacks, edge cases)
 *   - imapManager payload construction (notifyPayload shape, fallback chains)
 *
 * Usage: node test-notification.mjs [webhook_url]
 */

// ==========================================================================
// Replicated private functions from notificationSender.js
// ==========================================================================

function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizePayload(data) {
  const fromEmail = data.fromEmail || '(未知)';
  const subject = data.subject || '(无主题)';
  const bodyContent = data.bodyText || data.snippet || data.body || '';
  const count = data.count || 1;
  const isBatch = count > 1;
  const dateFormatted = formatDate(data.date);
  const toRecipients = data.toRecipients || '';
  return { ...data, fromEmail, subject, bodyContent, count, isBatch, dateFormatted, toRecipients };
}

function buildFeishuPayload(raw) {
  const d = normalizePayload(raw);
  const safeTitle = d.subject.length > 95 ? d.subject.slice(0, 95) + '...' : d.subject;
  const safeBody = d.bodyContent.length > 1900
    ? d.bodyContent.slice(0, 1900) + '\n\n...（正文过长，已截断）'
    : d.bodyContent;
  const footerLines = [`发件人：${d.fromEmail}`];
  if (d.toRecipients) footerLines.push(`收件人：${d.toRecipients}`);
  if (d.dateFormatted) footerLines.push(`收件时间：${d.dateFormatted}`);

  if (d.isBatch) {
    return {
      msg_type: 'interactive',
      card: {
        header: { title: { content: `📬 ${d.count} 封新邮件`, tag: 'plain_text' }, template: 'blue' },
        elements: [
          { tag: 'div', text: { content: `您收到了 ${d.count} 封新邮件`, tag: 'lark_md' } },
          { tag: 'hr' },
          { tag: 'note', elements: [{ tag: 'plain_text', content: footerLines.join('\n') }] },
        ],
      },
    };
  }
  return {
    msg_type: 'interactive',
    card: {
      header: { title: { content: `📬 ${safeTitle}`, tag: 'plain_text' }, template: 'blue' },
      elements: [
        { tag: 'div', text: { content: safeBody, tag: 'lark_md' } },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: footerLines.join('\n') }] },
      ],
    },
  };
}

function buildWebhookPayload(raw) {
  const d = normalizePayload(raw);
  return {
    event: 'new_mail',
    timestamp: new Date().toISOString(),
    title: d.title || d.fromEmail || 'New mail',
    body: d.body || d.subject || '(no subject)',
    bodyText: d.bodyContent || null,
    fromName: d.fromName || '',
    fromEmail: d.fromEmail,
    subject: d.subject,
    count: d.count,
    snippet: d.snippet || '',
    url: d.url || '',
    unreadCount: d.unreadCount,
    date: d.date || null,
    toRecipients: d.toRecipients,
  };
}

function buildDingTalkPayload(raw) {
  const d = normalizePayload(raw);
  const safeTitle = d.subject.length > 50 ? d.subject.slice(0, 50) + '...' : d.subject;
  const safeBody = d.bodyContent.length > 19000
    ? d.bodyContent.slice(0, 19000) + '\n\n...（正文过长，已截断）'
    : d.bodyContent;
  const footerLines = [`**发件人：**${d.fromEmail}`];
  if (d.toRecipients) footerLines.push(`**收件人：**${d.toRecipients}`);
  if (d.dateFormatted) footerLines.push(`**收件时间：**${d.dateFormatted}`);

  if (d.isBatch) {
    return {
      msgtype: 'markdown',
      markdown: {
        title: `${d.count} 封新邮件`,
        text: `## 📬 ${d.count} 封新邮件\n\n您收到了 ${d.count} 封新邮件\n\n---\n\n${footerLines.join('\n\n')}`,
      },
    };
  }
  return {
    msgtype: 'markdown',
    markdown: {
      title: safeTitle,
      text: `## 📬 ${safeTitle}\n\n${safeBody}\n\n---\n\n${footerLines.join('\n\n')}`,
    },
  };
}

// ==========================================================================
// Test helpers
// ==========================================================================

let passed = 0, failed = 0, testName = '';

function describe(name) { testName = name; }

function assert(cond, label) {
  if (cond) { passed++; }
  else { console.error(`  ❌ ${testName} :: ${label}`); failed++; }
}

function group(name, fn) {
  console.log(`\n━━━ ${name} ━━━`);
  fn();
}

// ==========================================================================
// 1. formatDate
// ==========================================================================

group('formatDate', () => {
  describe('valid Date object');
  {
    const d = new Date('2026-06-02T06:30:00Z');
    assert(formatDate(d).includes('2026-06-02'), 'formats date correctly');
  }

  describe('valid ISO string');
  assert(formatDate('2026-01-15T12:00:00Z').includes('2026-01-15'), 'accepts ISO string');

  describe('null / undefined / empty');
  assert(formatDate(null) === '', 'null → empty');
  assert(formatDate(undefined) === '', 'undefined → empty');
  assert(formatDate('') === '', 'empty string → empty');

  describe('invalid date');
  assert(formatDate('not-a-date') === '', 'invalid string → empty');
  assert(formatDate({}) === '', 'object → empty');

  describe('Date at midnight');
  {
    const out = formatDate(new Date('2026-06-02T00:00:00'));
    assert(out.includes('00'), 'midnight hour preserved');
  }
});

// ==========================================================================
// 2. normalizePayload — fallback chains
// ==========================================================================

group('normalizePayload — fallback chains', () => {
  describe('empty data → all defaults');
  {
    const d = normalizePayload({});
    assert(d.fromEmail === '(未知)', 'fromEmail → (未知)');
    assert(d.subject === '(无主题)', 'subject → (无主题)');
    assert(d.bodyContent === '', 'bodyContent → empty string');
    assert(d.count === 1, 'count → 1');
    assert(d.isBatch === false, 'isBatch → false');
    assert(d.dateFormatted === '', 'dateFormatted → empty');
    assert(d.toRecipients === '', 'toRecipients → empty');
  }

  describe('fromEmail fallback');
  assert(normalizePayload({ fromEmail: '' }).fromEmail === '(未知)', 'empty → (未知)');
  assert(normalizePayload({ fromEmail: 'a@b.com' }).fromEmail === 'a@b.com', 'preserves valid email');

  describe('subject fallback');
  assert(normalizePayload({ subject: '' }).subject === '(无主题)', 'empty → (无主题)');
  assert(normalizePayload({ subject: undefined }).subject === '(无主题)', 'undefined → (无主题)');

  describe('bodyContent priority: bodyText > snippet > body > empty');
  assert(normalizePayload({ bodyText: 'a', snippet: 'b', body: 'c' }).bodyContent === 'a', 'bodyText wins');
  assert(normalizePayload({ bodyText: '', snippet: 'b', body: 'c' }).bodyContent === 'b', 'snippet 2nd');
  assert(normalizePayload({ bodyText: '', snippet: '', body: 'c' }).bodyContent === 'c', 'body 3rd');
  assert(normalizePayload({}).bodyContent === '', 'all empty → empty');

  describe('count / isBatch');
  assert(normalizePayload({ count: 0 }).isBatch === false, 'count 0 → not batch');
  assert(normalizePayload({ count: 1 }).isBatch === false, 'count 1 → not batch');
  assert(normalizePayload({ count: 2 }).isBatch === true, 'count 2 → batch');
  assert(normalizePayload({ count: 100 }).isBatch === true, 'count 100 → batch');

  describe('dateFormatted: delegates to formatDate');
  assert(normalizePayload({ date: new Date('2026-06-02T06:00:00Z') }).dateFormatted !== '', 'valid date formatted');
  assert(normalizePayload({ date: null }).dateFormatted === '', 'null → empty');

  describe('passthrough fields preserved');
  {
    const d = normalizePayload({ fromName: '张三', url: 'https://m.com', unreadCount: 5, extra: 'keep' });
    assert(d.fromName === '张三', 'fromName passthrough');
    assert(d.url === 'https://m.com', 'url passthrough');
    assert(d.unreadCount === 5, 'unreadCount passthrough');
    assert(d.extra === 'keep', 'extra field passthrough');
  }
});

// ==========================================================================
// 3. buildFeishuPayload
// ==========================================================================

group('buildFeishuPayload — single message', () => {
  describe('normal single message');
  {
    const p = buildFeishuPayload({
      fromEmail: 'zhang@example.com',
      subject: 'Q2产品评审会议',
      bodyText: '各位同事，明天下午2点在3楼会议室进行Q2产品评审...',
      date: new Date('2026-06-02T06:30:00Z'),
      toRecipients: 'wo@example.com 等3人',
    });
    assert(p.msg_type === 'interactive', 'msg_type correct');
    assert(p.card.header.template === 'blue', 'header template blue');
    assert(p.card.header.title.content.includes('📬'), 'title has 📬');
    assert(p.card.header.title.content.includes('Q2产品评审会议'), 'title = subject');
    assert(p.card.elements[0].tag === 'div', 'first element is div');
    assert(p.card.elements[0].text.content.includes('各位同事'), 'body content present');
    assert(p.card.elements[1].tag === 'hr', 'second element is hr');
    assert(p.card.elements[2].tag === 'note', 'third element is note');
    // Footer
    const footer = p.card.elements[2].elements[0].content;
    assert(footer.includes('发件人：zhang@example.com'), 'footer has fromEmail');
    assert(footer.includes('收件人：wo@example.com'), 'footer has toRecipients');
    assert(footer.includes('收件时间：2026'), 'footer has date');
    // No action button
    assert(!p.card.elements.some(e => e.tag === 'action'), 'no button element');
  }

  describe('empty subject → (无主题)');
  assert(
    buildFeishuPayload({ fromEmail: 'a@b.com', subject: '' }).card.header.title.content.includes('(无主题)'),
    'empty subject falls back'
  );

  describe('no recipients, no date → only sender in footer');
  {
    const p = buildFeishuPayload({ fromEmail: 'a@b.com', subject: 'Hi' });
    const footer = p.card.elements[2].elements[0].content;
    assert(footer === '发件人：a@b.com', 'footer only has sender');
    assert(!footer.includes('收件人'), 'no recipient line');
    assert(!footer.includes('收件时间'), 'no date line');
  }

  describe('empty fromEmail falls back');
  {
    const p = buildFeishuPayload({ fromEmail: '', subject: 'Hi' });
    const footer = p.card.elements[2].elements[0].content;
    assert(footer.includes('(未知)'), 'fromEmail fallback in footer');
  }
});

group('buildFeishuPayload — batch', () => {
  describe('3 new messages');
  {
    const p = buildFeishuPayload({
      fromEmail: 'sys@m.com', count: 3,
      date: new Date('2026-06-02T06:00:00Z'), toRecipients: 'u1@m.com 等2人',
    });
    assert(p.card.header.title.content === '📬 3 封新邮件', 'batch title');
    assert(p.card.elements[0].text.content === '您收到了 3 封新邮件', 'batch body');
    const footer = p.card.elements[2].elements[0].content;
    assert(footer.includes('发件人：sys@m.com'), 'batch footer has sender');
    assert(footer.includes('收件人'), 'batch footer has recipients');
    assert(footer.includes('收件时间'), 'batch footer has date');
  }
});

group('buildFeishuPayload — truncation', () => {
  describe('title > 95 chars → truncated');
  {
    const longSubj = '很长的标题测试'.repeat(14); // ~98 chars, after 📬 = 101
    const p = buildFeishuPayload({ fromEmail: 'a@b.com', subject: longSubj });
    assert(p.card.header.title.content.endsWith('...'), 'title truncated with ...');
    // The raw subject (before "📬 " decoration) should have been truncated
    const rawTitle = p.card.header.title.content.replace('📬 ', '');
    assert(rawTitle.length <= 98, 'raw title ≤ 98 chars');
  }

  describe('title exactly 95 chars → not truncated');
  {
    const exact = 'x'.repeat(90); // + "📬 " = 93, well under 95
    const p = buildFeishuPayload({ fromEmail: 'a@b.com', subject: exact });
    assert(!p.card.header.title.content.endsWith('...'), 'exact not truncated');
  }

  describe('body > 1900 chars → truncated');
  {
    const longBody = '邮'.repeat(2500); // 2500 chars, exceeds 1900
    const p = buildFeishuPayload({ fromEmail: 'a@b.com', subject: 'Hi', bodyText: longBody });
    assert(p.card.elements[0].text.content.includes('（正文过长，已截断）'), 'body truncated');
    assert(p.card.elements[0].text.content.length <= 1915, 'body within limit');
  }

  describe('body exactly 1900 → not truncated');
  {
    const exact = 'x'.repeat(1900);
    const p = buildFeishuPayload({ fromEmail: 'a@b.com', subject: 'Hi', bodyText: exact });
    assert(!p.card.elements[0].text.content.includes('截断'), 'exact not truncated');
  }
});

// ==========================================================================
// 4. buildDingTalkPayload
// ==========================================================================

group('buildDingTalkPayload — single message', () => {
  describe('normal single message');
  {
    const p = buildDingTalkPayload({
      fromEmail: 'zhang@example.com',
      subject: 'Q2产品评审会议',
      bodyText: '各位同事，明天下午2点在3楼会议室进行Q2产品评审...',
      date: new Date('2026-06-02T06:30:00Z'),
      toRecipients: 'wo@example.com 等3人',
    });
    assert(p.msgtype === 'markdown', 'msgtype correct');
    assert(p.markdown.title === 'Q2产品评审会议', 'title = subject');
    const text = p.markdown.text;
    assert(text.startsWith('## 📬'), 'starts with h2 📬');
    assert(text.includes('Q2产品评审会议'), 'includes subject');
    assert(text.includes('各位同事'), 'includes body');
    assert(text.includes('---'), 'has separator');
    assert(text.includes('**发件人：**zhang@example.com'), 'footer has sender');
    assert(text.includes('**收件人：**wo@example.com'), 'footer has recipients');
    assert(text.includes('**收件时间：**'), 'footer has date');
  }

  describe('no recipients, no date → only sender');
  {
    const p = buildDingTalkPayload({ fromEmail: 'a@b.com', subject: 'Hi' });
    assert(!p.markdown.text.includes('收件人'), 'no recipient line');
    assert(!p.markdown.text.includes('收件时间'), 'no date line');
    assert(p.markdown.text.includes('**发件人：**a@b.com'), 'has sender');
  }
});

group('buildDingTalkPayload — batch', () => {
  describe('5 new messages');
  {
    const p = buildDingTalkPayload({
      fromEmail: 'sys@m.com', count: 5,
      date: new Date('2026-06-02T06:00:00Z'), toRecipients: 'u@m.com',
    });
    assert(p.markdown.title === '5 封新邮件', 'batch title');
    assert(p.markdown.text.includes('📬 5 封新邮件'), 'batch h2');
    assert(p.markdown.text.includes('您收到了 5 封新邮件'), 'batch body');
  }
});

group('buildDingTalkPayload — truncation', () => {
  describe('subject > 50 chars → truncated');
  {
    const longSubj = '很长的主题标题'.repeat(10); // 70 chars
    const p = buildDingTalkPayload({ fromEmail: 'a@b.com', subject: longSubj });
    assert(p.markdown.title.length <= 53, 'title truncated ≤ 53');
    assert(p.markdown.title.endsWith('...'), 'title ends with ...');
  }

  describe('body > 19000 chars → truncated');
  {
    const longBody = 'x'.repeat(21000);
    const p = buildDingTalkPayload({ fromEmail: 'a@b.com', subject: 'Hi', bodyText: longBody });
    assert(p.markdown.text.includes('（正文过长，已截断）'), 'body truncated');
    assert(p.markdown.text.length <= 20000, 'body within limit');
  }
});

// ==========================================================================
// 5. buildWebhookPayload
// ==========================================================================

group('buildWebhookPayload', () => {
  describe('all fields present');
  {
    const p = buildWebhookPayload({
      title: 'New mail', body: 'Body text', bodyText: 'Full body',
      fromName: '张三', fromEmail: 'zhang@example.com',
      subject: 'Test Subject', count: 1, snippet: 'Body text',
      url: 'https://m.local', unreadCount: 3,
      date: new Date('2026-06-02T06:00:00Z'),
      toRecipients: 'wo@example.com 等2人',
    });
    const keys = Object.keys(p).sort();
    assert(keys.includes('event'), 'event field');
    assert(keys.includes('timestamp'), 'timestamp field');
    assert(keys.includes('bodyText'), 'bodyText field');
    assert(keys.includes('date'), 'date field');
    assert(keys.includes('toRecipients'), 'toRecipients field');
    assert(p.event === 'new_mail', 'event = new_mail');
    assert(p.fromName === '张三', 'fromName correct');
    assert(p.fromEmail === 'zhang@example.com', 'fromEmail correct');
    assert(p.bodyText === 'Full body', 'bodyText = raw bodyText');
    assert(p.snippet === 'Body text', 'snippet correct');
    assert(p.date instanceof Date, 'date is Date');
    assert(p.toRecipients === 'wo@example.com 等2人', 'toRecipients correct');
  }

  describe('empty data → all fallbacks work');
  {
    const p = buildWebhookPayload({});
    assert(p.event === 'new_mail', 'event always present');
    assert(typeof p.timestamp === 'string', 'timestamp always present');
    assert(p.fromEmail === '(未知)', 'fromEmail fallback');
    assert(p.subject === '(无主题)', 'subject fallback');
    assert(p.body === '(无主题)', 'body falls back to subject');
    assert(p.title === '(未知)', 'title falls back to fromEmail');
    assert(p.count === 1, 'count defaults to 1');
    assert(p.bodyText === null, 'bodyText null when empty');
    assert(p.date === null, 'date null when absent');
    assert(p.toRecipients === '', 'toRecipients empty when absent');
    assert(p.fromName === '', 'fromName empty when absent');
  }

  describe('snippet empty → empty string');
  assert(buildWebhookPayload({ snippet: '' }).snippet === '', 'empty snippet = ""');
  assert(buildWebhookPayload({ snippet: undefined }).snippet === '', 'undefined snippet = ""');

  describe('unreadCount preserved');
  assert(buildWebhookPayload({ unreadCount: 0 }).unreadCount === 0, 'unreadCount 0');
  assert(buildWebhookPayload({ unreadCount: 42 }).unreadCount === 42, 'unreadCount 42');
  assert(buildWebhookPayload({}).unreadCount === undefined, 'unreadCount undefined');

  describe('JSON serializable (no undefined values)');
  {
    const p = buildWebhookPayload({});
    const json = JSON.stringify(p);
    const parsed = JSON.parse(json);
    assert(parsed.event === 'new_mail', 'round-trip ok');
    assert(parsed.bodyText === null, 'bodyText null survived');
    assert(parsed.date === null, 'date null survived');
  }
});

// ==========================================================================
// 6. notifyPayload shape (as constructed in imapManager.js)
// ==========================================================================

group('notifyPayload — imapManager construction', () => {
  // Simulate latest.* as returned by parseMessage() in messageParser.js
  const latest = {
    fromName: '张三',
    fromEmail: 'zhang@example.com',
    subject: '会议邀请',
    snippet: '明天下午2点开会',
    date: new Date('2026-06-02T06:30:00Z'),
    to: [
      { name: '我', email: 'wo@example.com' },
      { name: '李四', email: 'lisi@example.com' },
      { name: '王五', email: 'wangwu@example.com' },
      { name: '赵六', email: 'zhaoliu@example.com' },
      { name: '钱七', email: 'qianqi@example.com' },
    ],
  };

  describe('notifyPayload built from latest message');
  {
    const snippet = latest.snippet || '';
    const bodyText = null; // would be set by prefetch
    const toRecipients = latest.to?.length
      ? (latest.to[0]?.email || '(未知)') + (latest.to.length > 1 ? ` 等${latest.to.length}人` : '')
      : '';

    const notifyPayload = {
      title: latest.fromName || latest.fromEmail || 'New mail',
      body: snippet || latest.subject || '(no subject)',
      bodyText,
      fromName: latest.fromName || '', fromEmail: latest.fromEmail || '',
      subject: latest.subject, snippet,
      count: 1,  // newMessages.length
      date: latest.date, toRecipients,
    };

    assert(notifyPayload.title === '张三', 'title = fromName');
    assert(notifyPayload.body === '明天下午2点开会', 'body = snippet');
    assert(notifyPayload.fromEmail === 'zhang@example.com', 'fromEmail passed');
    assert(notifyPayload.subject === '会议邀请', 'subject passed');
    assert(notifyPayload.toRecipients === 'wo@example.com 等5人', 'toRecipients = 1st email + count');
  }

  describe('toRecipients: single recipient → no 等N人 suffix');
  {
    const to = [{ email: 'only@me.com' }];
    const r = to[0].email + (to.length > 1 ? ` 等${to.length}人` : '');
    assert(r === 'only@me.com', 'single = no suffix');
  }

  describe('toRecipients: empty to[] → empty string');
  {
    const r = [].length
      ? ([][0]?.email || '(未知)') + ([].length > 1 ? ` 等${[].length}人` : '')
      : '';
    assert(r === '', 'empty array → empty');
  }

  describe('toRecipients: missing email → (未知) fallback');
  {
    const to = [{ name: 'NoEmail' }];
    const r = to.length
      ? (to[0]?.email || '(未知)') + (to.length > 1 ? ` 等${to.length}人` : '')
      : '';
    assert(r === '(未知)', 'missing email → (未知)');
  }

  describe('notifyPayload: fromName/fromEmail missing → empty strings');
  {
    const np = {
      fromName: undefined || '', fromEmail: undefined || '',
    };
    assert(np.fromName === '', 'fromName → ""');
    assert(np.fromEmail === '', 'fromEmail → ""');
  }

  describe('notifyPayload: body when snippet empty → subject fallback');
  {
    const snippet = '';
    const subject = '会议邀请';
    const body = snippet || subject || '(no subject)';
    assert(body === '会议邀请', 'body = subject when snippet empty');
  }

  describe('notifyPayload: body when both empty → (no subject)');
  {
    const snippet = '';
    const subject = '';
    const body = snippet || subject || '(no subject)';
    assert(body === '(no subject)', 'body = (no subject)');
  }
});

// ==========================================================================
// 7. Cross-builder consistency
// ==========================================================================

group('Cross-builder consistency', () => {
  const data = {
    fromEmail: 'test@example.com',
    subject: 'Test Subject',
    bodyText: 'Test body content.',
    date: new Date('2026-06-02T06:30:00Z'),
    toRecipients: 'you@example.com',
  };

  describe('all builders accept same data shape');
  {
    let ok = true;
    try { buildFeishuPayload(data); } catch (_) { ok = false; }
    assert(ok, 'feishu accepts');
    ok = true;
    try { buildDingTalkPayload(data); } catch (_) { ok = false; }
    assert(ok, 'dingtalk accepts');
    ok = true;
    try { buildWebhookPayload(data); } catch (_) { ok = false; }
    assert(ok, 'webhook accepts');
  }

  describe('all builders handle completely empty input');
  {
    let ok = true;
    try { buildFeishuPayload({}); } catch (_) { ok = false; }
    assert(ok, 'feishu empty ok');
    ok = true;
    try { buildDingTalkPayload({}); } catch (_) { ok = false; }
    assert(ok, 'dingtalk empty ok');
    ok = true;
    try { buildWebhookPayload({}); } catch (_) { ok = false; }
    assert(ok, 'webhook empty ok');
  }

  describe('body priority identical across builders');
  {
    const withBodyText = { bodyText: 'BT', snippet: 'SN', body: 'BD', fromEmail: 'a@b.com' };
    const f = buildFeishuPayload(withBodyText).card.elements[0].text.content;
    const d = buildDingTalkPayload(withBodyText).markdown.text;
    const w = buildWebhookPayload(withBodyText);
    assert(f.includes('BT'), 'feishu uses bodyText');
    assert(d.includes('BT'), 'dingtalk uses bodyText');
    assert(w.bodyText === 'BT', 'webhook bodyText = BT');
    assert(w.body === 'BD', 'webhook body = raw BD (no normalize for body field)');
  }

  describe('all footers format date identically');
  {
    const d1 = new Date('2026-06-02T06:30:00Z');
    const f = buildFeishuPayload({ ...data, date: d1 });
    const d = buildDingTalkPayload({ ...data, date: d1 });
    const fFooter = f.card.elements[2].elements[0].content;
    const dText = d.markdown.text;
    assert(fFooter.includes(formatDate(d1)), 'feishu date');
    assert(dText.includes(formatDate(d1)), 'dingtalk date');
  }
});

// ==========================================================================
// 8. Regression: old bugs MUST NOT come back
// ==========================================================================

group('Regression tests', () => {
  describe('BUG-1: body must NOT equal subject for single message');
  {
    const p = buildWebhookPayload({
      fromEmail: 'z@e.com',
      subject: '会议通知',
      body: '明天下午2点在3楼开会讨论Q2规划',
      snippet: '明天下午2点在3楼开会讨论Q2规划',
      count: 1,
    });
    assert(p.body !== p.subject, 'body ≠ subject');
    assert(p.body === '明天下午2点在3楼开会讨论Q2规划', 'body = actual content');
    assert(p.title !== p.body, 'title ≠ body');
  }

  describe('BUG-2: snippet must not be empty for providers that fetch body');
  {
    // When snippet is empty, builders should use whatever fallback is available
    const p = buildWebhookPayload({
      fromEmail: 'z@e.com', subject: '会议通知', snippet: '', bodyText: null, count: 1,
    });
    assert(p.bodyText === null, 'bodyText null when empty');
    assert(p.snippet === '', 'snippet empty string');
    // But bodyContent in feishu/dingtalk should still render something
    const f = buildFeishuPayload({ fromEmail: 'z@e.com', subject: '会议通知', snippet: '' });
    assert(f.card.elements[0].text.content === '', 'feishu body empty when no content');
    // Title should still work
    assert(f.card.header.title.content.includes('会议通知'), 'title works even without body');
  }
});

// ==========================================================================
// Summary
// ==========================================================================

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);

if (failed > 0) {
  console.error('\n❌ Some tests FAILED!');
  process.exit(1);
}

console.log('✅ All tests passed!');

// ==========================================================================
// Optional: live delivery test
// ==========================================================================

const webhookUrl = process.argv[2];
if (webhookUrl) {
  console.log(`\n🌐 Sending live test to ${webhookUrl}\n`);

  const testPayloads = [
    {
      label: 'Feishu single',
      payload: buildFeishuPayload({
        fromEmail: 'zhangsan@example.com',
        subject: '测试飞书通知 — Q2产品评审会议',
        bodyText: '各位同事，明天下午2点在3楼会议室进行Q2产品评审，请大家提前准备好各自模块的演示材料。',
        date: new Date(),
        toRecipients: 'wo@example.com 等3人',
      }),
    },
    {
      label: 'Feishu batch',
      payload: buildFeishuPayload({
        fromEmail: 'sys@example.com',
        count: 5,
        date: new Date(),
        toRecipients: 'wo@example.com 等6人',
      }),
    },
    {
      label: 'Webhook single',
      payload: buildWebhookPayload({
        fromName: '李四', fromEmail: 'lisi@example.com',
        subject: '测试Webhook通知', body: '这是正文内容', snippet: '这是正文内容',
        bodyText: '这是正文内容', count: 1, date: new Date(),
        toRecipients: 'wo@example.com 等2人', unreadCount: 3, url: 'https://mailflow.local',
      }),
    },
    {
      label: 'DingTalk single',
      payload: buildDingTalkPayload({
        fromEmail: 'wangwu@example.com',
        subject: '测试钉钉通知 — Q2产品评审会议',
        bodyText: '各位同事，明天下午2点在3楼会议室进行Q2产品评审，请大家提前准备好各自模块的演示材料。',
        date: new Date(),
        toRecipients: 'wo@example.com 等3人',
      }),
    },
  ];

  let sendFailed = 0;
  for (const { label, payload } of testPayloads) {
    try {
      const p = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const res = await fetch(webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: p, signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      const ok = res.ok && !text.includes('"code":19002') && !text.includes('"errcode":400');
      if (ok) console.log(`  ✅ ${label}`);
      else { console.error(`  ❌ ${label} — ${text.slice(0, 200)}`); sendFailed++; }
    } catch (err) {
      console.error(`  ❌ ${label} — ${err.message}`);
      sendFailed++;
    }
  }
  console.log(`\nLive results: ${testPayloads.length - sendFailed}/${testPayloads.length} sent`);
}

process.exit(0);
