# src/shared

Pure TypeScript shared by the main process, preload and renderer. Import it via the `@shared/*` alias.

- `domain/`: money (integer minor units), generic unit/quantity conversion, invoice arithmetic,
  weighted-average valuation and amount in words. Entry point: `@shared/domain`.
- `ipc-contract.ts`: every call the renderer may make (`window.api.<domain>.<action>`). The preload
  exposes exactly these and the main process handles exactly these. It has no runtime imports, because
  the sandboxed preload bundles it.
- `types/`: the IPC `Result` / `AppError` envelope and the DTO types that cross IPC (`AppInfo`).
- Zod schemas for business input are added with the services of later phases.

Code here must not import Node.js, Electron, React or DOM APIs, or use browser/Node globals. ESLint
enforces this (`no-restricted-imports` / `no-restricted-globals` for `src/shared/**`).
