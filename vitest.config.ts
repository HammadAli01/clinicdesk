import { config } from 'dotenv';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// Read .env.test into a plain object WITHOUT touching the real process.env of
// this config file. Vitest injects it into the worker processes via `test.env`,
// so a test run can never accidentally reach the development database.
const testEnv = config({
  path: '.env.test',
  quiet: true,
  processEnv: {}, // <- write into a throwaway object, not process.env
}).parsed;

if (!testEnv?.DATABASE_URL) {
  throw new Error('.env.test must exist and define DATABASE_URL');
}

// A real DATABASE_URL already in the shell wins over the file. CI sets the URL
// of its own throwaway database this way, and locally it lets you point the
// suite at a different port without editing a committed file.
const databaseUrl = process.env.DATABASE_URL ?? testEnv.DATABASE_URL;

export default defineConfig({
  plugins: [tsconfigPaths()], // makes "@/..." imports resolve in tests
  test: {
    environment: 'node',
    // Be explicit. Vitest 5's default `include` did not pick up `tests/*.test.ts`
    // here, and "No test files found" is a silent way for a suite to "pass".
    // `e2e/` is Playwright's — it has its own runner and must not load this setup.
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'e2e/**', '.next/**'],
    env: { ...testEnv, DATABASE_URL: databaseUrl },
    globalSetup: ['./tests/global-setup.ts'], // migrate the test DB once
    setupFiles: ['./tests/setup.ts'], // truncate tables before each test
    // Every test file shares ONE database. Running files in parallel would let
    // one file's TRUNCATE wipe another file's rows mid-test.
    fileParallelism: false,
    testTimeout: 20_000, // real Postgres round-trips, not mocks
  },
});
