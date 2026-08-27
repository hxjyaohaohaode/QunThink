# 注意：构建上下文必须是仓库根目录（docker build -f frontend/Dockerfile .）
# 前端通过 ../shared/contracts 引用 monorepo 共享类型，
# 仅以 frontend/ 作为上下文会导致 tsc 报 TS2307 找不到模块。
FROM node:22-alpine AS builder

WORKDIR /app

# 先只拷贝依赖清单以利用 Docker 层缓存
COPY frontend/package*.json ./frontend/

RUN cd frontend && npm ci

COPY shared/ ./shared/
COPY frontend/ ./frontend/

WORKDIR /app/frontend

RUN npm run build

FROM nginx:alpine

RUN apk add --no-cache wget

COPY --from=builder /app/frontend/dist /usr/share/nginx/html

RUN rm /etc/nginx/conf.d/default.conf

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80 || exit 1

CMD ["nginx", "-g", "daemon off;"]
