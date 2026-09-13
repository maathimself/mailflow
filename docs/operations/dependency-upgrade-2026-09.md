# Обновление зависимостей MailExpert — сентябрь 2026

Контролируемое обновление всех зависимостей до актуальных major-версий как основа для Google OAuth.

## Backend

Ветка `chore/backend-deps-2026-09`, база — `main` 7a6ab4b. Исходная линия была зелёной: 76 test-файлов / 1355 тестов, `lint` и `lint:plugins` чистые, `npm audit` — 1 moderate (`qs`, транзитивно через Express 4).

### Версии

| Пакет | Было | Стало | Тип |
| --- | --- | --- | --- |
| imapflow | 1.7.8 | 2.0.2 | major |
| nodemailer | 9.1.1 | 10.0.9 | major |
| express | 4.22.1 | 5.2.1 | major |
| express-async-errors | 3.1.1 | удалён | — |
| connect-redis | 7.1.1 | 10.0.0 | major |
| redis | 4.7.1 | 6.2.1 | major |
| dotenv | 16.6.1 | 17.4.2 | major |
| express-session | 1.19.0 | 1.19.0 | поднят нижний диапазон `^1.19.0` |
| cors | 2.8.6 | 2.8.6 | поднят нижний диапазон `^2.8.6` |
| bcryptjs | 2.4.3 | 3.0.3 | major |
| otplib | 12.0.1 | 13.5.0 | major |
| archiver | 7.0.1 | 8.0.0 | major |
| htmlparser2 | 10.1.0 | 12.0.0 | major |
| undici | 6.28.0 | 8.10.2 | major |
| fast-xml-parser | 5.10.1 | 5.11.1 | minor |
| jose | 6.2.3 | 6.2.12 | patch |
| pg | 8.20.0 | 8.23.0 | minor |
| ws | 8.21.0 | 8.21.3 | patch |
| qrcode / sanitize-html / web-push | 1.5.4 / 2.17.7 / 3.6.7 | без изменений | поднят нижний диапазон |
| vitest | 4.1.11 | 5.0.0 | major, dev |
| eslint | 10.4.1 | 10.10.0 | minor, dev |
| globals | 17.6.0 | 17.12.0 | minor, dev |
| @eslint/js | 10.0.1 | 10.0.1 | актуален, dev |

### Миграционные решения

