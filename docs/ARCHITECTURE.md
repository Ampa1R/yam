# YAM — Yet Another Messenger: Architecture

## Overview

YAM is a real-time messenger designed for high load (10M+ users). The system is built as a set of microservices communicating through Redis (Pub/Sub + Streams), with PostgreSQL for relational data, ScyllaDB for message storage, and a React SPA frontend.

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | **Bun** | Faster than Node.js, native WS support, TS-first |
| Backend Framework | **Elysia** | Native Bun, fastest in ecosystem, Eden Treaty for E2E type safety |
| Relational DB | **PostgreSQL 16** | Users, chats, contacts, files, settings (ACID) |
| Message Store | **ScyllaDB** | Messages, inbox, read receipts (sub-ms reads, linear write scaling) |
| Cache / PubSub / Queue | **Redis 7** | Presence, typing, rate limiting, Pub/Sub (per-user channels), Streams (job queue) |
| ORM (PG) | **Drizzle ORM** | Type-safe, SQL-like, zero overhead, Bun compatible |
| ScyllaDB Driver | **scylladb-javascript-driver** | Official driver, CQL queries with typed wrapper |
| Frontend | **React 19 + Vite** | Modern React with Bun-compatible bundler |
| State Management | **TanStack Query + Zustand** | Server state + client state separation |
| UI | **Tailwind CSS v4 + shadcn/ui** | Utility-first CSS + accessible components |
| API Client | **Eden Treaty** | Elysia's tRPC-like typed client |
| Image Processing | **imgproxy** | On-the-fly resize, WebP/AVIF, cached by Nginx |
| Monorepo | **Turborepo + Bun workspaces** | Fast builds, shared packages |
| Linting | **Biome** | Fast lint + format, replaces ESLint + Prettier |
| Infrastructure | **Docker Compose** | Local dev: PG, ScyllaDB, Redis, imgproxy, Nginx |

## Architecture Diagram

```
                          ┌─────────────────┐
                          │   Load Balancer  │
                          │  (Nginx/Traefik) │
                          └────────┬────────┘
                     ┌─────────────┼─────────────┐
                     │             │             │
                /api/*         /ws           /img/*
                     │             │             │
              ┌──────▼──────┐ ┌───▼────────┐ ┌──▼──────────┐
              │ API Service │ │  Gateway   │ │ Nginx Cache │
              │   (×N)      │ │  Service   │ │      +      │
              │ HTTP REST   │ │   (×M)     │ │  imgproxy   │
              │ stateless   │ │ WebSocket  │ │             │
              └──────┬──────┘ │ stateful   │ └──────┬──────┘
                     │        └─────┬──────┘        │
                     │              │               │
              ┌──────▼──────┐      │         ┌─────▼──────┐
              │Admin Service│      │         │File Storage│
              │   (×1-2)    │      │         │ Local / S3 │
              │internal only│      │         └────────────┘
              └──────┬──────┘      │
                     │              │
         ┌───────────┴──────────────┴───────────────┐
         │                  Redis 7                  │
         │  Cache │ Pub/Sub (per-user) │ Streams Q  │
         └───────────────────┬──────────────────────┘
                             │
                      ┌──────▼──────┐
                      │   Worker    │
                      │  Service    │
                      │   (×K)     │
                      │  Consumers │
                      └──────┬──────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
       ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
       │ PostgreSQL  │ │ ScyllaDB │ │File Storage │
       │   (ACID)    │ │ (Messages│ │ Local / S3  │
       │Users, Chats │ │  Inbox)  │ │             │
       └─────────────┘ └──────────┘ └─────────────┘
```

## Services

### API Service (HTTP REST, stateless)
- Auth (phone + OTP, JWT)
- Users (profile, search)
- Contacts (CRUD, block)
- Chats (CRUD, members, roles)
- Messages (history query via REST)
- Files (upload)
- Routes: `/api/*`

### Gateway Service (WebSocket, stateful)
- Connection management (ConnectionManager)
- Message sending/receiving
- Typing indicators
- Presence (online/offline)
- Read receipts
- Per-user Redis Pub/Sub subscription
- Route: `/ws`

### Worker Service (background jobs, stateless)
- Redis Streams consumers
- Jobs: inbox fanout, voice waveform extraction, push notifications
- Cron jobs via setInterval + Redis distributed lock:
  - Cleanup expired refresh tokens (hourly)
  - Sync last_seen to PG (every 5 min)
  - Cleanup orphan files (daily)
  - Reconciliation: verify inbox consistency (every 5 min)

### Admin Service (HTTP REST, internal)
- User management (ban, suspend, view sessions)
- Chat management (delete, force-remove members)
- Content moderation (reported messages)
- System settings (rate limits, feature flags, max group size)
- Separate JWT secret, deployed on internal network

