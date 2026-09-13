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