- **ImapFlow 2 и Nodemailer 10.** Оба пакета переписаны на TypeScript; единственный breaking change — Node.js ≥ 20 и отказ от `lib/`. Глубоких импортов в MailExpert нет, набор опций ImapFlow между 1.7.8 и 2.0.2 совпадает, логика XOAUTH2/OAUTHBEARER перенесена без изменений, токен помечен `sensitive`, у клиентов `logger: false`. Кода менять не пришлось. Проверено живым прогоном против GreenMail: SMTPS с `envelope` и вложением, IMAPS `fetch` (envelope, bodyStructure, source, flags), `download` части, `status`, `list`, `logout` с событием `close`.
- **Express 5.** Удалены импорт и зависимость `express-async-errors` — Express 5 сам передаёт отклонённые async-обработчики в error middleware. `router.options('*')` в CardDAV заменён на `'/{*path}'` (path-to-regexp 8 не принимает безымянный `*`). Express 5 оставляет `req.body` равным `undefined`, если парсер тела не сработал, а десятки обработчиков деструктурируют `req.body` напрямую (например, `POST /api/mail/sync` без тела). Контракт Express 4 восстановлен одной middleware `defaultEmptyBody` сразу после `express.json()` — это код приложения, а не патч библиотеки. Парсер query в Express 5 по умолчанию `simple`: фронтенд шлёт только плоские параметры, поэтому менять ничего не пришлось.
- **connect-redis 10 и redis 6.** Импорт стал именованным: `import { RedisStore }`. TTL сессии по-прежнему берётся из `cookie.expires`, живой прогон показал `TTL sess:* = 604800` (7 дней). В redis 5+ курсор `SCAN` — строка: `destroyUserSessions` сравнивал его с числом `0` и после обновления зациклился бы на каждом сбросе пароля. Курсор переведён на строку, добавлен тест. Graceful shutdown вызывает `redisClient.close()` вместо устаревшего `quit()`, SIGTERM на Node 22 завершает процесс с кодом 0. Опции `set` с `NX`/`EX`, `pExpire`/`pTTL`/`incr` в redis 6 работают без изменений — проверено против Redis 7.
- **dotenv 17.** Пакет по умолчанию пишет в stdout строку с рекламной подсказкой на каждом старте. `import 'dotenv/config'` заменён на `src/loadEnv.js` с `config({ quiet: true })`; порядок загрузки env относительно `redis.js` сохранён.
- **otplib 13.** Полностью переписанный API: `authenticator` удалён, `verify` стал асинхронным, возвращает объект и бросает исключения на токенах неверного формата и секретах короче 16 байт. Добавлен адаптер `src/services/totp.js` (`generateTotpSecret`, `totpKeyUri`, `verifyTotp`): сохраняет политику 12-й версии (6 цифр, шаг 30 с, без окна дрейфа), на некорректный ввод отвечает `false` вместо 500 и принимает старые 10-байтовые секреты — это дефолт `authenticator.generateSecret()` в otplib 12 — через `createGuardrails({ MIN_SECRET_BYTES: 10 })`. Новые секреты по-прежнему 20 байт. Тесты сверяют вектор RFC 6238 и код, сгенерированный otplib 12.
- **bcryptjs 3.** Новые хеши получают префикс `$2b$`, существующие `$2a$` проверяются. Кода менять не пришлось; добавлен тест совместимости с хешем от bcryptjs 2.
- **archiver 8.** Пакет стал ESM-only и больше не экспортирует фабрику: `createRequire` + `archiver('zip', …)` заменены на `new ZipArchive({ zlib: { level: 6 } })`. Добавлен тест, который разбирает получившийся ZIP.
- **htmlparser2 12.** Парсер HTML приведён к WHATWG: содержимое `<iframe>`, `<noembed>` и `<noframes>` теперь raw text, и fallback-разметка попадала бы в сниппет как есть. Эти теги добавлены в `SNIPPET_SKIP_TAGS`, браузер их содержимое тоже не показывает. `<textarea>` теперь декодирует сущности. Оба случая покрыты тестами.
- **undici 8.** undici 8 убрал обёртки для legacy-обработчиков, а встроенный `fetch` в Node 22 (undici 6.28) передаёт диспетчеру именно их: с `Agent` из undici 8 все запросы `safeFetch` падали с `UND_ERR_INVALID_ARG` — существующие тесты это ловят. `safeFetch` теперь использует парный `fetch` из того же пакета undici. Проверено на Node 22 и 24: локальный HTTP, редирект, блокировка приватного IP, POST-тело, публичный HTTPS и таймаут через `AbortSignal`. HTTP/2, включённый в undici 8 по умолчанию, не согласуется: собственный коннектор построен без `allowH2`.
- **vitest 5, eslint, globals.** Изменений в конфигурации и тестах не потребовалось.
- **overrides.** Оба оставлены как нижняя граница безопасности. `brace-expansion ^5.0.8` добавляли, чтобы поднять поддерево archiver 7 до исправленного major. С archiver 8 единственный потребитель — `minimatch@10`, у которого диапазон `^5.0.5` всё ещё допускает уязвимые 5.0.5–5.0.7. `postcss ^8.5.23`: у `sanitize-html` диапазон `^8.3.11`, он тоже допускает уязвимые версии. Новых overrides нет.

### Исключения

Нет: все пакеты подняты до последних major-версий, и `npm outdated` после обновления пуст.

### Остаточные риски `npm audit`

`npm audit` (вместе с dev-зависимостями) — 0 уязвимостей. `npm audit --omit=dev --audit-level=high` — 0. Уязвимость `qs` из исходной линии ушла вместе с Express 4.

Замечания без изменения поведения:

- `engines` остался `>=22 <23`, но undici 8 требует Node ≥ 22.19, а vitest 5 — ≥ 22.12. Docker-образы `node:22-alpine` и CI уже новее; на Node 22.0–22.18 `npm ci` выдаст только `EBADENGINE`-предупреждение.
- `commandTimeout: 30000` в `makeClientCfg` не является опцией ImapFlow ни в 1.x, ни в 2.x и ничего не делает; реальный параметр — `socketTimeout`. Это существовало и до обновления, в эту ветку исправление не включено.
- Некорректный JSON в теле по-прежнему отдаёт 500 вместо 400: общий обработчик ошибок игнорирует `err.status`. Поведение совпадает с Express 4.

