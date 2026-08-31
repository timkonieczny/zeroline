import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    // Several suites simulate whole races at 120 Hz for eight craft. They take
    // seconds, not milliseconds, and that is the point of them.
    testTimeout: 30000,
  },
});
