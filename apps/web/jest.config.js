/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts', 'tsx'],
  rootDir: '.',
  // Only `lib` for now. These are the pure decisions the pages depend on —
  // formatting, schema parsing, error unwrapping — and they need no DOM, no
  // React and no running API, so they stay fast enough to run on every commit.
  // Component tests would need a different environment and are a separate call.
  testMatch: ['<rootDir>/lib/**/*.spec.ts'],
  // `next build` copies the whole app — package.json included — into
  // .next/standalone. Jest's module map sees two packages claiming the name
  // `@legaltech/web` and warns on every run; the build output is not source.
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          // The app's tsconfig targets the Next bundler: `module: esnext` and
          // `noEmit`. Jest needs real CommonJS output, so those two are
          // overridden here rather than in the shared file, which the build
          // still reads.
          module: 'commonjs',
          moduleResolution: 'node',
          noEmit: false,
        },
      },
    ],
  },
  // Mirrors the `@/*` alias from tsconfig.json so imports read the same way in
  // a test as they do in a page.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testEnvironment: 'node',
};
