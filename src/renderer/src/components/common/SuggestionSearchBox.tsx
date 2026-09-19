import { useId, useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { useAnchoredList } from '@renderer/lib/use-anchored-list'
import { cn } from '@renderer/lib/utils'

/** One row of a suggestion list: what it looks like, and the text taking it puts into the box. */
export interface Suggestion {
  readonly key: number | string
  /** What the search box is set to when this row is taken. */
  readonly search: string
  readonly content: React.ReactNode
}

export interface SuggestionSearchBoxProps {
  /** The search text itself: this box searches a list below it, it does not hold a chosen thing. */
  readonly value: string
  readonly onChange: (value: string) => void
  readonly ariaLabel: string
  readonly placeholder: string
  /** True while the box is open, so the caller can fetch only then. */
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** What to suggest for the current text; empty closes the list. */
  readonly items: readonly Suggestion[]
}

/**
 * A search box that suggests while it searches. It opens on the whole list and narrows as the text is typed, and
 * taking a suggestion puts that row's text into the search, so the table under the box narrows to it. The text stays
 * where it is left, because searching is the point: nothing is "chosen", so nothing snaps back.
 *
 * The caller owns the text and the open flag, and passes the rows to show; every picker-like behaviour (the keyboard,
 * the highlight, where the list hangs) lives here.
 */
export function SuggestionSearchBox({
  value,
  onChange,
  ariaLabel,
  placeholder,
  open,
  onOpenChange,
  items
}: SuggestionSearchBoxProps): React.JSX.Element {
  const listId = useId()
  const [highlight, setHighlight] = useState(0)
  const { anchor, style } = useAnchoredList(open)

  const take = (index: number): void => {
    const suggestion = items[index] ?? items[0]
    if (suggestion === undefined) return
    onChange(suggestion.search)
    onOpenChange(false)
    setHighlight(0)
  }

  return (
    <div ref={anchor} className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        autoComplete="off"
        placeholder={placeholder}
        className="pl-8"
        maxLength={100}
        value={value}
        onFocus={() => onOpenChange(true)}
        // Clicking the box again after taking a suggestion fires no focus event: open here too.
        onMouseDown={() => onOpenChange(true)}
        onBlur={() => onOpenChange(false)}
        onChange={(event) => {
          onChange(event.target.value)
          onOpenChange(true)
          setHighlight(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setHighlight((index) => Math.min(index + 1, Math.max(items.length - 1, 0)))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlight((index) => Math.max(index - 1, 0))
          } else if (event.key === 'Enter' && items.length > 0) {
            event.preventDefault()
            take(highlight)
          } else if (event.key === 'Escape') {
            onOpenChange(false)
          }
        }}
      />
      {items.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          style={style}
          className="fixed z-50 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((suggestion, index) => (
            <li
              key={suggestion.key}
              role="option"
              aria-selected={index === highlight}
              className={cn(
                'cursor-pointer rounded-sm px-2 py-1.5 text-sm',
                index === highlight && 'bg-accent text-accent-foreground'
              )}
              // Taking the suggestion must happen before the input loses focus.
              onMouseDown={(event) => {
                event.preventDefault()
                take(index)
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              {suggestion.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
