const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

/** An ISO-8601 time as the user's local date and time. */
export function formatDateTime(iso: string): string {
  const time = new Date(iso)
  return Number.isNaN(time.getTime()) ? '—' : dateTimeFormat.format(time)
}

/** A record count; a dash when the backup has no such table. */
export function formatCount(count: number | null): string {
  return count === null ? '—' : count.toLocaleString()
}

/** A file size in bytes, KB or MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The message of a failed call (an ApiError's message is safe to show). */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Something went wrong.'
}
