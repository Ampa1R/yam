# FE + BE Collaboration RFC (YAM Web)

## Purpose

Зафиксировать совместные задачи фронтенда и бэкенда, которые критичны для:

- production readiness;
- high-load устойчивости;
- безопасности;
- предсказуемой работы realtime-коммуникаций.

Документ ориентирован на `apps/web` и его контракты с backend сервисами.

## Scope

- Frontend: `apps/web`
- Backend: API + WebSocket слой, отвечающие за auth, chats, messages, files, presence
- Out of scope: админка, не связанные внутренние сервисы

## Priority Matrix

- `P0` — блокер релиза
- `P1` — нужно закрыть в ближайшем спринте
- `P2` — улучшения после стабилизации

## Review Snapshot (after latest audit)

### Frontend status

- [x] Message delivery statuses implemented in UI (`SENT/DELIVERED/READ`)
- [x] Optimistic `pin/mute` + rollback implemented
- [x] Chat list virtualization implemented and tuned for long histories
- [x] Focus trap added for chat/profile/contact modals
- [x] Reconnect, heartbeat, offline buffer implemented
- [x] Offline buffer bounded on client side
- [x] File validation, retry upload UI, and env numeric hardening implemented
- [x] Voice recording and playback with waveform visualization
- [x] Group management dialog (add/remove members, roles, transfer ownership)
- [x] MessageBubble extracted to separate component
- [x] Undo-snackbar for message deletion

### Backend status

- [x] WS auth via event (no token in URL)
- [x] Monotonic status lifecycle (LWT: `INSERT IF NOT EXISTS` + `UPDATE IF status < ?`)
- [x] `eventId` in all server events for dedup
- [x] Unified WS error contract (`code/message/severity/retryable/scope`)
- [x] File metadata contract (`width/height/duration/waveform`)
- [x] Presence/typing TTL synced via shared constants (`@yam/shared`)
- [x] Cursor pagination with stable TimeUUID ordering
- [x] Retry semantics: error taxonomy with `retryable` flag
- [x] Ban propagation via Redis Pub/Sub (`user:banned` channel)
- [x] Atomic Redis operations (pipelines, MULTI, Lua scripts)
- [x] Rate limiting on search, OTP, messages

### Still requires work

- [ ] Smoke E2E environment contract (стабильные тестовые пользователи/данные/флаги)
- [ ] Inbox reconciliation cron (planned, not implemented)
- [ ] Client-side observability (metrics: reconnect rate, send latency, upload success/failure)
- [ ] Contract tests for reconnect resync and cursor consistency under concurrent writes
- [ ] Refresh token rotation / reuse detection

---

## P0 (Release blockers) — ALL DONE

### 1) WebSocket authentication without token in URL

**Status**: FE done, BE done

- Auth via `{ event: "auth", data: { token } }` after WS `open`.
- Server replies `auth:ok` or structured error (`AUTH_FAILED`/`AUTH_TIMEOUT`).
- FE handles auth failure with token refresh attempt (max 2 retries), then logout.

### 2) Unified delivery status contract (ack/delivered/read)

**Status**: FE done, BE done

- `message:ack` — server accepted, client resolves optimistic message.
- `message:status DELIVERED` — recipient gateway received.
- `message:status READ` — recipient opened chat and scrolled to message.
- ScyllaDB LWT ensures monotonic updates (`INSERT IF NOT EXISTS` + `UPDATE IF status < ?`).

### 3) Event ordering and deduplication contract

**Status**: FE done, BE done