## Inter-Service Communication

All services communicate through Redis:

1. **Redis Pub/Sub (per-user channels)**: Any service can `PUBLISH user:{userId} {event}`. Only Gateway instances subscribe to channels of their connected users and deliver via WebSocket.

2. **Redis Streams (job queue)**: API/Gateway enqueue jobs via `XADD`. Worker consumes via `XREADGROUP` (consumer groups for parallel processing).

3. **Shared DB access**: Both API and Gateway have direct access to PostgreSQL and ScyllaDB through the shared `packages/db` package.

## Data Architecture

### PostgreSQL (relational data, ACID)

No foreign keys — referential integrity enforced at application level for horizontal scaling.

**Tables:**
- `users` — id, phone, username, display_name, avatar_url, status_text, is_profile_public, role
- `contacts` — (user_id, contact_id), nickname
- `blocked_users` — (user_id, blocked_id)
- `chats` — id, type (direct/group), name, description, avatar_url, created_by, member_count
- `chat_members` — (chat_id, user_id), role, is_pinned, is_muted, last_read_at
- `refresh_tokens` — id, user_id, token_hash, device_info, expires_at
- `device_tokens` — id, user_id, platform, token (push notification stub)
- `files` — id, uploader_id, filename, mime_type, size, storage_key, width, height, duration, waveform
- `system_settings` — key, value (JSONB), updated_at, updated_by

### ScyllaDB (messages, high write throughput)

**`messages`** — partition: `(chat_id, bucket)`, cluster: `id DESC`
- `bucket` = YYYYMM (monthly bucketing to prevent hot partitions)
- `type` = TINYINT enum (0=text, 1=media, 2=document, 3=voice, 4=sticker, 5=system)
- `attachments` = LIST<FROZEN<attachment>> UDT
- `media_group_id` for album grouping
- TimeWindowCompactionStrategy (TWCS) for efficient compaction

**`message_status`** — partition: `(chat_id, message_id)`, cluster: `user_id`
- Per-user delivery/read status for detailed read receipts

**`user_inbox`** — partition: `user_id`, cluster: `chat_id`
- Denormalized chat list with last message preview
- Single partition read per user (~100KB max), sorted in application
- Updated asynchronously via Worker (inbox:fanout job)

### Redis (ephemeral + pub/sub + queue)

```
# Auth
otp:{phone} = code                          TTL 300s
otp_attempts:{phone} = count                TTL 3600s

# Presence
presence:{userId} = "online"                TTL 30s (heartbeat)
last_seen:{userId} = timestamp              TTL 30d

# Typing
typing:{chatId}:{userId} = "1"             TTL 3s

# Unread
unread:{userId}:{chatId} = count            TTL 30d

# Cache
chat:members:{chatId} = SET[userIds]        TTL 300s
direct:{min(A,B)}:{max(A,B)} = chatId      no TTL

# Rate limiting
rate:{userId}:msg = ZSET[timestamps]        TTL 60s
rate:{ip}:otp = ZSET[timestamps]            TTL 3600s

# Connection tracking
user:connections:{userId} = SET[instanceIds] TTL 60s

# Pub/Sub channels (per-user)
user:{userId}   — events for this user

# Streams (job queues)
stream:inbox-fanout
stream:file-process
stream:push-send
stream:dlq:{jobName}   — dead letter queues
```

## WebSocket Protocol

Connection: `wss://host/ws?token={accessToken}`

### Client → Server Events

| Event | Payload | Description |
|---|---|---|
| `message:send` | `{chatId, type, content, mediaUrl?, replyTo?, clientId}` | Send message |
| `message:edit` | `{messageId, chatId, content}` | Edit message |
| `message:delete` | `{messageId, chatId}` | Delete message |
| `message:read` | `{chatId, messageId}` | Mark as read |
| `typing:start` | `{chatId}` | Start typing |
| `typing:stop` | `{chatId}` | Stop typing |
| `ping` | — | Heartbeat (every 25s) |

### Server → Client Events

| Event | Payload | Description |
|---|---|---|
| `message:new` | `Message` | New message in chat |
| `message:updated` | `{messageId, chatId, content, editedAt}` | Message edited |
| `message:deleted` | `{messageId, chatId}` | Message deleted |
| `message:status` | `{messageId, chatId, userId, status}` | Delivery/read status |
| `message:ack` | `{clientId, messageId, createdAt}` | Server confirms message |
| `typing` | `{chatId, userId, isTyping}` | Typing indicator |
| `presence` | `{userId, status, lastSeen?}` | Online/offline |
| `chat:updated` | `{chatId, lastMessage, unreadCount}` | Inbox update |
| `pong` | — | Heartbeat response |
| `error` | `{code, message}` | Error |

### Message Flow

