import {
  DUPLICATE_EXPENSE_CATEGORY_MESSAGE,
  EXPENSE_CATEGORY_GROUP_LOCKED_MESSAGE,
  ExpenseCategoryCreateSchema,
  ExpenseCategoryUpdateSchema,
  type ExpenseCategory,
  type ExpenseGroup
} from '@shared/expenses'
import { SetActiveSchema } from '@shared/validation'
import type { Db } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'

/*
 * Expense categories over the `expense_categories` table (the four seeded ones included). A category is never deleted:
 * deactivating it only stops it being chosen for another expense. Its name may always change. Its group (SHOP / GENERAL)
 * may change only until an expense (active or void) first uses it: expenses keep no copy of their category's group, so
 * locking it keeps every past expense in the group it was recorded in (Phase 11 reports rely on this). Names are unique
 * regardless of letter case (the table's NOCASE index covers English letters; the service also compares in lower case).
 */

interface CategoryRow {
  id: number
  name: string
  grp: ExpenseGroup
  is_active: number
  expense_count: number
}

const SELECT_CATEGORIES = `
  SELECT c.id, c.name, c.grp, c.is_active,
         (SELECT count(*) FROM expenses AS e WHERE e.category_id = c.id) AS expense_count
  FROM expense_categories AS c`

/** Every category, active or not, by name. */
export function listExpenseCategories(db: Db): ExpenseCategory[] {
  return db
    .all<CategoryRow>(`${SELECT_CATEGORIES} ORDER BY c.name COLLATE NOCASE, c.id`)
    .map(toCategory)
}

export function createExpenseCategory(db: Db, input: unknown): ExpenseCategory {
  const { name, group } = parseInput(ExpenseCategoryCreateSchema, input)
  return db.transaction(() => {
    assertNameFree(db, name, null)
    const { lastInsertRowid } = db.run('INSERT INTO expense_categories (name, grp) VALUES (?, ?)', [
      name,
      group
    ])
    return readExpenseCategory(db, Number(lastInsertRowid))
  })
}

/** Renames a category and/or moves an unused one to the other group. */
export function updateExpenseCategory(db: Db, input: unknown): ExpenseCategory {
  const { id, name, group } = parseInput(ExpenseCategoryUpdateSchema, input)
  return db.transaction(() => {
    const current = readExpenseCategory(db, id)
    if (group !== current.group && current.expenseCount > 0) {
      throw new AppFailure({
        code: 'FORBIDDEN_STATE',
        message: EXPENSE_CATEGORY_GROUP_LOCKED_MESSAGE,
        fieldErrors: { group: [EXPENSE_CATEGORY_GROUP_LOCKED_MESSAGE] }
      })
    }
    assertNameFree(db, name, id)
    db.run('UPDATE expense_categories SET name = ?, grp = ? WHERE id = ?', [name, group, id])
    return readExpenseCategory(db, id)
  })
}

/** Activates or deactivates a category. Its expenses keep it either way. */
export function setExpenseCategoryActive(db: Db, input: unknown): ExpenseCategory {
  const { id, active } = parseInput(SetActiveSchema, input)
  return db.transaction(() => {
    const category = readExpenseCategory(db, id)
    if (category.isActive !== active) {
      db.run('UPDATE expense_categories SET is_active = ? WHERE id = ?', [active ? 1 : 0, id])
    }
    return readExpenseCategory(db, id)
  })
}

/** The category, or NOT_FOUND (with `field` naming the input it came from). */
export function readExpenseCategory(db: Db, id: number, field?: string): ExpenseCategory {
  const row = db.get<CategoryRow>(`${SELECT_CATEGORIES} WHERE c.id = ?`, [id])
  if (row === undefined) {
    const message = 'This expense category no longer exists.'
    throw new AppFailure({
      code: 'NOT_FOUND',
      message,
      ...(field === undefined ? {} : { fieldErrors: { [field]: [message] } })
    })
  }
  return toCategory(row)
}

function assertNameFree(db: Db, name: string, ownId: number | null): void {
  const wanted = name.toLowerCase()
  const taken = db
    .all<{ id: number; name: string }>('SELECT id, name FROM expense_categories')
    .some((row) => row.id !== ownId && row.name.toLowerCase() === wanted)
  if (taken) {
    throw new AppFailure({
      code: 'DUPLICATE',
      message: DUPLICATE_EXPENSE_CATEGORY_MESSAGE,
      fieldErrors: { name: [DUPLICATE_EXPENSE_CATEGORY_MESSAGE] }
    })
  }
}

function toCategory(row: CategoryRow): ExpenseCategory {
  return {
    id: row.id,
    name: row.name,
    group: row.grp,
    isActive: row.is_active === 1,
    expenseCount: row.expense_count
  }
}
