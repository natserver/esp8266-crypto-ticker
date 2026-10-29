ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8080

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY binance_ws.js ./
COPY public ./public

RUN mkdir -p /app/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "server.js"]
