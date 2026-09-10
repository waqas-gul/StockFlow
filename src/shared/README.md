# src/shared

Pure TypeScript shared by the main process, preload and renderer: Zod schemas, the IPC contract and
domain calculations (money, quantities, invoice maths). Import it via the `@shared/*` alias.

Code here must not import Node.js, Electron or DOM APIs. It is populated from Phase 2 onwards.