### Gate на Node 22 в Docker

Команда из корня worktree: `git archive HEAD | docker run --rm -i node:22-bookworm-slim sh -c '… npm ci && npm run lint && npm run lint:plugins && node --check src/index.js && npm test && npm audit --omit=dev --audit-level=high'`.

- Node v22.23.2, npm 10.9.8; `npm ci` — 363 пакета, 0 уязвимостей.
- `lint`, `lint:plugins`, `node --check src/index.js` — без ошибок.
- `npm test` (vitest 5.0.0) — 81 test-файл, 1374 теста, все зелёные.
- `npm audit --omit=dev --audit-level=high` — 0 уязвимостей; код выхода 0.
- Дополнительно на хосте: `npm run audit:redos` — чисто.

Живой smoke на Node 22 с PostgreSQL 16 и Redis 7 совпадает с исходной линией по всем проверкам. Проверялись: старт с 51 миграцией, `/api/health`, `/api/version`, регистрация и `me` с cookie сессии, выход, 404, 413 на крупное тело, `POST /api/mail/sync` без тела, CardDAV OPTIONS, `.well-known` → 308, TTL сессии 604800 и SIGTERM с кодом выхода 0.

## Frontend

Ветка `chore/frontend-deps-2026-09` от `main` 7a6ab4b. Каждая группа обновлялась отдельным коммитом, после каждой проверялись `npm test`, `npm run lint` и `npm run build`.

### Исходное состояние

- `npm test` — 1866 тестов, все проходят.
- `npm run lint` — без ошибок и предупреждений.
- `npm run build` — сборка успешна, Vite предупреждает о чанках больше 500 kB: `ComposeModal` 558 kB, `index` 689 kB, `store` 733 kB.
- `npm audit` — 2 moderate в `react-router` / `react-router-dom` 6.30.6 (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg).

### Версии

| Пакет | Было | Стало |
|---|---|---|
| react, react-dom | 18.3.1 | 19.3.0 |
| react-router-dom | 6.30.6 | удалён, заменён на `react-router` |
| react-router | 6.30.6 (транзитивно) | 7.18.3 |
| zustand | 4.5.7 | 5.0.15 |
| date-fns | 3.6.0 | 4.4.0 |
| @emoji-mart/react | 1.1.1 | удалён |
| emoji-mart | 5.6.0 (транзитивно) | 5.6.0 (прямая зависимость) |
| @capacitor/android, core, cli | 8.3.4 | 8.5.2 |
| dompurify | 3.4.13 | 3.4.15 |
| i18next | 26.0.8 | 26.4.2 |
| react-i18next | 17.0.6 | 17.0.14 |
| marked | 18.0.6 | 18.0.13 |
| postcss | 8.5.26 | 8.5.28 |
| autoprefixer | 10.5.0 | удалён (Tailwind 4 сам добавляет префиксы) |
| tailwindcss | 3.4.19 | 4.3.3 |
| @tailwindcss/vite | — | 4.3.3 |
| vite | 8.1.5 | 8.3.0 |
| @vitejs/plugin-react | 6.0.3 | 6.1.1 |
| eslint | 10.7.0 | 10.10.0 |
| globals | 17.7.0 | 17.12.0 |
| electron | 42.8.1 | 44.3.0 |
| electron-builder | 26.15.3 | 26.15.3 (диапазон поднят до `^26.15.3`) |

Без изменений, уже последние версии: `@tiptap/*` 3.31.3, `@emoji-mart/data` 1.2.1, `@eslint/js` 10.0.1, `eslint-plugin-react-hooks` 7.1.1, `jsdom` 30.0.1.

### Решения по миграции

