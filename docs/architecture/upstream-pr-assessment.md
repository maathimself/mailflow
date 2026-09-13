# Анализ открытых PR upstream MailFlow

## Снимок

- Источник: `maathimself/mailflow`, открытые pull request на 13 сентября 2026 года.
- Целевая ветка MailExpert: `codex/mailexpert-bootstrap`, база `543a049cd085306af095a5e244a26722544432af`.
- Всего рассмотрено 20 открытых PR.
- Upstream ранее переписал историю `main`, поэтому у веток PR нет общего Git merge-base с текущей веткой. Статус GitHub `MERGEABLE` означает только результат серверного пробного слияния, а не безопасный перенос истории в MailExpert.
- В MailExpert перенесены только два небольших исправления с зелёным CI, чисто применимым патчем и непосредственной пользой для IMAP-клиента: #425 и #420.

## Итоговая таблица

| PR | Объём | Состояние на момент анализа | Значение для MailExpert | Решение |
| --- | ---: | --- | --- | --- |
| [#439 Template Builder](https://github.com/maathimself/mailflow/pull/439) | +5758/−104, 46 файлов | Behind | Большой самостоятельный plugin, не нужен Gmail/EOP MVP | Отложить |
| [#430 Attachment-only body](https://github.com/maathimself/mailflow/pull/430) | +46/−4, 2 файла | Conflicting, CI failed | Полезное исправление отображения писем только с вложением | Не переносить сейчас; дождаться зелёного исправленного патча или воспроизвести тестом |
| [#426 Background rules](https://github.com/maathimself/mailflow/pull/426) | +169/−13, 13 файлов | Behind | Может уменьшить задержки inbox rules, но меняет фоновые процессы | Отложить до нагрузочных измерений |
| [#425 Named text attachments](https://github.com/maathimself/mailflow/pull/425) | +151/−21, 4 файла | Mergeable, CI passed | Исправляет потерю `.html`/`.txt`-вложений, размеченных inline | **Перенесён**, commit MailExpert `df5851e` |
| [#422 Nginx base override](https://github.com/maathimself/mailflow/pull/422) | +15/−1, 3 файла | Mergeable, CI passed | Нужен в основном старым NAS/kernel с несовместимым Alpine | Не нужен целевому Ubuntu 24.04; оставить доступным при появлении такого хоста |
| [#421 Search error feedback](https://github.com/maathimself/mailflow/pull/421) | +41/−7, 11 файлов | Mergeable, CI passed | Улучшает UX, но одновременно меняет rate limit 20→60/мин | Отдельный продуктовый PR после базового bootstrap |
| [#420 Real folder path](https://github.com/maathimself/mailflow/pull/420) | +106/−16, 3 файла | Mergeable, CI passed | Исправляет создание папок на IMAP с namespace и нестандартным delimiter | **Перенесён**, commit MailExpert `72cf470` |
| [#419 Subfolder input](https://github.com/maathimself/mailflow/pull/419) | +13/−6, 1 файл | Behind | Парный UI-fix к созданию подпапок | Проверить вручную после #420; переносить только при воспроизводимом дефекте |
| [#414 Rule destination paths](https://github.com/maathimself/mailflow/pull/414) | +220/−33, 8 файлов | Conflicting | Удобство выбора вложенных папок в правилах | Отложить |
| [#411 Hover-scroll move picker](https://github.com/maathimself/mailflow/pull/411) | +243/−29, 7 файлов | Conflicting | Косметика длинных путей папок | Отложить |
| [#410 Full folder paths](https://github.com/maathimself/mailflow/pull/410) | +199/−29, 7 файлов | Conflicting | Улучшает поиск папки перемещения | Отложить; пересекается с #411/#414 |
| [#388 ML antispam](https://github.com/maathimself/mailflow/pull/388) | +5387/−37, 44 файла | Conflicting | Большая новая подсистема, не относится к MVP | Не переносить |
| [#373 GTD delegation UI](https://github.com/maathimself/mailflow/pull/373) | +3603/−113, 74 файла | Conflicting | GTD-функции вне текущего сценария | Не переносить |
| [#372 GTD delegation API](https://github.com/maathimself/mailflow/pull/372) | +2455/−100, 46 файлов | Conflicting | API для той же необязательной подсистемы | Не переносить |
| [#371 GTD indicators](https://github.com/maathimself/mailflow/pull/371) | +856/−13, 23 файла | Behind | Индикаторы GTD вне MVP | Не переносить |
| [#359 Google OAuth](https://github.com/maathimself/mailflow/pull/359) | +844/−44, 16 файлов | Conflicting, review required | Прямо относится к Gmail, но основан на старой истории и требует усиления протокола | Не сливать; перенести идеи новой реализацией на current main |
| [#352 MCP compose sessions](https://github.com/maathimself/mailflow/pull/352) | +64523/−6143, 350 файлов | Conflicting | Почти самостоятельная перестройка проекта | Не переносить |
| [#332 Theme-aware bodies](https://github.com/maathimself/mailflow/pull/332) | +10010/−450, 123 файла | Conflicting | Большое изменение рендера писем с высоким риском | Не переносить |
| [#331 Sidebar shortcut](https://github.com/maathimself/mailflow/pull/331) | +70/−4, 13 файлов | Conflicting | Небольшое UX-улучшение, не приоритет MVP | Отложить |
| [#317 Conversation reading pane](https://github.com/maathimself/mailflow/pull/317) | +2179/−1060, 40 файлов | Conflicting | Крупное изменение интерфейса чтения | Не переносить |
| [#294 Weighted FTS bodies](https://github.com/maathimself/mailflow/pull/294) | +2509/−390, 26 файлов | Conflicting | Потенциально полезный поиск, но миграции/индексация требуют отдельной оценки | Отложить до нагрузочного профиля |

## Что фактически перенесено

### PR #425 — текстовые файлы с inline disposition

Проблема: именованный `text/plain` или `text/html` MIME-part мог поглощаться как дополнительное тело письма и исчезать из списка вложений.

Перенесён оригинальный upstream commit с сохранением автора. Изменение:

- классифицирует именованные текстовые части как вложения, когда у письма есть отдельная безымянная текстовая часть для тела;
- синхронизирует эту логику с индикатором вложения;
- добавляет тесты `walkStructure` и отдельный `messageParser.attachments.test.js`.

### PR #420 — реальные пути IMAP-папок

Проблема: создание папки локально собирало предполагаемый путь, который мог не совпасть с серверным namespace/delimiter. В результате в базе появлялась папка, которой не было по записанному пути на IMAP-сервере.

Перенесён оригинальный upstream commit с сохранением автора. Изменение:

- использует существующий `ensureFolder`;
- сохраняет фактически возвращённый сервером путь;
- сохраняет delimiter аккаунта;
- добавляет route-тесты для prefixed namespace, root folder и IMAP failure.

Оба коммита прошли полный набор MailExpert-проверок вместе с ребрендингом: backend 1345/1345, frontend 1866/1866, backend/frontend ESLint, plugin-boundary lint и production build на Node 22.

## Почему Google OAuth PR #359 не переносится напрямую

PR содержит полезный рабочий набросок:

- Google authorization и callback endpoints;
- проверку ID token через `jose`;
- шифрованное хранение refresh/access token;
- advisory lock при добавлении аккаунта;
- дедупликацию обновления access token;
- UI подключения Google и тексты локализации.

Но прямой merge/cherry-pick неприемлем:

1. PR конфликтует с текущим `main` и не имеет с ним общего merge-base после переписывания истории.
2. Google-логика добавлена крупными блоками в уже перегруженные `oauth.js` и `AdminPanel.jsx`.
3. Нет PKCE S256.
4. Pending OAuth state держится только в session state без отдельного ограниченного TTL-хранилища.
5. Проверка `email_verified` допускает значение, отличное от явного `false`; новая реализация должна принимать только `true`.
6. Refresh нужно объединить для IMAP и SMTP в provider-neutral token manager, а не размножать условные ветки.
7. Для сценария MailExpert новый Gmail должен по умолчанию получать `include_in_unified_inbox=false`.

Решение: реализовать Google provider заново поверх текущей ветки, используя PR #359 как анализ поведения, а не как источник для слепого копирования.

## Результат security-review PR #359

Выполнен полный diff scan между исходной базой PR и его head:

- Scan ID: `5bccec30-0d52-4fb1-a005-9f97a6495fc0`.
- Диапазон: `128816eb0e90de1c513be51f967732e3edcaea69` → `cd06efaa1d3c199e89d651aacd0cb62ee8064338`.
- Проверено 15 изменённых исходных файлов и `.env.example`.
- Подтверждённых reportable security vulnerabilities: 0.
- Missing PKCE и fail-open форма `email_verified` классифицированы как hardening/design gaps без подтверждённого практического exploit в указанной confidential web-client модели. Это не отменяет их обязательного исправления в MailExpert.

Локальный отчёт сканирования не входит в Git-репозиторий и указан в `agent-changes/2026-09-13-mailexpert-bootstrap.md`.

## Правило дальнейшего переноса upstream PR

Для каждого PR:

1. Проверить назначение и связанный issue, объём, CI, review state и конфликтность.
2. Проверить raw patch через `git apply --check`, потому что merge-base отсутствует.
3. Переносить отдельным commit с сохранением исходного автора.
4. Не объединять продуктовые изменения с dependency/OAuth foundation.
5. Запустить затронутые тесты, затем полный backend/frontend gate.
6. Зафиксировать источник, расхождения и решение в этом документе.
