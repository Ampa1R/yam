FROM oven/bun:1.3-alpine AS deps

WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/api/package.json          apps/api/package.json
COPY apps/gateway/package.json      apps/gateway/package.json
COPY apps/worker/package.json       apps/worker/package.json
COPY apps/admin/package.json        apps/admin/package.json
COPY apps/web/package.json          apps/web/package.json
COPY packages/db/package.json       packages/db/package.json
COPY packages/shared/package.json   packages/shared/package.json

RUN bun install --frozen-lockfile

# frontend
FROM deps AS frontend

COPY packages/ packages/
COPY apps/web/ apps/web/

WORKDIR /app/apps/web
ENV VITE_API_BASE=/api \
    VITE_WS_BASE=/ws \
    VITE_MAX_FILE_SIZE_MB=50 \
    VITE_MAX_MESSAGE_LENGTH=4096
RUN bunx vite build

# backend
FROM oven/bun:1.3-alpine AS backend

WORKDIR /app

COPY --from=deps /app/node_modules       node_modules/
COPY --from=deps /app/package.json       package.json
COPY --from=deps /app/turbo.json         turbo.json
COPY --from=deps /app/tsconfig.base.json tsconfig.base.json

COPY packages/    packages/
COPY apps/api/    apps/api/
COPY apps/gateway/ apps/gateway/
COPY apps/worker/ apps/worker/
COPY apps/admin/  apps/admin/

# creates workspace-local links required at runtime in containers.
RUN bun install --frozen-lockfile

RUN mkdir -p /data/uploads

# nginx
FROM nginx:1.27-alpine AS nginx

RUN rm /etc/nginx/conf.d/default.conf
COPY docker/nginx.prod.conf /etc/nginx/conf.d/yam.conf
COPY --from=frontend /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80
