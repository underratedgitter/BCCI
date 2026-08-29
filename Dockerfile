FROM node:20-alpine

# Run as an unprivileged user, not root.
RUN addgroup -S bcci && adduser -S bcci -G bcci

WORKDIR /app

# Install dependencies first so this layer caches across code changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --chown=bcci:bcci . .

# Secrets are supplied at runtime, never baked into the image.
RUN rm -f .env .env.local

USER bcci

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
