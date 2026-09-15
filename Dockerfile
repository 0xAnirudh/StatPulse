# One image, three roles.
#
# The API, the checker and the flusher share a dependency tree and differ
# only in entry point, so building three images would mean three builds
# and three things to keep in step for no benefit. The command selects
# the role:
#
#   node packages/api/src/server.js    the HTTP process
#   node packages/jobs/src/worker.js   the checker and the flusher
#
FROM node:20-alpine AS deps

WORKDIR /app

# Manifests first, so a source change does not invalidate the dependency
# layer. Every workspace manifest has to be present for `npm ci` to
# resolve the workspace links.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/api/package.json packages/api/
COPY packages/jobs/package.json packages/jobs/

RUN npm ci --omit=dev

FROM node:20-alpine AS runtime

# dumb-init, because Node as PID 1 does not get default signal handlers -
# so SIGTERM would be ignored and every deploy would end in the
# orchestrator's SIGKILL, cutting in-flight requests and abandoning jobs
# mid-flight. Both processes have graceful shutdown; this is what lets it
# actually run.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY package.json ./
COPY packages ./packages

# Never as root.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/api/src/server.js"]
