import type { Migration } from '../migrate'

/**
 * The production schema migrations, in order.
 *
 * Phase 3A deliberately ships none. `0001_initial` (the V1 business schema) is written only after the client
 * answers the plan's §27 Group A and B questions. Technical test migrations live in the tests only.
 */
export const migrations: readonly Migration[] = Object.freeze([])
