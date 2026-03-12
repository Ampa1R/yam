# YAM — Yet Another Messenger

Real-time messenger designed for high load (10M+ users), built with modern TypeScript stack.

**Live demo:** [yam.filipp.dev](https://yam.filipp.dev) — test accounts: `+79000000001` ... `+79000000009` (OTP - 000000)

## Services

| Service | Port | Description |
|---|---|---|
| **API** | 3000 | HTTP REST — auth, users, contacts, chats, files |
| **Gateway** | 3001 | WebSocket — real-time messaging, typing, presence |
| **Worker** | — | Background jobs — inbox fanout, file processing, crons |
| **Admin** | 3002 | Admin HTTP API — user management, settings |
| **Web** | 5173 | React SPA — frontend |

## Tech Stack

- **Runtime**: Bun
- **Backend**: Elysia (HTTP + WebSocket)
- **Database**: PostgreSQL 16 (relational) + ScyllaDB (messages, inbox)
- **Cache/Queue**: Redis 7 (Pub/Sub, Streams, presence, rate limiting)
- **ORM**: Drizzle ORM (PostgreSQL)
- **Frontend**: React 19, Vite, TanStack Query, Zustand, Tailwind CSS v4
- **Image Processing**: imgproxy (on-the-fly resize)
- **Monorepo**: Turborepo + Bun workspaces
- **Linting**: Biome

## Prerequisites

- [Bun](https://bun.sh/) >= 1.3
- [Docker](https://docs.docker.com/get-docker/) + Docker Compose (for PostgreSQL, ScyllaDB, Redis, imgproxy)

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Start infrastructure (PostgreSQL, ScyllaDB, Redis, imgproxy)
bun run docker:up

# 3. Copy environment files
cp .env.example .env
cp apps/web/.env.example apps/web/.env

# 4. Run database migrations
#    PostgreSQL (Drizzle):
bun run db:migrate
#    ScyllaDB (wait ~30s for ScyllaDB to be ready):
bun run --env-file=.env packages/db/src/scylla/migrate.ts

# 5. Start all services in development
bun run dev
```

Open http://localhost:5173 in your browser.

> **Note**: If port 6379 is already in use (e.g. system Redis), either stop the existing Redis or remove the `redis` service from `docker/docker-compose.yml` and use the system one.

> **Note**: `STORAGE_LOCAL_PATH` in `.env` must be an **absolute path** (e.g. `/home/user/yam/uploads`), not relative — the worker service runs from a different directory than the API.

## Environment Variables

### Backend (`.env` at repo root)

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://yam:yam_dev@localhost:5432/yam` | PostgreSQL connection |
| `SCYLLA_HOSTS` | `localhost:9042` | ScyllaDB contact points |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `JWT_SECRET` | — | JWT access token signing key |
| `JWT_REFRESH_SECRET` | — | JWT refresh token signing key |
| `STORAGE_LOCAL_PATH` | — | **Absolute** path for file uploads |
| `OTP_DEMO_ENABLED` | `false` | Enable demo OTP codes |
| `OTP_DEMO_CODE` | `000000` | Fixed OTP code for demo phones |
| `OTP_DEMO_PHONES` | — | Comma-separated demo phone numbers |

### Frontend (`apps/web/.env`)

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE` | `/api` | API base path (proxied by Vite in dev) |
| `VITE_WS_BASE` | `/ws` | WebSocket base path (proxied by Vite in dev) |
| `VITE_MAX_FILE_SIZE_MB` | `50` | Client-side file size limit |
| `VITE_MAX_MESSAGE_LENGTH` | `4096` | Client-side message length limit |

In development, Vite proxies `/api` → `localhost:3000` and `/ws` → `localhost:3001` automatically.

## Project Structure

```
yam/
├── apps/
│   ├── api/            # HTTP REST service (Elysia)
│   │   ├── src/lib/    #   auth middleware, errors
│   │   └── src/modules/#   feature-based routes (auth, chats, users, files, ...)
│   ├── gateway/        # WebSocket service (Elysia)
│   │   ├── src/connection/  # ConnectionManager
│   │   ├── src/handlers/    # message, read, typing
│   │   └── src/lib/         # chat member helpers
│   ├── worker/         # Background job service
│   │   ├── src/jobs/   #   inbox-fanout, file-process
│   │   └── src/crons/  #   cleanup (tokens, files)
│   ├── admin/          # Admin API service
│   └── web/            # React SPA frontend
│       ├── src/features/    # feature-based pages (auth, chat)
│       ├── src/stores/      # Zustand stores (auth, chat)
│       ├── src/hooks/       # useWebSocket, useDebounce, useThrottle
│       └── src/lib/         # API client, queryClient, utilities
├── packages/
│   ├── shared/         # Shared types, constants, JWT utilities
│   └── db/             # Database layer
│       ├── src/pg/     #   PostgreSQL (Drizzle ORM)
│       ├── src/redis/  #   Redis (presence, unread, cache, auth, pubsub, streams)
│       └── src/scylla/ #   ScyllaDB (messages, inbox, status)
├── docker/             # Docker Compose + init scripts
└── docs/               # Architecture docs, requirements, RFC
```

## Key Design Decisions

- **No FK in PostgreSQL** — application-level integrity for horizontal scaling
- **ScyllaDB time-bucketed partitions** — `(chat_id, YYYYMM)` prevents hot partitions
- **Denormalized inbox** — ScyllaDB `user_inbox` table, single partition read per user
- **Per-user Redis Pub/Sub** — targeted delivery, no fan-out waste
- **Redis Streams for queues** — Cluster-compatible, no BullMQ dependency
- **Split API/Gateway** — different scaling profiles (stateless HTTP vs stateful WS)
- **Async fan-out** — message persisted synchronously, inbox/push/unread updated via worker

## Demo Mode

Set `OTP_DEMO_ENABLED=true` in `.env`. Demo phones accept OTP code `000000`:
- +79000000001 through +79000000009

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — full system architecture, data model, WS protocol, API reference
- [Frontend Requirements](docs/FRONTEND_REQUIREMENTS_TASKS.md) — FE backlog and acceptance criteria
- [FE/BE Collaboration RFC](docs/FE_BE_COLLAB_RFC.md) — cross-team contracts and integration status

## Architecture v2 Roadmap

- **Secret chats** (Signal Protocol / E2EE)
- **Analytics pipeline** (Kafka → ClickHouse / OpenSearch)
- **Channels** (>200 members, pull-based delivery)
- **Video/Voice calls** (WebRTC via SFU)
- **Kubernetes deployment** with stateful WS gateway
- **Full-text search** (Meilisearch/OpenSearch)
- **Push notifications** (FCM/APNs)