- All server events include `eventId` (UUID).
- FE maintains bounded dedup cache.
- Idempotent event handlers (duplicate `message:new` / `chat:updated` don't corrupt state).

### 4) Membership update contract (pin/mute)

**Status**: FE done, BE done

- `PATCH /api/chats/:id/pin` + `PATCH /api/chats/:id/mute` with 404 on missing membership.
- FE: optimistic update + rollback on error.

---

## P1 (Next sprint) — MOSTLY DONE

### 5) File metadata contract for stable rendering

**Status**: FE done, BE done

- Upload returns `{ id, url, filename, mimeType, size, width, height }`.
- Worker extracts `width/height` for images, `waveform` for audio.
- `GET /api/files/:id/meta` returns full metadata including `duration` and `waveform`.
- `Attachment` type includes `width`, `height`, `duration`, `waveform` fields.

### 6) Presence/typing TTL synchronization

**Status**: FE done, BE done

- Single source of truth: `packages/shared/src/constants.ts`
- `PRESENCE_TTL_SECONDS = 90`, `TYPING_TTL_SECONDS = 5`, `HEARTBEAT_INTERVAL_MS = 25000`
- Gateway throttles presence refresh to Redis to once per 30s.

### 7) Cursor pagination consistency under writes

**Status**: FE done, BE done

- ScyllaDB TimeUUID-based cursor — new messages get later TimeUUIDs, cursor is stable.
- FE uses `useInfiniteQuery` with cursor, merges API data with local WS messages.

### 8) Retry semantics and error taxonomy

**Status**: FE done, BE done

- WS errors include `{ code, message, severity, retryable, scope }`.
- FE maps `retryable: true` → auto-retry, `retryable: false` + `scope: "auth"` → logout.
- REST errors: `{ error, code }` with HTTP status codes.
- Global `AppError` class on FE, `AppError`/`Errors` factory on BE.

### 11) Unified WS error contract for frontend UI

**Status**: FE done, BE done

- Error payload: `{ code: string, message: string, severity: "info"|"warning"|"error", retryable: boolean, scope: "auth"|"chat"|"message"|"system" }`
- Defined error defaults in gateway: `AUTH_FAILED`, `AUTH_REQUIRED`, `AUTH_TIMEOUT`, `ACCOUNT_SUSPENDED`, `PARSE_ERROR`, `INVALID_FORMAT`, `UNKNOWN_EVENT`, `RATE_LIMITED`, etc.

### 12) Smoke E2E environment contract

**Status**: FE pending, BE pending

- Demo mode exists (`OTP_DEMO_ENABLED=true`, `OTP_DEMO_CODE=000000`, `OTP_DEMO_PHONES`).
- Missing: pre-created test users/fixtures, stable CI test env, automated smoke script.

---

## P2 (Post-stabilization)

### 9) End-to-end observability for realtime

**Status**: pending

- Needed: Correlation IDs in REST/WS, client metrics (send→ack latency, reconnect rate, dropped events).
- FE has `ErrorBoundary` + centralized error handling but no metrics collection yet.

### 10) Security hardening follow-up

**Status**: partially done

- Done: IP-based rate limiting with `X-Forwarded-For`/`X-Real-IP` extraction, rate limiting on search/OTP/messages, ban propagation via Pub/Sub, permissions-policy headers.
- Missing: refresh token rotation/reuse detection, device binding, upload MIME sniffing/scanning.

---

## Shared API/WS Contract Checklist

Before starting implementation of each task:

- [x] Request/response schemas described (Elysia + TypeBox validation)
- [x] Event payloads and required fields described (`packages/shared/src/types/events.ts`)
- [x] Error codes defined (`ErrorPayload` with `code/message/severity/retryable/scope`)
- [x] Idempotency and ordering guarantees (`eventId`, LWT, monotonic statuses)
- [ ] Contract tests added

## Testing Plan (FE + BE)

### Functional
- [ ] Auth success/fail/reconnect сценарии
- [ ] Pin/mute persistence между reload и multi-tab
- [ ] Message status transitions without regressions

### High-load
- [ ] 1k/5k concurrent WS clients
- [ ] reconnect storm test
- [ ] burst typing/presence events
- [ ] heavy chat history with virtualization enabled

### Security
- [x] No token in WS URL
- [ ] Sensitive data not logged
- [x] Upload policy enforced server-side

## Owners (to fill)

- FE owner:
- BE owner:
- QA owner:
- SRE owner:

## Milestones (to fill)

- M1 (P0 freeze): done
- M2 (P1 completion):
- M3 (P2 backlog grooming):
