/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  // The registration and invitation-acceptance specs hash real passwords at
  // cost 12. That is deliberate — a test against a weakened cost factor would
  // not exercise the production path — but it makes those cases take a few
  // hundred milliseconds each, and with every worker hashing at once they
  // intermittently overran the 5s default. The work is genuinely slow, not
  // stuck, so the timeout is what needed to move.
  testTimeout: 30_000,
};
