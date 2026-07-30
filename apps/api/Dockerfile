# =============================================================================
# @legaltech/api — production image
#
# Build from the REPOSITORY ROOT, not this directory:
#     docker build -f apps/api/Dockerfile -t legaltech-api:latest .
#
# The build context has to be the workspace root because npm workspaces resolve
# through the root package-lock.json and `packages/database` is a local
# dependency of this app.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — dependencies
#
# Split from the build stage so a source-only change reuses the installed
# node_modules layer. `npm ci` is the slowest step in the pipeline by a wide
# margin, and it only needs to re-run when a manifest changes.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps

# openssl: required by Prisma's query engine.
# libc6-compat: some native modules still expect glibc symbols on musl.
RUN apk add --no-cache libc6-compat openssl

WORKDIR /repo

# Puppeteer downloads a ~180MB Chromium on install that cannot run on Alpine
# anyway — the runtime stage installs Alpine's own build instead. Skipping the
# download saves the time and the layer.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Manifests only, so this layer is invalidated by dependency changes alone.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/database/package.json ./packages/database/

# The Prisma schema is copied before install because @prisma/client runs
# `prisma generate` in its postinstall and fails without one.
COPY packages/database/prisma ./packages/database/prisma

RUN npm ci --workspaces --include-workspace-root


# -----------------------------------------------------------------------------
# Stage 2 — build
# -----------------------------------------------------------------------------
FROM node:22-alpine AS build

RUN apk add --no-cache libc6-compat openssl

WORKDIR /repo
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY --from=deps /repo/node_modules ./node_modules
COPY . .

# Regenerated explicitly rather than relying on the postinstall: the schema may
# have changed since the deps layer was cached, and a stale client is a class of
# bug that only appears at runtime.
RUN npx prisma generate --schema packages/database/prisma/schema.prisma

# `@legaltech/database` compiles to dist/ and is a real dependency of the API,
# so it is built first.
RUN npm run build --workspace=@legaltech/database \
 && npm run build --workspace=@legaltech/api

# Reinstall as production-only, into a clean tree.
#
# `npm prune --omit=dev` is the obvious alternative and it is unreliable in a
# workspace: it leaves behind hoisted transitive dev dependencies. A fresh
# install is slower and produces a tree that actually matches the lockfile's
# production closure.
RUN rm -rf node_modules \
 && npm ci --workspaces --include-workspace-root --omit=dev \
 && npx prisma generate --schema packages/database/prisma/schema.prisma \
 && npm cache clean --force


# -----------------------------------------------------------------------------
# Stage 3 — runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# --- System dependencies -----------------------------------------------------
#
# Every package here is required by a specific feature; none is precautionary.
#
#   chromium         PDF export. Puppeteer's bundled Chromium is glibc-linked and
#                    will not start on Alpine, so the distro build is used and
#                    PUPPETEER_EXECUTABLE_PATH points at it.
#   nss, freetype,
#   harfbuzz         Chromium's own runtime requirements.
#   font-noto,
#   font-noto-extra  Cyrillic and extended-Latin glyph coverage. This is NOT
#                    optional for this product: with only ttf-freefont, Russian
#                    and Uzbek-Cyrillic contract text renders as empty boxes in
#                    every generated PDF, and it renders correctly in local
#                    development on a machine that has system fonts — so it is
#                    the kind of defect that reaches production.
#   poppler-utils    pdftoppm, for rasterising scanned PDFs before OCR. Without
#                    it, image-only PDFs fail extraction (see OcrService).
#   openssl          Prisma query engine.
#   tini             PID 1. Node does not reap zombies or forward signals to
#                    children, and Chromium spawns several — without an init,
#                    SIGTERM never reaches them and the pod waits out its full
#                    termination grace period on every deploy.
RUN apk add --no-cache \
      libc6-compat \
      openssl \
      tini \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      font-noto \
      font-noto-extra \
      poppler-utils \
 && rm -rf /var/cache/apk/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    # Written to by tesseract.js when it downloads traineddata. Mounted as a
    # volume in the Deployment so language models survive a restart — otherwise
    # every new pod re-downloads tens of megabytes before it can read a document.
    OCR_CACHE_PATH=/var/cache/tesseract \
    PORT=4000

WORKDIR /app

# --- Non-root ----------------------------------------------------------------
#
# The `node` image already ships an unprivileged `node` user (uid 1000). Reusing
# it beats creating another: it owns nothing unexpected, and the uid is stable
# across image rebuilds, which matters for volume ownership.
#
# Ownership is set during COPY rather than by a later `chown -R`, which would
# duplicate the whole tree into a new layer.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/
COPY --from=build --chown=node:node /repo/packages/database/dist ./packages/database/dist
COPY --from=build --chown=node:node /repo/packages/database/package.json ./packages/database/
# The schema ships with the image so `prisma migrate deploy` can run from an
# init container or a Job against this exact revision.
COPY --from=build --chown=node:node /repo/packages/database/prisma ./packages/database/prisma
COPY --from=build --chown=node:node /repo/package.json ./

RUN mkdir -p /var/cache/tesseract && chown -R node:node /var/cache/tesseract

USER node

EXPOSE 4000

# A HEALTHCHECK is defined for Docker Compose and bare-Docker use. Kubernetes
# ignores it entirely and uses the probes on the Deployment instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:process.env.PORT||4000,path:'/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# tini as PID 1: reaps Chromium's orphans and forwards SIGTERM so Nest's
# shutdown hooks actually run.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
