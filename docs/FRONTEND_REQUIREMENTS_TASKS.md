# Frontend: Рекомендации, Требования и Задачи (YAM Web)

## Назначение

Этот документ фиксирует, что должен делать фронтенд (`apps/web`), как это должно быть реализовано, и какие задачи нужно выполнить для выхода в production-ready состояние при highload.

Документ можно использовать как рабочий backlog для FE-команды и как чеклист приемки.

## Цели фронтенда

- Дать быстрый и предсказуемый UX для realtime-мессенджера.
- Сохранить корректность состояния при reconnect, out-of-order и дублирующихся WS-событиях.
- Обеспечить безопасность клиентского слоя (auth, хранение токенов, обработка приватных данных).
- Поддерживать масштабируемость UI (большие списки чатов/сообщений, медиа, высокая частота событий).

## Функциональные требования (MVP)

### Auth и профиль

- [x] Вход по телефону + OTP.
- [x] Обновление токенов (access/refresh) без разлогина в штатных сценариях.
- [x] Редактирование профиля (`displayName`, `username`, `avatar`, `status`, приватность профиля).
- [x] Корректная обработка статуса бана (`403 Account suspended`) во всех точках.

### Чаты

- [x] Список чатов с последним сообщением, unread, pin/mute.
- [x] Создание direct-чата и group-чата.
- [x] Управление группой: добавить/удалить участника, смена роли, transfer ownership, leave.
- [x] Детальный экран чата: участники, настройки, история.

### Сообщения и медиа

- [x] Отправка/получение сообщений (text/media/document/voice).
- [x] Редактирование и удаление сообщений (с undo-snackbar для удаления).
- [x] Статусы доставки и чтения (sent/delivered/read).
- [x] Загрузка файлов и предпросмотр вложений (images, files, voice).
- [x] Голосовые сообщения: запись, визуализация waveform, воспроизведение.

### Realtime

- [x] Обмен событиями через WebSocket (auth event, не token в URL).
- [x] Presence (online/offline/lastSeen), typing indicators.
- [x] Поддержка reconnect с восстановлением состояния (inbox + active chat invalidation).

## Нефункциональные требования

- Время первой интерактивности главного экрана: целевой p95 <= 3s на среднем устройстве.
- [x] Скролл списка сообщений: без визуальных фризов на длинной истории (виртуализация реализована).
- [x] UI должен быть идемпотентным к повторам WS-событий (bounded eventId dedup).
- [x] Все пользовательские действия должны иметь явные loading/error/success состояния.
- [x] Ошибки API/WS должны быть единообразно обработаны и логироваться.

## Рекомендации по архитектуре фронтенда

### 1) State management — DONE

- [x] Разделение: server state (TanStack Query) + realtime/ephemeral state (Zustand `chat.ts`) + auth state (Zustand `auth.ts`).
- [x] Обновления от WS применяются через нормализованный слой (`useWebSocket` → Zustand actions по `chatId`/`messageId`).
- [x] Optimistic updates с rollback (pin/mute, message send/edit/delete).

### 2) Слой API и контракты — DONE

- [x] Все вызовы API через **Eden Treaty** (`@elysiajs/eden`).
- [x] Тип `App` импортируется из `@yam/api` (type-only import) для E2E type safety.
- [x] Кастомный `fetcher` с Bearer token injection и автоматический refresh при 401.
- [x] Функция `eden()` разворачивает `{ data, error }`, выбрасывает `AppError`.
- [x] Перехват бана (`ACCOUNT_SUSPENDED`) и автоматический logout при 401.

### 3) Realtime-слой — DONE

- [x] Одна WS-сессия на пользователя.
- [x] Reconnect с exponential backoff + jitter.
- [x] После reconnect: invalidation inbox + active chat messages.
- [x] Token refresh attempt при `AUTH_FAILED` (max 2 retries before logout).

### 4) Security — DONE

