# Production Deployment (Docker)

## Prerequisites

- Docker Engine 24+ with Compose V2
- 4 GB RAM minimum (ScyllaDB needs ~2 GB)

## 1. Configure environment

```bash
cp .env.production.example .env.production
```

Generate secrets and set passwords:

```bash
openssl rand -base64 48   # → JWT_SECRET
openssl rand -base64 48   # → JWT_REFRESH_SECRET
openssl rand -base64 32   # → PG_PASSWORD, REDIS_PASSWORD
```

Set `CORS_ORIGINS` to your domain. Disable `OTP_DEMO_ENABLED` in production.

## 2. Build & start

```bash
docker compose -f docker/docker-compose.prod.yml --env-file .env.production up -d --build
```

Builds two images (`yam-backend`, `yam-nginx`), starts infra (PG, ScyllaDB, Redis, imgproxy), runs migrations, launches all services behind Nginx on `$PUBLIC_PORT` (default 80).

## 3. Verify

```bash
curl http://YOUR_SERVER/health
docker compose -f docker/docker-compose.prod.yml ps
docker compose -f docker/docker-compose.prod.yml logs -f api gateway worker
```

## 4. Update

```bash
git pull
docker compose -f docker/docker-compose.prod.yml --env-file .env.production up -d --build
```

Migrations are idempotent and run automatically on every deploy.

## 5. Scale

```bash
docker compose -f docker/docker-compose.prod.yml --env-file .env.production \
  up -d --scale worker=3 --scale api=2 --scale gateway=2
```

Workers use Redis consumer groups — each job is processed exactly once.

## 6. Backups

```bash
# PostgreSQL
docker compose -f docker/docker-compose.prod.yml exec postgres \
  pg_dump -U yam yam > backup_pg_$(date +%F).sql

# Redis (AOF enabled by default)
docker compose -f docker/docker-compose.prod.yml exec redis \
  redis-cli -a $REDIS_PASSWORD BGSAVE
```

## Architecture

```
:80 Nginx ─┬─ /          → Static SPA
           ├─ /api/*     → API (:3000)
           ├─ /ws        → Gateway (:3001, WebSocket)
           ├─ /admin/*   → Admin (:3002)
           └─ /health    → API health

PostgreSQL (:5432) ← API, Gateway, Worker, Admin
ScyllaDB   (:9042) ← API, Gateway, Worker
Redis      (:6379) ← all services
imgproxy   (:8080) ← API
Worker     ← Redis Streams (inbox fanout, file processing, push)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Nginx 502 | Backend not ready — check `docker compose logs api` |
| ScyllaDB timeout on start | Normal, `start_period: 60s` handles it |
| Redis auth error | Verify `REDIS_PASSWORD` matches in Redis command and `REDIS_URL` |
| Full reset needed | `docker compose down -v` removes all data volumes |
