# YAM — Yet Another Messenger

Real-time messenger designed for high load (10M+ users), built with modern TypeScript stack.

## Architecture

| Service | Port | Description |
|---|---|---|
| **API** | 3000 | HTTP REST — auth, users, contacts, chats, files |
| **Gateway** | 3001 | WebSocket — real-time messaging, typing, presence |
| **Worker** | — | Background jobs — inbox fanout, file processing, crons |
| **Admin** | 3002 | Admin HTTP API — user management, settings, moderation |
| **Web** | 5173 | React SPA — frontend |

## Tech Stack

- **Runtime**: Bun
- **Backend**: Elysia (HTTP + WebSocket)
- **Database**: PostgreSQL (relational) + ScyllaDB (messages, inbox)
- **Cache/Queue**: Redis (Pub/Sub, Streams, presence, rate limiting)
- **ORM**: Drizzle ORM (PostgreSQL)
- **Frontend**: React 19, Vite, TanStack Query, Zustand, Tailwind CSS v4
- **Image Processing**: imgproxy (on-the-fly resize)
- **Monorepo**: Turborepo + Bun workspaces
- **Linting**: Biome

## Quick Start

```bash
# Install dependencies
bun install

# Start infrastructure
bun run docker:up

# Run database migrations
bun run db:migrate

# Start all services in development
bun run dev
```

## Project Structure

```
yam/
├── apps/
│   ├── api/          # HTTP REST service
│   ├── gateway/      # WebSocket service
│   ├── worker/       # Background job service
│   ├── admin/        # Admin API service
│   └── web/          # React frontend
├── packages/
│   ├── shared/       # Shared types, constants, validation
│   └── db/           # Database layer (PG, ScyllaDB, Redis)
├── docker/           # Docker Compose + configs
└── docs/             # Architecture documentation
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

Demo phones accept OTP code `000000`:
- +79000000001 through +79000000005

## Architecture v2 Roadmap

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full architecture documentation including:

- **Secret chats** (Signal Protocol / E2EE)
- **Analytics pipeline** (Kafka → ClickHouse / OpenSearch)
- **Channels** (>200 members, pull-based delivery)
- **Video/Voice calls** (WebRTC via SFU)
- **Kubernetes deployment** with stateful WS gateway
- **Full-text search** (Meilisearch/OpenSearch)
- **Anti-fraud & security audit** pipeline
