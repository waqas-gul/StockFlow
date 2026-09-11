# src/shared

Pure TypeScript shared by the main process, preload and renderer. Import it via the `@shared/*` alias.

- `domain/`: money (integer minor units), generic unit/quantity conversion, invoice arithmetic,
  weighted-average valuation and amount in words. Entry point: `@shared/domain`.
- Zod schemas and the IPC contract are added from Phase 3 onwards.

Code here must not import Node.js, Electron, React or DOM APIs, or use browser/Node globals. ESLint
enforces this (`no-restricted-imports` / `no-restricted-globals` for `src/shared/**`).