```
Client A → WS → Gateway 1 → ScyllaDB INSERT (sync) → ACK to Client A
                           → Redis PUBLISH user:{recipientId} (async)
                           → Redis XADD stream:inbox-fanout (async)

Redis PUBLISH → Gateway 2 → WS → Client B (real-time delivery)
Redis XADD → Worker → ScyllaDB UPDATE user_inbox (batch for all members)
                     → Redis INCR unread (for offline members)
```

## REST API

### Auth
```
POST /api/auth/request-otp     {phone}
POST /api/auth/verify-otp      {phone, code}
POST /api/auth/refresh         {refreshToken}
POST /api/auth/logout
```

### Users
```
GET    /api/users/me
PATCH  /api/users/me            {displayName, avatarUrl, statusText, isProfilePublic}
GET    /api/users/search        ?q=term
GET    /api/users/:id
POST   /api/users/:id/block
DELETE /api/users/:id/block
```

### Contacts
```
GET    /api/contacts
POST   /api/contacts            {userId}
DELETE /api/contacts/:userId
```

### Chats
```
GET    /api/chats                                   (inbox)
POST   /api/chats               {type, memberIds, name?}
GET    /api/chats/:id
PATCH  /api/chats/:id           {name, avatarUrl, description}
POST   /api/chats/:id/members   {userId}
DELETE /api/chats/:id/members/:userId
PATCH  /api/chats/:id/members/:userId/role  {role}
POST   /api/chats/:id/transfer  {userId}
PATCH  /api/chats/:id/pin       {isPinned}
PATCH  /api/chats/:id/mute      {isMuted}
DELETE /api/chats/:id/leave
```

### Messages
```
GET    /api/chats/:chatId/messages  ?cursor=&limit=50
POST   /api/chats/:chatId/messages  {type, content, mediaUrl?, replyTo?}
PATCH  /api/messages/:id            {content}
DELETE /api/messages/:id
```

### Files
```
POST   /api/files/upload        multipart/form-data
```

### Devices (push notification stub)
```
POST   /api/devices             {platform, token}
DELETE /api/devices/:id
```

## Performance Decisions

### Why no FK in PostgreSQL
- Write amplification from constraint checks
- Deadlocks on concurrent writes to related tables
- Prevents future horizontal sharding
- Referential integrity at application level

### Why time-bucketed partitions in ScyllaDB
- Partition size < 100MB (ScyllaDB recommendation)
- Active groups can generate 100K+ messages/month
- Monthly bucketing: 99% of reads hit current bucket
- TWCS compaction aligns with time-based data

### Why per-user Redis Pub/Sub channels
- Naive approach (publish to chat channel): N instances receive, N-2 discard (fan-out waste)
- Per-user channels: only instances with connected users subscribe
- SUBSCRIBE/UNSUBSCRIBE = O(1), Redis handles millions of channels

### Why Redis Streams over BullMQ
- BullMQ doesn't support Redis Cluster (Lua multi-key operations)
- Redis Streams work natively with Cluster
- No external dependencies (ioredis already in stack)
- ~300 lines of wrapper code covers all our needs
- Jobs are non-critical (ScyllaDB is source of truth for messages)

### Why denormalized user_inbox in ScyllaDB
- Inbox = "my chats sorted by last activity" — most frequent query
- PostgreSQL JOIN (chats + chat_members + subquery for last msg) = slow at scale
- ScyllaDB single partition read (~100KB) = sub-millisecond
- Write amplification (update N rows per message) is acceptable for ScyllaDB

### Fan-out bottleneck mitigation
- Messages persisted synchronously (ScyllaDB)
- ACK sent to client immediately
- Fan-out (inbox update, push, unread) = async via Redis Streams worker
- Reconciliation cron ensures eventual consistency
- Group size limit: 200 members (configurable)

## Scalability Path

### v1 (Current)
- Single PostgreSQL (with read replica)
- ScyllaDB 3-node cluster
- Single Redis (dev) / Redis Cluster 6-node (prod)
- N API instances + M Gateway instances + K Workers
- Docker Compose for dev

### v2 (Future)
- **Kafka/Redpanda**: Event streaming, ScyllaDB CDC → analytics pipeline
- **ClickHouse**: Analytics, BI (message volumes, user activity, retention)
- **OpenSearch**: Security audit logs, anti-fraud, full-text search
- **Secret chats**: Signal Protocol (X3DH + Double Ratchet), client-side encryption
- **Channels**: Groups > 200 members with pull-based delivery model
- **Kubernetes**: Stateful WS gateway with sticky sessions, graceful draining
- **Video/Voice calls**: WebRTC via SFU (Selective Forwarding Unit)
- **Stickers + Reactions**: Extensible message schema already supports this
- **Push notifications**: FCM/APNs via dedicated Notification Service
