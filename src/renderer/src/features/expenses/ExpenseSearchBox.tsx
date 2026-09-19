import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { EXPENSE_GROUP_LABELS } from '@shared/expenses'
import {
  SuggestionSearchBox,
  type Suggestion
} from '@renderer/components/common/SuggestionSearchBox'
import { expenseCategoriesQuery } from '@renderer/lib/app-queries'

export interface ExpenseSearchBoxProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly ariaLabel: string
  readonly placeholder: string
}

/**
 * A search box over the expense list, suggesting the categories. The search itself also matches an expense's
 * description, which is free text and so has nothing to suggest; the categories are a list, so they do.
 *
 * There are few enough categories to hold them all, so the typed text narrows them here rather than in a query.
 */
export function ExpenseSearchBox({
  value,
  onChange,
  ariaLabel,
  placeholder
}: ExpenseSearchBoxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const categories = useQuery({ ...expenseCategoriesQuery, enabled: open })
  const typed = value.trim().toLowerCase()
  const items: Suggestion[] = open
    ? (categories.data ?? [])
        .filter((category) => typed === '' || category.name.toLowerCase().includes(typed))
        .sort((one, other) => one.name.localeCompare(other.name))
        .map((category) => ({
          key: category.id,
          search: category.name,
          content: (
            <>
              <span className="font-medium">{category.name}</span>
              <span className="text-xs text-muted-foreground">
                {` · ${EXPENSE_GROUP_LABELS[category.group]}`}
                {category.isActive ? '' : ' · inactive'}
              </span>
            </>
          )
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
