# Карта кодовой базы MailExpert

## Снимок анализа

- Основа: upstream `maathimself/mailflow`, commit `543a049cd085306af095a5e244a26722544432af`.
- Форк: `wyrtensi/MailExpert`.
- Версия исходного приложения: 3.3.0.
- Проанализировано: 1012 tracked-файлов.
- Текстовые исходники и конфигурация: 452 файла, около 132 500 строк и 5,88 млн символов.
- 474 из 1012 файлов — шрифты WOFF2; 57 — PNG. Они увеличивают размер репозитория, но почти не влияют на сложность сопровождения.

| Область | Файлов | Комментарий |
| --- | ---: | --- |
| JavaScript | 276 | Backend, utilities, stores, tests и web/native helpers |
| JSX | 39 | Основной React UI; часть компонентов чрезмерно крупная |
| JSON | 17 | Девять локалей, package metadata, manifests/config |
| SQL migrations | 51 | Последовательная PostgreSQL-схема |
| Java | 13 | Android native bridge |
| Backend tests | 74 на baseline | Vitest, baseline: 1333 теста; два test-файла добавлены переносом PR #425/#420 |
| Frontend tests | 48 с новым branding test | Node test runner, baseline до изменения: 1864 теста |

## Общая схема выполнения

```text
Browser / PWA / Electron / Android shell
                |
                | HTTPS + session cookie + X-Requested-With
                v
        Express API (backend/src/index.js)
          |          |          |
          |          |          +--> Redis: sessions, shared runtime state
          |          +-------------> PostgreSQL: users, accounts, message cache
          +------------------------> IMAP via ImapFlow / SMTP via Nodemailer
```

Frontend не ходит к Gmail напрямую. Он обращается к Express API. Backend хранит настройки аккаунтов, держит/ограничивает IMAP-соединения, индексирует метаданные писем в PostgreSQL и отправляет изменения интерфейсу через WebSocket. SMTP-отправка выполняется отдельно для выбранного аккаунта.

## Корень репозитория

| Файл | Назначение | Что учитывать в MailExpert |
| --- | --- | --- |
| `README.md` | Установка, функции и эксплуатация | Содержит upstream-инструкции; дополнен ссылкой на эту карту |
| `.env.example` | Все runtime-переменные | Здесь появятся Google OAuth, лимиты IMAP и production-настройки |
| `docker-compose.yml` | Локальный HTTP/HTTPS stack | Backend, frontend, PostgreSQL и Redis на одном сервере |
| `docker-compose.https.yml` | Профиль с публичным TLS | Для production всё равно предпочтителен внешний reverse proxy/Cloudflare Access |
| `docker-compose.ghcr.yml` | Запуск готовых upstream images | После появления MailExpert images должен указывать на наш registry |
| `Caddyfile` | TLS/reverse proxy | Не смешивать с OAuth-логикой |
| `.github/workflows/*` | CI, release, images, native builds | После первого push проверить, что actions разрешены в форке |
| `LICENSE` | AGPL-3.0 | Изменения сетевого сервиса должны быть доступны пользователям сервиса |
| `LICENSE-COMMERCIAL` | Уведомление о коммерческой лицензии upstream | Не является автоматической коммерческой лицензией на изменения MailExpert |
| `CLA.md`, `CONTRIBUTING.md` | Правила upstream contributions | Перед внешними PR решить, сохраняем ли upstream CLA для собственного проекта |
| `ROADMAP.md` | Upstream roadmap | Не считать утверждённым roadmap MailExpert без отдельной маркировки |

## Backend

### Точка входа и middleware

`backend/src/index.js` собирает Express-приложение, security headers, CORS/CSRF-защиту, сессии Redis, WebSocket, маршруты, migration startup и IMAP manager. Это центральный composition root; новые provider-модули лучше подключать сюда минимально, не добавляя бизнес-логику в сам файл.

`backend/src/middleware/auth.js` проверяет обычную, admin- и lock-сессию. OAuth callback должен связываться с инициирующей сессией, но provider logic не должна ослаблять общую middleware-модель.

### HTTP-маршруты

