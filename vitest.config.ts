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
      // Measured and enforced: the shared code (Phase 2 domain library, Result envelope, IPC contract), the
      // Phase 3A database/IPC foundation and the Phase 4A data-safety engine (backups, restore, integrity,
      // logging, settings). Electron entry points (main/index, window, security, paths, preload/index) need the
      // Electron app itself and are verified by launching it.
      include: [
        'src/shared/**/*.ts',
        'src/main/app-info.ts',
        'src/main/data-paths.ts',
        'src/main/errors.ts',
        'src/main/logging.ts',
        'src/main/db/**/*.ts',
        'src/main/ipc/**/*.ts',
        'src/main/services/**/*.ts',
        'src/preload/api.ts',
        'src/renderer/src/lib/api.ts',
        'src/renderer/src/components/common/AboutCard.tsx'
      ],
      exclude: ['**/*.test.{ts,tsx}', '**/test-utils.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
        // The Phase 2 domain library must also reach 95% on its own (plan §25).
        'src/shared/domain/**/*.ts': { statements: 95, branches: 95, functions: 95, lines: 95 }
      }
    }
  }
})
