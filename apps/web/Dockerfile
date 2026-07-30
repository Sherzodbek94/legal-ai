# =============================================================================
# @legaltech/web — production image
#
# Build from the REPOSITORY ROOT:
#     docker build -f apps/web/Dockerfile -t legaltech-web:latest .
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — dependencies
# -----------------------------------------------------------------------------
FROM node:22-alpine AS deps

RUN apk add --no-cache libc6-compat openssl

WORKDIR /repo

# The web app never launches a browser; skipping the Chromium download avoids
# pulling ~180MB into a stage that has no use for it. The API's own image
# installs Alpine's chromium separately.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/database/package.json ./packages/database/
# Still required even though the web app no longer depends on this package:
# `npm ci --workspaces` installs every workspace, and @prisma/client's postinstall
# runs `prisma generate`, which fails without a schema.
COPY packages/database/prisma ./packages/database/prisma

RUN npm ci --workspaces --include-workspace-root


# -----------------------------------------------------------------------------
# Stage 2 — build
# -----------------------------------------------------------------------------
FROM node:22-alpine AS build

RUN apk add --no-cache libc6-compat openssl

WORKDIR /repo
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /repo/node_modules ./node_modules
COPY . .

# NOTE: this image no longer generates the Prisma client or builds
# `@legaltech/database`. The web app does not depend on either — the dependency
# was removed in the audit because nothing imported it. If a page later needs a
# generated type, restore the dependency, `transpilePackages`, and a
# `prisma generate` step here together.

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, not read
# at runtime. That means the API URL is baked into the image and an image built
# for staging cannot be promoted to production unchanged — the CI workflow passes
# it as a build argument per environment for exactly this reason.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build --workspace=@legaltech/web


# -----------------------------------------------------------------------------
# Stage 3 — runtime
#
# Copies only the standalone output. No node_modules, no source, no build cache:
# Next's file tracing has already worked out the minimal set of files the server
# actually loads.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini for the same reason as the API image: Node does not forward signals well
# as PID 1, and a pod that ignores SIGTERM waits out its whole grace period on
# every rolling deploy.
RUN apk add --no-cache tini \
 && rm -rf /var/cache/apk/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    # Binds all interfaces. The default is localhost, which in a container means
    # the kubelet's probe cannot reach it and every pod fails readiness.
    HOSTNAME=0.0.0.0

WORKDIR /app

# `standalone` emits its own minimal node_modules and a server.js. Ownership is
# set during COPY to avoid duplicating the tree in a `chown -R` layer.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
# Static assets and the public directory are deliberately outside the standalone
# bundle and have to be copied separately — missing them yields a site that
# renders HTML with no CSS and no JS, which looks like a broken deploy rather
# than a missing COPY.
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/',timeout:4000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# Standalone puts server.js at the workspace-relative path, mirroring the source
# layout.
CMD ["node", "apps/web/server.js"]
