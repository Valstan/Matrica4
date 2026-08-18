import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Тесты гоняются без предварительной сборки контракта.
      '@matrica4/contract': fileURLToPath(new URL('../contract/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
  },
});