| Файл | Ответственность |
| --- | --- |
| `routes/accounts.js` | CRUD IMAP/SMTP-аккаунтов, aliases, folder mappings и флаг unified inbox |
| `routes/admin.js` | Пользователи, приглашения, системная почта и административные операции |
| `routes/auth.js` | Регистрация, login, MFA enrolment, password reset, preferences и сессии |
| `routes/totp.js` | Отдельные TOTP-операции |
| `routes/oauth.js` | Microsoft OAuth/device code; монтирует `routes/oauthGoogle.js` и реэкспортирует `refreshMicrosoftToken` из `services/oauth/microsoftOAuth.js` |
| `routes/oauthGoogle.js` | Google OAuth: `GET /oauth/google` (state + PKCE в Redis) и callback с upsert Gmail-аккаунта |
| `routes/oidc.js` | Вход пользователей MailExpert через внешний OIDC/SSO; не путать с OAuth почтового аккаунта |
| `routes/integrations.js` | Глобальные секреты/настройки интеграций |
| `routes/mail.js` | Чтение, папки, move/delete/archive/snooze и вложения; 2286 строк |
| `routes/send.js` | Отправка, reply/forward, MIME и Sent APPEND |
| `routes/draft.js` | Сохранение и синхронизация черновиков |
| `routes/search.js` | Поиск по кешу/индексам с account scope |
| `routes/rules.js` | Правила обработки входящих |
| `routes/blockList.js` | Пользовательский blacklist |
| `routes/categories.js` | Категории сообщений |
| `routes/contacts.js` | Внутренние контакты |
| `routes/carddav.js` | CardDAV server, который MailExpert предоставляет клиентам |
| `routes/carddavAccount.js` | Подключение внешнего CardDAV source |
| `routes/diagnostics.js` | Безопасный диагностический отчёт |
| `routes/ai.js` | AI provider/actions |
| `routes/plugins.js` | Управление plugin runtime/config |
| `routes/senderFavicons.js` | Прокси и кеш доменных иконок отправителя |
| `routes/todoist.js` | Todoist integration |

Файлы `*.test.js` рядом с маршрутами — contract/regression tests. Новые Google OAuth routes должны получить отдельный `oauth.google.test.js`, а не расширять только Microsoft refresh test.

### Почтовое ядро

`services/imapManager.js` — крупнейший backend-файл: 5633 строки и около 308 КБ. Он отвечает сразу за connection admission, provider profiles, IDLE/polling, backfill, folder sync, fetch/parsing, indexing, reconnection и часть правил. Его нельзя переписывать одновременно с обновлением ImapFlow и OAuth.

Критические соседние файлы:

- `smtpTransport.js` — создаёт transport выбранного аккаунта, обновляет Microsoft token и закрепляет SMTP за проверенными IP-адресами.
- `messageParser.js` — MIME/header/body parsing и snippet extraction.
- `messageService.js` и `mailAccess.js` — account-scoped доступ к сообщениям.
- `folderStatus.js` — server/local status папок.
- `archiveInbox.js` — фоновые archive-процессы.
- `inboxRules.js` и `ruleForwarder.js` — применение правил и forwarding.
- `labels.js`, `labelsRead.js` — label/folder metadata.
- `unifiedInbox.js` — выбор аккаунтов для общей ленты; в нашем MVP все Gmail получают opt-out.

### Безопасность и инфраструктура backend

- `encryption.js` — граница шифрования паролей и OAuth-токенов. Google refresh token должен проходить только через неё.
- `hostValidation.js`, `connectionPolicy.js`, `safeFetch.js` — SSRF/DNS rebinding/TLS policy. Не обходить их в OAuth или SMTP.
- `redis.js` — клиент Redis и session/runtime state.
- `db.js`, `migrations.js` — PostgreSQL pool, транзакции и запуск миграций.
- `authLimiter.js`, `rateLimiter.js`, `authEvents.js` — защита login/API и журнал безопасности.
- `emailSanitizer.js` — граница недоверенного HTML письма.
- `logger.js`, `diagnosticsRing.js`, `diagnosticsReport.js` — журналы и redaction.
- `websocket.js`, `pushNotifications.js` — обновления UI и Web Push.
- `performanceMetrics.js` — база для нагрузочного теста 100 Gmail.

