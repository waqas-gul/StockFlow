import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { customerSearchQuery } from '@renderer/lib/app-queries'
import { useAnchoredList } from '@renderer/lib/use-anchored-list'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { cn } from '@renderer/lib/utils'
import { CustomerOption } from './CustomerOption'

/** How many customers the suggestions hold: anything past this is narrowed by typing, not by scrolling. */
const SEARCH_LIMIT = 50

export interface CustomerSearchBoxProps {
  /** The search text itself: this box searches, it does not hold a chosen customer. */
  readonly value: string
  readonly onChange: (value: string) => void
  readonly ariaLabel: string
  readonly placeholder: string
  /** Suggest inactive customers too, when the list they filter shows them. */
  readonly includeInactive?: boolean
}

/**
 * A search box that suggests while it searches: it opens on the customer list and narrows as you type, and taking a
 * suggestion puts that customer's code and name into the search. The text stays where you left it, because the list
 * below the box is what the search is for.
 */
export function CustomerSearchBox({
  value,
  onChange,
  ariaLabel,
  placeholder,
  includeInactive = false
}: CustomerSearchBoxProps): React.JSX.Element {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const { anchor, style } = useAnchoredList(open)
  const query = useDebouncedValue(value.trim(), 150)
  const results = useQuery({
    ...customerSearchQuery({ query, limit: SEARCH_LIMIT, includeInactive }),
    enabled: open
  })
  const items = open ? (results.data ?? []) : []

  const take = (index: number): void => {
    const customer = items[index] ?? items[0]
    if (customer === undefined) return
    onChange(`${customer.code} ${customer.name}`)
    setOpen(false)
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
        onFocus={() => setOpen(true)}
        // Clicking the box again after taking a suggestion fires no focus event: open here too.
        onMouseDown={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
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
            setOpen(false)
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
          {items.map((customer, index) => (
            <li
              key={customer.id}
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
              <CustomerOption customer={customer} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
