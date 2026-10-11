# Self-hosted build (Coolify): `next build`, then `next start` on port 3000.
FROM node:24-bookworm-slim AS build
ENV CI=1 NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=3072
WORKDIR /app
RUN corepack enable
COPY . .
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
WORKDIR /app/.
RUN mkdir -p public && npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app /app
WORKDIR /app/.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node","node_modules/next/dist/bin/next","start","-p","3000","-H","0.0.0.0"]
