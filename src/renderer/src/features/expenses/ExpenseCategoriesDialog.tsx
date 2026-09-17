import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Plus, Power, PowerOff, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  EXPENSE_CATEGORY_NAME_MAX,
  EXPENSE_GROUPS,
  EXPENSE_GROUP_LABELS,
  type ExpenseCategory,
  type ExpenseGroup
} from '@shared/expenses'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { unwrap } from '@renderer/lib/api'
import { expenseCategoriesQuery, refreshAfterExpenseChange } from '@renderer/lib/app-queries'
import { errorMessage } from '@renderer/lib/format'

/** Manage Categories: add, rename, change group, activate or deactivate. Categories are never deleted. */
export function ExpenseCategoriesDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Manage Categories</DialogTitle>
          <DialogDescription>
            Each category is a Shop or a Monthly / General expense. An inactive category is not
            offered for new expenses, but stays on the expenses that have it.
          </DialogDescription>
        </DialogHeader>
        <ExpenseCategoriesManager />
      </DialogContent>
    </Dialog>
  )
}

interface Editing {
  readonly id: number
  readonly name: string
  readonly group: ExpenseGroup
  readonly error: string | null
}

function GroupSelect({
  value,
  label,
  disabled,
  onChange
}: {
  value: ExpenseGroup
  label: string
  disabled?: boolean
  onChange: (group: ExpenseGroup) => void
}): React.JSX.Element {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
        if (next !== '') onChange(next as ExpenseGroup)
      }}
    >
      <SelectTrigger aria-label={label} className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {EXPENSE_GROUPS.map((group) => (
          <SelectItem key={group} value={group}>
            {EXPENSE_GROUP_LABELS[group]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ExpenseCategoriesManager(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: categories, error } = useQuery(expenseCategoriesQuery)
  const [newName, setNewName] = useState('')
  const [newGroup, setNewGroup] = useState<ExpenseGroup>('SHOP')
  const [addError, setAddError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [busy, setBusy] = useState(false)

  /** Runs one change; categories and expenses (their category names and group totals) are read again afterwards. */
  const run = async <T,>(
    change: () => Promise<T>,
    onError: (message: string) => void
  ): Promise<T | null> => {
    if (busy) return null
    setBusy(true)
    try {
      return await change()
    } catch (failure) {
      onError(errorMessage(failure))
      return null
    } finally {
      setBusy(false)
      refreshAfterExpenseChange(queryClient)
    }
  }

  const add = async (): Promise<void> => {
    setAddError(null)
    const category = await run(
      () => unwrap(window.api.expenseCategories.create({ name: newName, group: newGroup })),
      setAddError
    )
    if (category) {
      setNewName('')
      toast.success(`Category ${category.name} added (${EXPENSE_GROUP_LABELS[category.group]}).`)
    }
  }

  const save = async (): Promise<void> => {
    if (editing === null) return
    const target = editing
    const category = await run(
      () =>
        unwrap(
          window.api.expenseCategories.update({
            id: target.id,
            name: target.name,
            group: target.group
          })
        ),
      (message) => setEditing({ ...target, error: message })
    )
    if (category) {
      setEditing(null)
      toast.success(`Category ${category.name} saved (${EXPENSE_GROUP_LABELS[category.group]}).`)
    }
  }

  const toggle = async (category: ExpenseCategory): Promise<void> => {
    const updated = await run(
      () =>
        unwrap(
          window.api.expenseCategories.setActive({ id: category.id, active: !category.isActive })
        ),
      (message) => toast.error(message)
    )
    if (updated) {
      toast.success(`Category ${updated.name} ${updated.isActive ? 'activated' : 'deactivated'}.`)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="New category name"
            placeholder="New category name"
            className="min-w-56 flex-1"
            maxLength={EXPENSE_CATEGORY_NAME_MAX}
            value={newName}
            aria-invalid={addError ? true : undefined}
            onChange={(event) => setNewName(event.target.value)}
          />
          <GroupSelect value={newGroup} label="New category group" onChange={setNewGroup} />
          <Button type="submit" disabled={busy}>
            <Plus aria-hidden />
            Add Category
          </Button>
        </div>
        {addError && <p className="text-sm text-destructive">{addError}</p>}
      </form>

      {error ? (
        <p className="text-sm text-destructive">{error.message}</p>
      ) : !categories ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Category</TableHead>
                <TableHead>Group</TableHead>
                <TableHead className="text-right">Expenses</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-3 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((category) =>
                editing?.id === category.id ? (
                  <TableRow key={category.id}>
                    <TableCell className="pl-3 whitespace-normal">
                      <div className="flex flex-col gap-1">
                        <Input
                          aria-label={`New name for ${category.name}`}
                          maxLength={EXPENSE_CATEGORY_NAME_MAX}
                          value={editing.name}
                          autoFocus
                          onChange={(event) =>
                            setEditing({ ...editing, name: event.target.value, error: null })
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void save()
                            if (event.key === 'Escape') {
                              event.stopPropagation()
                              setEditing(null)
                            }
                          }}
                        />
                        {editing.error && (
                          <p className="text-sm text-destructive">{editing.error}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <GroupSelect
                        value={editing.group}
                        label={`Group for ${category.name}`}
                        onChange={(group) => setEditing({ ...editing, group, error: null })}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {category.expenseCount}
                    </TableCell>
                    <TableCell>
                      <CategoryStatus category={category} />
                    </TableCell>
                    <TableCell className="pr-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" disabled={busy} onClick={() => void save()}>
                          <Check aria-hidden />
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditing(null)}
                        >
                          <X aria-hidden />
                          Cancel
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={category.id}>
                    <TableCell className="pl-3 whitespace-normal">{category.name}</TableCell>
                    <TableCell>{EXPENSE_GROUP_LABELS[category.group]}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {category.expenseCount}
                    </TableCell>
                    <TableCell>
                      <CategoryStatus category={category} />
                    </TableCell>
                    <TableCell className="pr-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            setEditing({
                              id: category.id,
                              name: category.name,
                              group: category.group,
                              error: null
                            })
                          }
                        >
                          <Pencil aria-hidden />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void toggle(category)}
                        >
                          {category.isActive ? <PowerOff aria-hidden /> : <Power aria-hidden />}
                          {category.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Changing a category&apos;s group also moves its existing expenses into that group&apos;s
        totals.
      </p>
    </div>
  )
}

function CategoryStatus({ category }: { category: ExpenseCategory }): React.JSX.Element {
  return category.isActive ? (
    <Badge variant="success">Active</Badge>
  ) : (
    <Badge variant="secondary">Inactive</Badge>
  )
}
