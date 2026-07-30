const path = require('node:path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // NOTE: `transpilePackages: ['@legaltech/database']` was removed along with the
  // dependency itself — nothing in this app imported it. Re-add both together if
  // a page ever needs a generated Prisma type.

  /**
   * Emits a self-contained server bundle in `.next/standalone`.
   *
   * This is what makes a small production image possible: the runtime stage
   * copies that directory instead of the whole `node_modules` tree, which for
   * this workspace includes Puppeteer's Chromium download and every dev
   * dependency in the monorepo.
   */
  output: 'standalone',

  /**
   * Required in a monorepo.
   *
   * File tracing defaults to the app directory, so without this it never walks
   * up to the workspace root and the standalone bundle is missing
   * `@legaltech/database` and the hoisted `node_modules` — which fails at
   * container start, not at build.
   */
  outputFileTracingRoot: path.join(__dirname, '../../'),

  /** Removes the framework header; it advertises the stack for no benefit. */
  poweredByHeader: false,
};

module.exports = nextConfig;
