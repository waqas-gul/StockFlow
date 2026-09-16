import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import type { ProductSearchItem } from '@shared/products'
import { Input } from '@renderer/components/ui/input'
import { productSearchQuery } from '@renderer/lib/app-queries'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { cn } from '@renderer/lib/utils'

export interface ProductPickerProps {
  /** The chosen product's "code name", or '' when none is chosen. */
  readonly label: string
  readonly onPick: (product: ProductSearchItem) => void
  readonly ariaLabel: string
  readonly invalid?: boolean
  /** Also offer inactive products (adjustments); receipts need active products. */
  readonly includeInactive?: boolean
  readonly disabled?: boolean
  readonly id?: string
}

/**
 * Type a code, name or company, then pick with the mouse or the keyboard (↑ ↓ Enter; Enter alone takes the best
 * match, so a typed or scanned code followed by Enter picks that product).
 */
export function ProductPicker({
  label,
  onPick,
  ariaLabel,
  invalid,
  includeInactive = false,
  disabled,
  id
}: ProductPickerProps): React.JSX.Element {
  const listId = useId()
  const [text, setText] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const editing = text !== null
  const query = useDebouncedValue((text ?? '').trim(), 150)
  const results = useQuery({
    ...productSearchQuery({ query, limit: 10, includeInactive }),
    enabled: editing && query !== ''
  })
  const items = editing && query !== '' ? (results.data ?? []) : []

  const pick = (item: ProductSearchItem | undefined): void => {
    if (item === undefined) return
    setText(null)
    setHighlight(0)
    onPick(item)
  }

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        id={id}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-invalid={invalid ? true : undefined}
        autoComplete="off"
        placeholder="Code, product or company"
        className="pl-8"
        maxLength={100}
        disabled={disabled}
        value={text ?? label}
        onFocus={(event) => {
          setText(label)
          event.currentTarget.select()
        }}
        onBlur={() => setText(null)}
        onChange={(event) => {
          setText(event.target.value)
          setHighlight(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setHighlight((index) => Math.min(index + 1, Math.max(items.length - 1, 0)))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setHighlight((index) => Math.max(index - 1, 0))
          } else if (event.key === 'Enter' && editing) {
            event.preventDefault()
            pick(items[highlight] ?? items[0])
          } else if (event.key === 'Escape') {
            setText(null)
          }
        }}
      />
      {items.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full min-w-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((item, index) => (
            <li
              key={item.id}
              role="option"
              aria-selected={index === highlight}
              className={cn(
                'cursor-pointer rounded-sm px-2 py-1.5 text-sm',
                index === highlight && 'bg-accent text-accent-foreground'
              )}
              // Picking must happen before the input loses focus.
              onMouseDown={(event) => {
                event.preventDefault()
                pick(item)
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              <span className="font-mono text-xs">{item.code}</span>{' '}
              <span className="font-medium">{item.name}</span>
              {(item.companyName !== null || !item.isActive) && (
                <span className="text-xs text-muted-foreground">
                  {item.companyName !== null ? ` · ${item.companyName}` : ''}
                  {item.isActive ? '' : ' · inactive'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && query !== '' && results.isSuccess && items.length === 0 && (
        <p className="absolute z-50 mt-1 w-full rounded-md border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md">
          No product matches.
        </p>
      )}
    </div>
  )
}
