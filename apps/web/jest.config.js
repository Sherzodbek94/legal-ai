/**
 * Two projects, because the two kinds of test need different environments and
 * pulling a DOM into the pure ones would only make them slower.
 *
 *   lib        — formatting, parsing, conversion. No DOM, no React.
 *   components — client components under jsdom, driven the way a user drives
 *                them rather than by reaching into state.
 */

/** ts-jest options shared by both projects. */
const transform = (jsx) => ({
  '^.+\\.tsx?$': [
    'ts-jest',
    {
      tsconfig: {
        // The app's tsconfig targets the Next bundler: `module: esnext`,
        // `jsx: preserve` and `noEmit`. Jest needs real CommonJS and real JSX
        // output, so those are overridden here rather than in the shared file,
        // which the build still reads.
        module: 'commonjs',
        moduleResolution: 'node',
        noEmit: false,
        jsx,
      },
    },
  ],
});

const shared = {
  rootDir: '.',
  moduleFileExtensions: ['js', 'json', 'ts', 'tsx'],
  // Mirrors the `@/*` alias from tsconfig.json so imports read the same way in
  // a test as they do in a page.
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  // `next build` copies the whole app — package.json included — into
  // .next/standalone. Jest's module map sees two packages claiming the name
  // `@legaltech/web` and warns on every run; the build output is not source.
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
};

module.exports = {
  projects: [
    {
      ...shared,
      displayName: 'lib',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/lib/**/*.spec.ts'],
      transform: transform('react-jsx'),
    },
    {
      ...shared,
      displayName: 'components',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/components/**/*.spec.tsx'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
      transform: transform('react-jsx'),
    },
  ],
};