- [x] Токены не логируются.
- [x] Централизованный перехват `401/403` и бан-статус.
- [x] Клиентская валидация размеров/типа файлов до отправки.
- [x] localStorage хранит только access/refresh tokens (minimal footprint).

### 5) Performance — DONE

- [x] Виртуализированные списки сообщений (`@tanstack/react-virtual`).
- [x] `useDeferredValue` для sidebar search debounce.
- [x] Memoization: `MessageBubble` (memo), stable callbacks (`useCallback`).
- [x] Throttled scroll handler, throttled presence refresh.

### 6) Observability — PARTIAL

- [x] Global `ErrorBoundary` component.
- [ ] Клиентские метрики: WS reconnect count, send latency, upload rate.
- [ ] Structured FE error telemetry (unhandled promise rejections → reporting).

### 7) Тестирование — NOT STARTED

- [ ] Unit: store reducers/selectors, event reducers, helpers.
- [ ] Integration: send/edit/delete message flow, pin/mute, reconnect.
- [ ] E2E smoke: login -> chat list -> send message -> receive message -> logout.

## Контракты и ожидания от backend (критично для FE)

- [x] Endpoint-ы: `/api/auth/*`, `/api/users/*`, `/api/chats/*`, `/api/chats/:id/messages`, `/api/messages/:id`, `/api/files/*`, `/api/devices/*`
- [x] WS события сервера: `auth:ok`, `message:new`, `message:ack`, `message:updated`, `message:deleted`, `message:status`, `chat:updated`, `presence`, `typing`, `pong`, `error`
- [x] WS события клиента: `auth`, `message:send`, `message:edit`, `message:delete`, `message:read`, `typing:start`, `typing:stop`, `ping`
- [x] Ошибки WS/API имеют стабильные `code` и `message` (BE: `ErrorPayload` type)

## Приоритизированный backlog задач для фронтенда

## P0 (блокеры релиза) — ALL DONE

- [x] Единый error-handling слой для REST + WS (`AppError` + `eden()` + WS `ErrorPayload`).
- [x] Production-полный flow edit/delete message через WS + REST fallback.
- [x] Deterministic ресинхронизация после reconnect (inbox, active chat, unread, statuses).
- [x] Rollback для optimistic мутаций (pin/mute/profile/message ops).
- [ ] Smoke e2e сценарий критического пути.

## P1 (следующий спринт) — MOSTLY DONE

- [ ] Клиентские performance метрики + ошибки в telemetry.
- [x] UX загрузок: валидация, ошибки в UI, блокировка отправки при загрузке, confirm для failed.
- [x] Stores разделены: auth (Zustand) + chat (Zustand) + server cache (TanStack Query).
- [x] Виртуализация + сохранение позиции скролла при pagination.
- [x] Dedup хранилище событий (`eventId`).
- [x] UX для terminal WS auth ошибок (token refresh → reconnect → logout).

## P2 (после стабилизации)

- [ ] Offline режим (очередь отложенных действий с повторной отправкой).
- [ ] Feature flags для рискованных UI фич.
- [ ] Сценарные e2e для деградации сети (slow/offline/flaky reconnect).
- [ ] Multi-device push UX (настройки уведомлений устройства).

## Definition of Done для FE-релиза

- [x] Все P0 задачи закрыты.
- [x] Нет критичных багов по auth/realtime/message flows.
- [ ] По e2e smoke тестам green на CI.
- [ ] Нет unhandled ошибок в runtime на базовом smoke прогоне.
- [x] Документация по контрактам и edge-cases актуальна.

## Чеклист приемки

- [x] Login/refresh/logout работает стабильно.
- [x] Список чатов и чат-экран консистентны после reconnect.
- [x] Edit/Delete/Read статусы корректно отображаются.
- [x] Upload файлов стабилен, ошибки понятны пользователю.
- [x] Presence/typing не ломают производительность.
- [x] Ошибки backend обрабатываются единообразно.
- [ ] Smoke e2e проходит без флейков.
