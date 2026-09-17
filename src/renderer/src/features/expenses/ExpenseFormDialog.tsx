import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form'
import { toast } from 'sonner'
import {
  EXPENSE_DESCRIPTION_MAX,
  EXPENSE_GROUP_LABELS,
  type Expense,
  type ExpenseCategory
} from '@shared/expenses'
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
import { refreshAfterExpenseChange } from '@renderer/lib/app-queries'
import { FormField } from '../customers/FormField'
import type { CurrencyFormat } from '../products/product-display'
import { newRequestId } from '../stock/stock-actions'
import { submitExpense, type ExpenseNotifier } from './expense-actions'
import {
  emptyExpenseForm,
  expenseFormSchema,
  expenseFormValues,
  selectableCategories,
  toExpenseCreateInput,
  toExpenseUpdateInput,
  type ExpenseDraft,
  type ExpenseFormValues
} from './expense-form'

const notify: ExpenseNotifier = {
  success: (message) => toast.success(message),
  error: (message) => toast.error(message)
}

export interface ExpenseFormProps {
  /** The expense being edited; null adds a new one. */
  readonly expense: Expense | null
  readonly categories: readonly ExpenseCategory[]
  readonly currency: CurrencyFormat
  /** The local calendar day: the default and the latest date offered. */
  readonly today: string
  readonly onSaved: (expense: Expense) => void
  readonly onCancel: () => void
}

/** Add Expense / Edit Expense. */
export function ExpenseFormDialog({
  open,
  ...props
}: ExpenseFormProps & { readonly open: boolean }): React.JSX.Element {
  const editing = props.expense !== null
  return (
    <Dialog open={open} onOpenChange={(next) => !next && props.onCancel()}>
      <DialogContent
        className="sm:max-w-lg"
        // A stray click outside must not discard what was typed.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Expense' : 'Add Expense'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change the date, category, amount or description of this expense.'
              : 'Money the business spent. The category decides whether it is a Shop or a Monthly / General expense.'}
          </DialogDescription>
        </DialogHeader>
        {open && <ExpenseForm {...props} />}
      </DialogContent>
    </Dialog>
  )
}

export function ExpenseForm({
  expense,
  categories,
  currency,
  today,
  onSaved,
  onCancel
}: ExpenseFormProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const form = useForm<ExpenseFormValues, unknown, ExpenseDraft>({
    resolver: zodResolver(expenseFormSchema(currency.minorDigits)),
    defaultValues:
      expense === null ? emptyExpenseForm(today) : expenseFormValues(expense, currency.minorDigits),
    mode: 'onTouched'
  })
  const { control, register, handleSubmit, setError, formState } = form
  const { errors } = formState
  const saving = formState.isSubmitting
  // One id per new expense: a retry after a lost answer returns the expense already saved.
  const [requestId] = useState(newRequestId)
  const categoryId = useWatch({ control, name: 'categoryId' })
  const options = selectableCategories(categories, expense?.categoryId ?? null)
  const chosen = categories.find((category) => category.id === categoryId) ?? null

  const onSubmit = handleSubmit(async (draft) => {
    const saved = await submitExpense(
      window.api.expenses,
      expense === null
        ? { kind: 'create', input: toExpenseCreateInput(draft, requestId, currency.minorDigits) }
        : { kind: 'update', input: toExpenseUpdateInput(draft, expense.id, currency.minorDigits) },
      {
        notify,
        currency,
        onFieldError: (path, message) =>
          setError(path as FieldPath<ExpenseFormValues>, { type: 'server', message })
      }
    )
    // Read everything again either way: a refusal may mean the expense or a category changed meanwhile.
    refreshAfterExpenseChange(queryClient)
    if (saved !== null) onSaved(saved)
  })

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="expense-date"
          label="Date"
          error={errors.expenseDate?.message}
          hint="Today or earlier."
        >
          <Input
            id="expense-date"
            type="date"
            max={today}
            aria-invalid={errors.expenseDate ? true : undefined}
            {...register('expenseDate')}
          />
        </FormField>
        <FormField id="expense-amount" label="Amount" error={errors.amount?.message}>
          <Input
            id="expense-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            className="text-right tabular-nums"
            aria-invalid={errors.amount ? true : undefined}
            {...register('amount')}
          />
        </FormField>
      </div>
      <FormField
        id="expense-category"
        label="Category"
        error={errors.categoryId?.message}
        hint={chosen === null ? undefined : `${EXPENSE_GROUP_LABELS[chosen.group]} expense`}
      >
        <Controller
          control={control}
          name="categoryId"
          render={({ field }) => (
            <Select
              value={field.value === null ? '' : String(field.value)}
              onValueChange={(value) => {
                // Radix reports '' while a new value's option is not mounted yet; a user never picks ''.
                if (value !== '') field.onChange(Number(value))
              }}
            >
              <SelectTrigger
                id="expense-category"
                className="w-full"
                aria-invalid={errors.categoryId ? true : undefined}
                onBlur={field.onBlur}
              >
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {options.map((category) => (
                  <SelectItem key={category.id} value={String(category.id)}>
                    {category.name}
                    {category.isActive ? '' : ' (inactive)'}
                    <span className="text-muted-foreground">
                      {' '}
                      · {EXPENSE_GROUP_LABELS[category.group]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </FormField>
      <FormField
        id="expense-description"
        label="Description"
        error={errors.description?.message}
        hint="Optional."
      >
        <Input
          id="expense-description"
          maxLength={EXPENSE_DESCRIPTION_MAX}
          autoComplete="off"
          {...register('description')}
        />
      </FormField>
      {errors.root?.message && <p className="text-sm text-destructive">{errors.root.message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <LoaderCircle className="animate-spin" aria-hidden />}
          {saving ? 'Saving…' : expense === null ? 'Save Expense' : 'Save Changes'}
        </Button>
      </div>
    </form>
  )
}
