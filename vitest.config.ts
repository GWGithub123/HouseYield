import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    restoreMocks: true,
    // `e2e/` holds Playwright specs, which throw on import under vitest
    // because `test.describe` is not vitest's. They run via `npx playwright test`.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
  },
});
