import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  SuggestionSearchBox,
  type Suggestion
} from '@renderer/components/common/SuggestionSearchBox'
import { supplierSearchQuery } from '@renderer/lib/app-queries'
import { useDebouncedValue } from '@renderer/lib/use-debounced-value'
import { SupplierOption } from './SupplierOption'

/** How many suppliers the suggestions hold: anything past this is narrowed by typing, not by scrolling. */
const SEARCH_LIMIT = 50

export interface SupplierSearchBoxProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly ariaLabel: string
  readonly placeholder: string
  /** Suggest retired suppliers too, when the list they filter shows them. */
  readonly includeInactive?: boolean
}

/** A search box over a list of suppliers, suggesting the suppliers themselves: code and name go into the search. */
export function SupplierSearchBox({
  value,
  onChange,
  ariaLabel,
  placeholder,
  includeInactive = false
}: SupplierSearchBoxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const query = useDebouncedValue(value.trim(), 150)
  const results = useQuery({
    ...supplierSearchQuery({ query, limit: SEARCH_LIMIT, includeInactive }),
    enabled: open
  })
  const items: Suggestion[] = open
    ? (results.data ?? []).map((supplier) => ({
        key: supplier.id,
        search: `${supplier.code} ${supplier.name}`,
        content: <SupplierOption supplier={supplier} />
      }))
    : []

  return (
    <SuggestionSearchBox
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      open={open}
      onOpenChange={setOpen}
      items={items}
    />
  )
}
