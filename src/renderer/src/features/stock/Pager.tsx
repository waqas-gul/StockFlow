import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

/** "Showing 1–20 of 45 · Page 1 of 3" with previous and next buttons. */
export function Pager({
  page,
  pageSize,
  shown,
  total,
  onPage
}: {
  page: number
  pageSize: number
  /** Rows on this page. */
  shown: number
  total: number
  onPage: (page: number) => void
}): React.JSX.Element {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const first = shown === 0 ? 0 : (page - 1) * pageSize + 1
  return (
    <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
      <span>
        Showing {first}–{(page - 1) * pageSize + shown} of {total.toLocaleString('en-US')}
      </span>
      <div className="flex items-center gap-2">
        <span>
          Page {page} of {pages}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </div>
  )
}
