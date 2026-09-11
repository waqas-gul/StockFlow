import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Measured and enforced for the pure shared domain library (plan §25, Phase 2: ≥ 95%).
      include: ['src/shared/domain/**/*.ts'],
      exclude: ['src/shared/domain/**/*.test.ts', 'src/shared/domain/test-utils.ts'],
      reporter: ['text', 'html'],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 }
    }
  }
})
