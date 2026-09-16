import type { IntegrityCheckReport } from '@shared/types/maintenance'
import type { Result } from '@shared/types/result'
import { unwrap } from '@renderer/lib/api'
import { errorMessage } from '@renderer/lib/format'
import { singleFlight } from '@renderer/lib/single-flight'

export type IntegrityCheckRun =
  | { readonly state: 'idle' }
  | { readonly state: 'running' }
  | { readonly state: 'done'; readonly report: IntegrityCheckReport }
  | { readonly state: 'failed'; readonly message: string }

/** Run Integrity Check: read-only in the main process. A second click while it runs does not run it again. */
export function createIntegrityCheckAction(
  api: { integrityCheck(): Promise<Result<IntegrityCheckReport>> },
  update: (run: IntegrityCheckRun) => void
): () => Promise<void> {
  return singleFlight(async () => {
    update({ state: 'running' })
    try {
      update({ state: 'done', report: await unwrap(api.integrityCheck()) })
    } catch (error) {
      update({ state: 'failed', message: errorMessage(error) })
    }
  })
}