**React 19.** `ReactDOM.render`, string refs, `defaultProps` у функций, `propTypes`, legacy context и классовых компонентов в коде нет, точка входа уже на `createRoot`. `forwardRef` в `ComposeModal` устарел, но работает. Хук `useWebSocket` при каждом монтировании заново выставляет `mountedRef`, поэтому двойные эффекты StrictMode ему не мешают. Единственный блокер — `@emoji-mart/react` 1.1.1: его peer-диапазон заканчивается на React 18, и `npm ci` падает с ERESOLVE. `overrides` peer-диапазон не меняют, а `legacy-peer-deps` ослабил бы проверку во всём проекте. Поэтому обёртку заменили своим компонентом `src/components/EmojiPicker.jsx`. Он построен на публичном `Picker` из `emoji-mart`, логика жизненного цикла вынесена в `src/utils/emojiPicker.js`. Отличия от старой обёртки: `update()` вызывается в эффекте, а не во время рендера, и при размонтировании элемент picker удаляется. Отдельный lazy-чанк `EmojiPicker` в сборке сохранился. Тест `src/utils/emojiPicker.test.js` проверяет монтирование, обновление props, размонтирование и StrictMode.

**React Router 7.** Роутер используют только `main.jsx` (`BrowserRouter`) и `App.jsx` (`Routes`, `Route`, `Navigate`). Импорты переведены на пакет `react-router`, как рекомендует документация v7, а `react-router-dom` удалён из зависимостей. Таблица маршрутов не менялась: `/login`, `/register`, `/*`. OAuth-callback (`?oauth_success` / `?oauth_error`), deep link `?m=` и `?reset_token=` читаются из `window.location` ещё до рендера маршрутов, поэтому их поведение осталось прежним. Future-флаги v6 в проекте не включались. Их поведение касается относительных ссылок в splat-маршрутах, `startTransition` и fetchers, а `Link`, `useNavigate` и вложенных `Routes` в коде нет. Отдельной проверкой в jsdom подтверждено: редиректы `Navigate replace` не добавляют записей в историю, `/register?invite=` сохраняется, прямые `history.pushState` в `MailApp` и `popstate` работают как раньше. После обновления `npm audit` не показывает уязвимостей в React Router.

**Zustand 5.** Импорт `create` не менялся, `equalityFn` и `zustand/shallow` в коде не используются. Zustand 5 сравнивает результат селектора по ссылке через `useSyncExternalStore`. Два селектора — `ContextMenu.jsx` и `MessagePane.jsx` — возвращали `s.folders[id] || []`, то есть новый массив при каждом вызове. В zustand 5 это даёт бесконечный цикл: «Maximum update depth exceeded», проверено отдельно. Оба переведены на `selectAccountFolders(s, accountId)` в `store/index.js` с общим замороженным пустым массивом. `useShallow` не понадобился. Тест: `src/store/accountFolders.test.js`.

**date-fns 4.** Функции `format`, `isToday`, `isYesterday` и `isThisYear` и токены форматов не изменились. Добавлен тест `src/utils/formatDate.test.js`.

**Electron 44.** Изучены breaking changes 43 и 44. Код затрагивает одно изменение: `clipboard.writeText()` в main-процессе теперь возвращает Promise. Запись идёт через `packages/electron/clipboardText.cjs`: помощник дожидается записи и возвращает признак успеха. Действие «скопировать команду установки и выйти» (Linux-обновление) закрывает приложение только после успешной записи. При ошибке возвращается `{ copied: false, reason: 'clipboard-failed' }`. Тест: `packages/electron/clipboardText.test.cjs`. Остальные изменения на код не влияют. Clipboard в renderer не используется: там `navigator.clipboard`, а окна с `sandbox: true`. Frameless-окон нет, `select-client-certificate`, `net.request`, login items и `app.isUnityRunning()` не используются. Unity-бейдж отправляется через `gdbus`, это не зависит от Electron. Electron 44 не поддерживает macOS 12, Windows ia32 и Linux armv7l. Цели сборки MailExpert (Windows x64, macOS universal, Linux x64/arm64) это не затрагивает, но минимальная версия macOS для desktop-приложения теперь 13.

**Tailwind 4.** Utility-классы Tailwind в разметке не используются, все 62 `className` — собственные классы из `index.css`. Tailwind даёт только Preflight и несколько случайных utility из строк в коде, как и в v3. Официальный `npx @tailwindcss/upgrade` упал на шаге разрешения `tailwindcss`, но успел переписать `index.css`. В его варианте был `@theme { --font-sans: var(--font-sans), ... }` — ссылка переменной на саму себя, ведь `fonts.js` выставляет те же `--font-sans` / `--font-mono` на `<html>`. Изменения инструмента откатили и повторили миграцию вручную:
- `@import 'tailwindcss'` вместо трёх `@tailwind`;
- плагин `@tailwindcss/vite` в `vite.config.js`, `postcss.config.js` и `tailwind.config.js` удалены, `autoprefixer` удалён;
- `@theme` со статическими значениями `--font-sans: 'DM Sans'` и `--font-mono: 'JetBrains Mono'`, как fallback из старого конфига. `--font-display` Tailwind не использует, он не нужен;
- блок совместимости из официального руководства, чтобы сохранить поведение Preflight v3: цвет рамки по умолчанию gray-200, цвет placeholder gray-400, `cursor: pointer` у кнопок.

