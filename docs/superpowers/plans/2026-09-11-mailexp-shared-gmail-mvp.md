# План реализации MailExp для общей работы со 100 Gmail

> Статус: bootstrap форка и ребрендинг начаты; обновление зависимостей и Google OAuth ещё не реализованы.

**Цель:** подготовить MailExp — форк upstream-проекта [MailFlow](https://github.com/maathimself/mailflow), в котором один общий рабочий пользователь может подключить до 100 личных Gmail-ящиков через обязательный Google OAuth 2.0, выбирать конкретный ящик, читать и отправлять письма от его имени. Общая лента всех писем и разделение прав менеджеров в MVP не входят.

**Основной порядок:** сначала полностью и контролируемо обновить backend/frontend-зависимости, включая ImapFlow и Nodemailer; затем реализовать Google OAuth и только после этого дорабатывать интерфейс и проверять нагрузку.

**Архитектурный документ:** `docs/architecture/team-mail-system-handoff.md`.

## Зафиксированные решения

- Серверная ОС: Ubuntu Server 24.04 LTS.
- Runtime: Node.js 22, PostgreSQL 16+, Redis Server 7+.
- Один системный администратор и один общий пользователь MailExp для менеджеров.
- До 100 личных Gmail-ящиков на старте; собственные доменные ящики через Postfix/Dovecot/EOP — отдельный этап.
- Google OAuth 2.0 обязателен для Gmail уже в MVP.
- Пароль приложения не используется как штатный способ подключения Gmail. Он остаётся только возможностью общего IMAP/SMTP-адаптера для иных провайдеров.
- Каждый Gmail проходит отдельный consent flow. Один OAuth client обслуживает подключения, но не заменяет согласие владельца каждого ящика.
- Запрашиваются только `openid`, `email`, `profile`, `https://mail.google.com/`.
- Для development и production используются разные Google Cloud Projects.
- Режим Google OAuth `Testing` допускается только для разработки. Для рабочего пилота приложение переводится в `In Production`; выход на 100 уникальных Google-пользователей планируется только после необходимой verification.
- Для всех Gmail устанавливается `include_in_unified_inbox=false`.
- Алгоритм IMAP-синхронизации не переписывается без результатов измерений: сначала используем существующие ограничения, очереди, backoff и polling MailExp.
- Не копируем код EmailEngine. Используются публичные протоколы и самостоятельная реализация OAuth вокруг ImapFlow/Nodemailer.
- Monkey patching запрещён. Несовместимые major-обновления адаптируются в исходном коде с тестами.
- Комментарии в коде — только на английском.

## Что означает «полное обновление модулей»

Обновление считается завершённым, когда:

1. Зафиксирована зелёная исходная линия тестов, линтеров и сборки на чистой установке.
2. Проверены все прямые `dependencies` и `devDependencies` в `backend/package.json` и `frontend/package.json`.
3. Все прямые зависимости подняты до согласованного актуального snapshot на дату выполнения; каждое намеренно оставленное отставание записано с причиной.
4. Major-группы обновлены по отдельности и проверены, а не смешаны в одну непросматриваемую правку.
5. `backend/package-lock.json` и `frontend/package-lock.json` пересозданы штатным npm.
6. `npm outdated` пуст относительно утверждённого snapshot либо содержит только документированные исключения.
7. `npm audit` выполнен для обоих приложений; оставшиеся риски описаны, а не скрыты `--force` или overrides без объяснения.
8. Все backend-тесты и линтеры проходят; все frontend-тесты, линтеры и production build проходят.

Ключевые major-переходы, которые проверяются отдельно:

- ImapFlow 1 → 2.
- Nodemailer 9 → 10.
- Express 4 → 5; после перехода удалить `express-async-errors`.
- connect-redis 7 → 10 и Node Redis client 4 → 6.
- React 18 → 19 и React Router 6 → 7.
- Zustand 4 → 5 и date-fns 3 → 4.
- Остальные зависимости обновляются до выбранного snapshot после проверки changelog и совместимости с Node.js 22.

## Task 1. Полное обновление backend-зависимостей

**Основные файлы:**

- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Modify as required: `backend/src/index.js`
- Modify as required: `backend/src/services/redis.js`
- Modify as required: `backend/src/services/imapManager.js`
- Modify as required: `backend/src/services/smtpTransport.js`
- Modify as required: `backend/src/services/messageParser.js`
- Modify as required: `backend/src/services/safeFetch.js`
- Modify as required: `backend/src/routes/auth.js`
- Modify as required: `backend/src/routes/totp.js`
- Modify as required: `backend/src/routes/mail.js`
- Test: существующие `backend/src/**/*.test.js`
- Create: `docs/operations/dependency-upgrade-2026-09.md`

### 1.1. Зафиксировать исходную линию

На чистом checkout выполнить:

~~~bash
cd backend
npm ci
npm test
npm run lint
npm run lint:plugins
npm outdated
npm audit
~~~

В отчёте записать Node/npm, исходные версии, результат тестов и уже существующие проблемы. Если исходная линия красная, сначала отделить дефект репозитория от обновления; не маскировать его изменением тестов.

### 1.2. Первыми обновить почтовые модули

Поднять ImapFlow до 2.x и Nodemailer до 10.x, затем проверить адаптеры MailExp:

~~~bash
npm test -- src/services/imapManager.test.js src/services/smtpTransport.test.js
npm test -- src/routes/send.reliability.test.js src/routes/oauth.refresh.test.js
npm run lint
~~~

Проверить особенно: XOAUTH2-конфигурацию, TLS, abort/timeout, повторное подключение, SMTP envelope, вложения и отсутствие токенов в логах.

### 1.3. Обновить HTTP/session/Redis-группу

- Перейти на Express 5 и удалить импорт/зависимость `express-async-errors`.
- Адаптировать обработчики только там, где изменилась семантика Express 5.
- Перейти на connect-redis 10 и Redis client 6, сохранив TTL сессий, reconnect и graceful shutdown.
- Обновить express-session, cors и dotenv.
- Запустить auth, OIDC, OAuth, WebSocket и Redis-тесты.

### 1.4. Обновить оставшиеся backend-модули

Отдельными небольшими группами обновить архивирование, криптографию/TOTP, XML/HTML parsing, PostgreSQL, QR, sanitization, Undici, web-push и ws. После каждой группы запускать затронутые тесты и линтер.

### 1.5. Закрыть backend-gate

~~~bash
npm ci
npm test
npm run lint
npm run lint:plugins
npm run audit:redos
npm outdated
npm audit
~~~

В `dependency-upgrade-2026-09.md` сохранить итоговый snapshot, миграционные решения, исключения и остаточные audit-риски.

**Commit:** `chore: update backend dependencies`

## Task 2. Полное обновление frontend-зависимостей

**Файлы:**

- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify as required: `frontend/src/App.jsx`
- Modify as required: `frontend/src/main.jsx`
- Modify as required: `frontend/src/store/index.js`
- Modify as required: `frontend/src/utils/formatDate.js`
- Modify as required: компоненты и тесты, затронутые API React/Router
- Update: `docs/operations/dependency-upgrade-2026-09.md`

### 2.1. Зафиксировать frontend baseline

~~~bash
cd frontend
npm ci
npm test
npm run lint
npm run build
npm outdated
npm audit
~~~

### 2.2. Обновить framework-группы

1. React/React DOM 19 — проверить mount/unmount, эффекты, StrictMode, редактор письма и WebSocket lifecycle.
2. React Router 7 — сохранить существующие URL, callback OAuth и browser history.
3. Zustand 5 и date-fns 4 — проверить store subscriptions, account selection и форматирование дат.
4. Остальные runtime/dev-зависимости — обновлять отдельными совместимыми группами, включая Capacitor, DOMPurify, i18n, marked, PostCSS и инструменты сборки.

### 2.3. Закрыть frontend-gate

~~~bash
npm ci
npm test
npm run lint
npm run build
npm outdated
npm audit
~~~

Отразить итог в общем отчёте обновления.

**Commit:** `chore: update frontend dependencies`

## Task 3. Реализовать безопасный Google OAuth backend

**Файлы:**

- Create: `backend/src/services/oauth/googleOAuth.js`
- Create: `backend/src/services/oauth/googleOAuth.test.js`
- Create: `backend/src/services/oauth/tokenManager.js`
- Create: `backend/src/services/oauth/tokenManager.test.js`
- Modify: `backend/src/routes/oauth.js`
- Create: `backend/src/routes/oauth.google.test.js`
- Modify: `backend/src/routes/integrations.js`
- Modify: `backend/src/routes/integrations.status.test.js`
- Modify if required: `backend/src/services/migrations.js`

### 3.1. Сначала тесты OAuth-примитивов

Покрыть тестами:

- generation и одноразовую проверку `state`;
- PKCE S256: verifier хранится серверно с коротким TTL, наружу уходит только challenge;
- обязательные authorization parameters;
- обмен code на tokens;
- проверку Google ID token через Google JWKS: `iss`, `aud`, `exp`, `email_verified`;
- шифрование refresh/access token существующим encryption service;
- сохранение старого refresh token, если Google не вернул новый;
- сериализацию одновременного refresh для одного аккаунта;
- стабильную ошибку `oauth_reconnect_required` при `invalid_grant`;
- редактирование логов без code, access token, refresh token и client secret.

### 3.2. Реализовать provider layer

Минимальные интерфейсы:

~~~js
buildGoogleAuthorizationUrl({ state, codeChallenge, redirectUri })
exchangeGoogleCode({ code, codeVerifier, redirectUri })
verifyGoogleIdToken({ idToken, clientId })
refreshGoogleToken(account)
refreshOAuthToken(account)
ensureFreshOAuthAccount(account)
~~~

`refreshOAuthToken` становится общим dispatcher для Microsoft и Google. В provider-specific модулях остаются только URL, параметры, проверка ответа и нормализация ошибок.

### 3.3. Добавить маршруты

- `GET /oauth/google` — требует авторизованного пользователя MailExp, создаёт state/PKCE и перенаправляет в Google.
- `GET /oauth/google/callback` — одноразово проверяет state, обменивает code, проверяет identity и создаёт/обновляет Gmail-аккаунт.

При upsert использовать транзакцию и advisory lock по паре `userId + email`. Поля аккаунта:

- IMAP: `imap.gmail.com:993`, TLS;
- SMTP: `smtp.gmail.com:465`, TLS;
- `oauth_provider=google`;
- `include_in_unified_inbox=false`;
- токены и provider metadata — только в зашифрованном виде;
- существующий refresh token не затирается `null`.

### 3.4. Добавить конфигурацию интеграции

Расширить `/api/integrations` провайдером `google`, не возвращая client secret. Статус должен различать: не настроено администратором, готово к подключению, токен истёк и обновится, требуется повторное согласие.

**Commit:** `feat: add Google OAuth account connection`

## Task 4. Подключить refresh-токены ко всем IMAP/SMTP-путям

**Файлы:**

- Modify: `backend/src/services/imapManager.js`
- Modify: `backend/src/services/imapManager.test.js`
- Modify: `backend/src/services/smtpTransport.js`
- Modify: `backend/src/services/smtpTransport.test.js`
- Modify: `backend/src/routes/admin.js`
- Modify: `backend/src/routes/auth.js`
- Modify: `backend/src/routes/send.js`
- Test: OAuth и send route tests

### 4.1. Написать отрицательные тесты

Доказать тестами, что:

- истёкший Google access token обновляется до IMAP connect;
- истёкший Google access token обновляется до SMTP send;
- два параллельных запроса вызывают один refresh;
- обновлённые токены атомарно сохраняются и повторно читаются из БД;
- `invalid_grant` переводит аккаунт в reconnect-required, а не в бесконечный retry;
- Microsoft OAuth продолжает работать через тот же dispatcher;
- ни один admin/auth/send path не использует сырой истёкший token в обход token manager.

### 4.2. Использовать единый entry point

Перед созданием ImapFlow client или Nodemailer transport вызывать `ensureFreshOAuthAccount(account)`. Удалить прямой импорт Microsoft refresh из транспортных модулей. Generic password accounts не должны проходить через OAuth manager.

### 4.3. Регрессионная проверка

~~~bash
cd backend
npm test -- src/services/imapManager.test.js src/services/smtpTransport.test.js
npm test -- src/routes/oauth.refresh.test.js src/routes/oauth.google.test.js
npm test -- src/routes/send.reliability.test.js
npm test
npm run lint
~~~

**Commit:** `refactor: unify OAuth token refresh for mail transports`

## Task 5. Добавить Google OAuth в веб-панель

**Файлы:**

- Create: `frontend/src/components/GoogleIntegrationSection.jsx`
- Create: `frontend/src/utils/googleOAuth.js`
- Create: `frontend/src/utils/googleOAuth.test.js`
- Modify: `frontend/src/components/AdminPanel.jsx`
- Modify: `frontend/src/components/MailApp.jsx`
- Modify: `frontend/src/utils/api.js`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/ru.json`
- Modify: остальные locale JSON
- Modify: `frontend/src/locales/i18n.test.js`

### 5.1. Раздел администратора

Добавить конфигурацию Google client ID/secret и redirect URI по модели существующей Microsoft integration. Secret после сохранения не показывать; UI отображает только факт настройки и позволяет безопасно заменить/удалить конфигурацию.

### 5.2. Подключение Gmail пользователем

Добавить кнопку «Подключить Gmail», открывающую серверный `/oauth/google`. После callback показать один из предсказуемых результатов:

- ящик подключён;
- ящик уже существовал и обновлён;
- согласие отменено;
- state истёк или неверен;
- требуется повторная авторизация;
- интеграция не настроена администратором.

В UI не выводить сырые ответы Google и токены. Тексты добавить во все locale-файлы, чтобы i18n completeness test оставался зелёным.

### 5.3. Проверка

~~~bash
cd frontend
npm test
npm run lint
npm run build
~~~

Ручной smoke test в отдельном development Google Cloud Project: connect → список папок → чтение → отправка → перезапуск backend → повторная работа через refresh token → revoke в Google → понятный reconnect state.

**Commit:** `feat: add Gmail OAuth onboarding UI`

## Task 6. Подготовить production-конфигурацию и OAuth runbook

**Файлы:**

- Create: `.env.team.example`
- Create: `docs/operations/team-deployment.md`
- Create: `docs/operations/google-oauth.md`
- Modify: `.gitignore`
- Modify: `README.md`

### 6.1. Зафиксировать переменные окружения

Документировать без реальных секретов:

- Google client ID/secret и точный HTTPS redirect URI;
- encryption key;
- PostgreSQL/Redis URLs;
- allowed origin, cookie/security settings, public base URL;
- `IMAP_MAX_PERSISTENT_PER_HOST=15` как старт для теста, а не универсальный лимит;
- запрет публикации PostgreSQL и Redis наружу.

### 6.2. Описать Google Cloud настройку

Runbook должен включать:

1. отдельные projects для development и production;
2. OAuth consent screen и External audience;
3. точные scopes и обоснование restricted Gmail scope;
4. authorized redirect URIs без wildcard;
5. разницу между `Testing` и `In Production`;
6. план verification, privacy policy, domain verification и возможной security assessment/CASA;
7. процедуру revoke/delete account data;
8. ротацию client secret без потери уже сохранённых refresh tokens;
9. подключение волнами 10 → 25 → 50 → 100.

### 6.3. Проверить deployment

Развернуть чистый стенд из документации, создать `system-admin` и `team-mail`, отключить открытую регистрацию, подключить тестовый Gmail и выполнить backup/restore PostgreSQL вместе с проверкой encryption key.

**Commit:** `docs: add team deployment and Google OAuth runbooks`

## Task 7. Добавить постоянный фильтр почтовых ящиков

**Файлы:**

- Create: `frontend/src/utils/accountFilter.js`
- Create: `frontend/src/utils/accountFilter.test.js`
- Modify: `frontend/src/components/Sidebar.jsx`
- Modify: `frontend/src/store/index.js`
- Modify: locale JSON и i18n test

### 7.1. Зафиксировать поведение тестами

- Поиск без учёта регистра по имени и email.
- Пробелы в начале/конце игнорируются.
- Фильтр влияет только на список аккаунтов, но не меняет выбранный аккаунт.
- При отсутствии совпадений показывается пустое состояние.
- После очистки возвращается полный список.
- Строка фильтра хранится только в текущем браузере и не синхронизируется между менеджерами.

### 7.2. Реализовать минимальный UI

Добавить поле над списком аккаунтов, debounce не нужен до измерения. Не строить unified inbox и не загружать сообщения всех аккаунтов ради фильтра.

**Commit:** `feat: add mailbox list filter`

## Task 8. Добавить OAuth-aware состояние здоровья аккаунта

**Файлы:**

- Create: `backend/src/services/accountHealth.js`
- Create: `backend/src/services/accountHealth.test.js`
- Modify: `backend/src/routes/accounts.js`
- Create: `frontend/src/utils/accountHealth.js`
- Create: `frontend/src/utils/accountHealth.test.js`
- Modify: `frontend/src/components/Sidebar.jsx`
- Modify: locale JSON и i18n test

### 8.1. Стабильная backend-модель

Backend возвращает код, а не локализованный текст:

- `healthy`
- `stale`
- `failed`
- `oauth_reconnect_required`
- `disabled`

Приоритет: disabled → reconnect → failed → stale → healthy. Секреты, server stack и ответ провайдера наружу не возвращаются.

### 8.2. Отображение и действие

В Sidebar показать компактный индикатор. Для `oauth_reconnect_required` дать действие «Подключить заново», которое запускает тот же Google flow и обновляет существующий аккаунт под advisory lock.

**Commit:** `feat: show mailbox connection health`

## Task 9. Проверить OAuth и производительность на 100 Gmail

**Файлы:**

- Create: `scripts/check-account-health.mjs`
- Create: `scripts/check-account-health.test.mjs`
- Create: `docs/operations/gmail-scale-test.md`
- Update: `docs/operations/team-deployment.md`

### 9.1. Проверить OAuth lifecycle

На тестовых аккаунтах проверить:

- новый consent и повторный consent;
- refresh после истечения access token;
- сохранение refresh token при повторном callback без нового refresh token;
- revoke доступа в Google;
- смену client secret;
- рестарт/обновление контейнеров;
- отсутствие секретов в обычных и error-логах.

### 9.2. Нагрузочные волны

Подключать 10, 25, 50 и 100 аккаунтов. На каждой волне измерять:

- RAM/CPU backend, PostgreSQL и Redis;
- число persistent IMAP connections к Gmail;
- длину очереди и время первого sync;
- reconnect/backoff и provider errors;
- задержку списка ящиков и открытия отдельного inbox;
- отправку через каждый выбранный SMTP identity;
- поведение десяти параллельных браузерных сессий общего пользователя.

Начать с `IMAP_MAX_PERSISTENT_PER_HOST=15` и sync interval 60 секунд. Настройки менять только по данным волны и записывать причину.

### 9.3. Soak и восстановление

После успешной волны 100 провести не менее 24 часов спокойной эксплуатации. Затем выполнить контролируемый restart, backup/restore и повторную отправку/получение. Критерий приёмки — нет массового reconnect storm, потери токенов, дублирования аккаунтов или неограниченного роста памяти.

**Commit:** `test: validate Gmail OAuth scale profile`

## Общий финальный gate MVP

~~~bash
cd backend
npm ci
npm test
npm run lint
npm run lint:plugins
npm run audit:redos
npm outdated
npm audit

cd ../frontend
npm ci
npm test
npm run lint
npm run build
npm outdated
npm audit
~~~

Дополнительно вручную проверить: вход общего пользователя в двух браузерах, подключение Gmail через OAuth, выбор разных ящиков, чтение, ответ, новое письмо, вложение, refresh после перезапуска, revoke/reconnect, фильтр из 100 ящиков и отсутствие общего inbox.

## Что не входит в этот план

- Разные пользователи и права менеджеров.
- Атрибуция почтовых действий конкретному менеджеру.
- Общая лента сообщений всех аккаунтов.
- Создание доменных адресов и arbitrary local-part.
- Postfix/Dovecot, входящая доставка и Microsoft EOP.
- Выбор отдельного сервера/чистого IP для будущего EOP-контура.

После стабилизации Gmail MVP эти пункты оформляются отдельным архитектурным этапом, не смешанным с OAuth и обновлением MailExp.