### PostgreSQL migrations

51 migration образуют append-only историю от `0001_baseline.sql` до `0051_folder_server_status.sql`.

Основные группы:

- `0001–0009`: базовая схема сообщений, threading и search indexes.
- `0010–0018`: rules, block list, contacts, bulk/category metadata.
- `0019–0029`: integrations, trusted MFA devices, reset tokens, unsubscribe, OIDC, CardDAV и OAuth public-client flag.
- `0030–0035`: GTD и lock/logout.
- `0036–0040`: per-account unified inbox, delivery addresses, Codex OAuth, forwarding и отдельные SMTP credentials.
- `0041–0046`: plugin data/config и перенос GTD в plugin architecture.
- `0047–0051`: folder selectability, snippet retry state, OIDC matching, sender metadata и server folder status.

Новая Google OAuth реализация не требует отдельных token-колонок: `email_accounts.oauth_*` provider-agnostic. Миграция потребуется только если мы сохраняем Google `sub`, PKCE pending grants или явное состояние reconnect в БД. Для одноразового state/PKCE предпочтителен Redis с TTL.

### Plugin layer

`backend/src/plugins/registry.js`, `loadPlugins.js`, `mailEngine.js`, `mailEngineFacade.js`, `storage.js` и `accountConfig.js` формируют расширяемую границу. GTD уже вынесен в `backend/src/plugins/gtd/*` и показывает рекомендуемый способ добавлять независимые функции.

Google OAuth — не plugin уровня UI: он является credential provider для общего mail engine. Его разумно вынести в `services/oauth/googleOAuth.js` и `services/oauth/tokenManager.js`, оставив routes тонкими.

## Frontend

### Точки входа и состояние

- `src/main.jsx` — React bootstrap.
- `src/App.jsx` — theme/layout init, callback-window handling и первичная проверка сессии.
- `src/components/MailApp.jsx` — shell авторизованного приложения, navigation и глобальные эффекты.
- `src/store/index.js` — Zustand store; 1237 строк. Хранит accounts, selection, folders, messages и UI state.
- `src/utils/api.js` — единый HTTP client и CSRF header.
- `src/hooks/useWebSocket.js` — real-time events и reconciliation.

### Крупные UI-компоненты

| Файл | Размер | Роль и риск изменения |
| --- | ---: | --- |
| `AdminPanel.jsx` | 8621 строк | Все настройки в одном файле; Google integration следует вынести в отдельный компонент |
| `MessageList.jsx` | 4714 | Список, threads, bulk actions; высокий риск гонок optimistic state |
| `MessagePane.jsx` | 3420 | Рендеринг недоверенного email HTML и actions |
| `ComposeModal.jsx` | 3304 | Редактор, aliases, attachments, reply/forward |
| `Sidebar.jsx` | 2055 | Аккаунты и папки; сюда добавляется фильтр 100 ящиков |
| `MailApp.jsx` | 1019 | Application shell и callback integration |
| `LoginPage.jsx` | 1000 | Password/OIDC/MFA flows |
| `ContactsPage.jsx` | 861 | Контакты и CardDAV-derived data |
| `ContextMenu.jsx` | 809 | Message/folder actions |

Остальные компоненты отвечают за command palette, diagnostics, window layers, notifications, profile, signature editor, GTD views и native notification bridge.

### Utilities и тестируемая бизнес-логика

`src/utils/*` содержит account scope, optimistic guards, folder ordering, reply alias selection, message identity/deduplication, draft autosave, diagnostics, security policy native actions и UI helpers. Это наиболее удобное место для чистых функций с быстрыми `node --test` тестами.

Для MailExpert важны:

- `accountScope.js` — выбранный аккаунт против общей области;
- `defaultSender.js`, `replyAlias.js` — правильный From;
- `unifiedInbox.js` — исключение наших Gmail из общей ленты;
- `folderSync.js` — внешние папки Gmail;
- `sidebar.js` — будущий фильтр аккаунтов;
- `nativeActionSecurity.js` — доверие native bridge;
- `api.js` — все OAuth/admin вызовы должны идти через него.

