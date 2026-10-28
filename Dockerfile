# ── build deps ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache tini \
  && addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app . .

RUN mkdir -p logs public/uploads && chown -R app:app logs public/uploads

USER app
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