Пакет `postcss` остался: его использует `src/utils/scopeEmailCss.js`. Итоговый CSS: 21.6 kB → 26.3 kB. Страницу входа сравнили в браузере — исходный CSS v3 против нового v4 на той же сборке. Позиции и размеры элементов, шрифты, цвета, радиусы и курсор совпали.

Места с видимым риском, которые не покрыты визуальными тестами:
- Preflight v4 сбрасывает `margin`/`padding` у всех элементов и задаёт `border-radius: 0` и прозрачный фон для `input`, `select` и `textarea`. Поля без явного inline-фона станут прозрачными вместо белых.
- `ol`, `ul`, `menu` без маркеров, `img`/`svg`/`video` — `display: block`. Так было и в v3.
- Utility `ring` теперь 1px и `currentcolor`, а не 3px синего цвета. `shrink` и `!visible` исчезли, появилась `row-0`. Эти классы в разметке не встречаются.
- Минимальные браузеры Tailwind 4: Chrome 111, Safari 16.4, Firefox 128. Preflight лежит в `@layer`, поэтому Android System WebView старше Chrome 99 не применит его вовсе. Для Capacitor-оболочки на устаревших WebView это видимый риск. Electron 44 не затронут.

### Исключения

- **React Router 8.3.1** — есть в npm, но задача ограничена v7. Для v8 нужны Node ≥ 22.22 и React ≥ 19.2.7. Оставлен на отдельное решение.
- **@emoji-mart/react** — пакет не поддерживает React 19 и заменён собственным компонентом, подробности выше. `overrides` и `legacy-peer-deps` не добавлялись.

### Остаточные риски npm audit

- `npm audit --omit=dev --audit-level=high` — 0 уязвимостей.
- Полный `npm audit` — 3 moderate в dev-цепочке `@capacitor/cli` 8.5.x → `xcode` 3.0.1 → `uuid` 7.0.3 (GHSA-w5hq-g745-h8pq). npm предлагает откат `@capacitor/cli` до 8.4.3 через `--force`. Не исправлялось: пакет только для разработки, `xcode` нужен для iOS-проектов, а их в MailExpert нет. Уязвимость срабатывает только при передаче `buf` в `uuid` v3/v5/v6, а `xcode` вызывает `uuid.v4()` без буфера. `overrides` не добавлялись.

### Чанки Vite

Предупреждение о чанках больше 500 kB осталось и сознательно не исправлялось: `ComposeModal` 559 kB, `index` 790 kB (было 689 kB — выросли React DOM 19 и Router 7), `store` 732 kB.

### Проверки

- Локально (Windows, Node 24.19.0 / npm 11.17.0): после чистого `npm ci` — `npm test` 1879 из 1879, `npm run lint` без ошибок и предупреждений, `npm run build` успешен.
- Docker Node 22 gate: `node:22-bookworm-slim` (Node 22.23.2, npm 10.9.8) на `git archive HEAD` — `npm ci`, `npm run lint`, `npm run build`, `npm test` (1879 из 1879), `npm audit --omit=dev --audit-level=high` (0 уязвимостей). Код выхода 0.
- Дополнительно `node:22-alpine`, как в `frontend/Dockerfile`: `npm ci` и `npm run build` проходят, нативные бинарники Tailwind/lightningcss для musl есть в lockfile.
- Android Gradle на этом хосте не запускался: нет Android SDK. `packages/android/variables.gradle` (compile/target SDK 36, min SDK 24) совпадает со значениями по умолчанию в Capacitor 8.5.2, но реальная сборка APK не проверена.
- Бинарник Electron 44 не скачивался (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`): изменения main-процесса проверены статически, `node --check` и unit-тестами.
