import type { Migration } from '../migrate'
import { initialMigration } from './0001_initial'

/**
 * The production schema migrations, in order. They are forward-only: once a migration has shipped it is never
 * edited or removed, and the next schema change is a new file (0002_…) appended here.
 *
 * Each migration pins its `checksum`: the SHA-256 of its SQL script (UTF-8), written `sha256:<64 hex digits>`.
 * It is recorded in schema_migrations when the migration is applied, and never recomputed at run time. The
 * migration tests fail when a script no longer matches its pinned checksum; for a new migration, that failing test
 * reports the value to pin.
 */
export const migrations: readonly Migration[] = Object.freeze([initialMigration])