### Локализация

`src/locales/{cs,de,en,es,fr,it,pl,ru,zhCN}.json` должны иметь одинаковые ключи. `i18n.test.js` проверяет key coverage, отсутствие неиспользуемых ключей, совпадения значений и hardcoded strings. Любой новый OAuth UI должен обновлять сразу девять локалей.

### Native wrappers

- `frontend/packages/electron/*` — Electron shell, update verification и installer.
- `frontend/packages/native-shell/*` — страница выбора/ошибки сервера.
- `frontend/packages/android/*` — Capacitor/Java bridge, background sync и notification actions.

Полный ребрендинг выполнен до начала продуктовой разработки: локальные IDs используют `sh.mailexpert.app`, Java-классы и native plugin — `MailExpertNative`, browser storage — `mailexpert_*`, Docker services/volumes и data paths — `mailexpert`. Это намеренно разрывает совместимость с ранними upstream-установками и исключает дальнейшее накопление legacy-идентификаторов.

## Проверки и quality gates

Backend:

```bash
cd backend
npm ci
npm test
npm run lint
npm run lint:plugins
npm run audit:redos
```

Frontend:

```bash
cd frontend
npm ci
npm test
npm run lint
npm run build
```

Baseline на commit `543a049`: backend 1333/1333 тестов, frontend 1864/1864 тестов.

После baseline в MailExpert перенесены upstream PR #425 и #420. Они добавили `messageParser.attachments.test.js` и `mail.createFolder.test.js`; целевой прогон трёх связанных test-файлов после переноса дал 243/243.

Итоговый gate bootstrap выполнен и локально на Node 24.19.0, и в чистых `node:22-bookworm-slim` контейнерах:

- backend: 76 test-файлов, 1345/1345 тестов;
- backend ESLint: pass;
- plugin-boundary ESLint: pass;
- frontend: 1866/1866 тестов;
- frontend ESLint: pass;
- production build: pass;
- `branding.test.js`: 2/2;
- `git diff --check`: pass.

Production build предупреждает о нескольких chunks больше 500 kB. Крупнейшие — `store` (~733 kB), основной `index` (~690 kB) и `ComposeModal` (~558 kB) до gzip. Это performance debt для отдельной задачи по code splitting, а не ошибка bootstrap.

На момент ребрендинга `npm audit` показывал один moderate advisory backend в transitive `qs`, для которого было доступно обычное исправление, и два связанных moderate advisory frontend в `react-router`/`react-router-dom`, для которых npm предлагал major-обновление. Они входили в первый dependency-модернизационный этап и не исправлялись принудительным `npm audit fix --force` внутри ребрендинга. Обновление зависимостей в сентябре 2026 года закрыло оба advisory: `qs` ушёл вместе с Express 4, а `react-router-dom` удалён и заменён на `react-router` 7. Подробности — в [dependency-upgrade-2026-09.md](../operations/dependency-upgrade-2026-09.md).

## Главные технические риски

1. `imapManager.js` и `AdminPanel.jsx` стали монолитами. Новую OAuth-логику нельзя добавлять в них большим inline-блоком.
2. Одновременное обновление major-зависимостей и перенос PR делает регрессии неразличимыми. Сначала dependency snapshot, потом Google provider.
3. Один общий пользователь удобен, но не даёт атрибуции действий менеджерам.
4. 100 Gmail создают provider/IP connection pressure; лимит проверяется измерениями, а не размером PostgreSQL.
5. OAuth restricted scope требует организационной verification независимо от качества кода.
6. Native IDs и data paths нельзя переименовывать простым search/replace.

## Рекомендуемые границы будущих изменений

- Google OAuth: новые `services/oauth/*`, тонкие routes, Redis TTL для pending state/PKCE.
- Provider refresh: один `tokenManager` для Google/Microsoft, вызываемый всеми IMAP/SMTP путями.
- UI Google integration: отдельный React component, подключённый к AdminPanel.
- Mailbox filter: чистая utility + минимальная Sidebar integration.
- EOP/Postfix/Dovecot: отдельный mail-node и отдельный план; не встраивать MTA в Express process.
