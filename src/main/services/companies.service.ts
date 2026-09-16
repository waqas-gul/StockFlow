import { CompanyCreateSchema, CompanyUpdateSchema, type Company } from '@shared/companies'
import { SetActiveSchema } from '@shared/validation'
import type { Db } from '../db/adapter'
import { AppFailure, parseInput } from '../errors'

/*
 * Companies (brands) over the `companies` table. A company is never deleted: deactivating it only stops it being
 * offered for new products. Names are unique regardless of letter case; the table's NOCASE index covers English
 * letters, and the service compares every name in lower case as well, so "ÄCME" and "äcme" are one company too.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

interface CompanyRow {
  id: number
  name: string
  is_active: number
  product_count: number
}

const SELECT_COMPANIES = `
  SELECT c.id, c.name, c.is_active,
         (SELECT count(*) FROM products AS p WHERE p.company_id = c.id) AS product_count
  FROM companies AS c`

/** Every company, active or not, by name. */
export function listCompanies(db: Db): Company[] {
  return db
    .all<CompanyRow>(`${SELECT_COMPANIES} ORDER BY c.name COLLATE NOCASE, c.id`)
    .map(toCompany)
}

export function createCompany(db: Db, input: unknown): Company {
  const { name } = parseInput(CompanyCreateSchema, input)
  return db.transaction(() => {
    assertNameFree(db, name, null)
    const { lastInsertRowid } = db.run('INSERT INTO companies (name) VALUES (?)', [name])
    return readCompany(db, Number(lastInsertRowid))
  })
}

/** Renames a company. */
export function updateCompany(db: Db, input: unknown): Company {
  const { id, name } = parseInput(CompanyUpdateSchema, input)
  return db.transaction(() => {
    readCompany(db, id)
    assertNameFree(db, name, id)
    db.run(`UPDATE companies SET name = ?, updated_at = ${NOW} WHERE id = ?`, [name, id])
    return readCompany(db, id)
  })
}

/** Activates or deactivates a company. Its products keep it either way. */
export function setCompanyActive(db: Db, input: unknown): Company {
  const { id, active } = parseInput(SetActiveSchema, input)
  return db.transaction(() => {
    const company = readCompany(db, id)
    if (company.isActive !== active) {
      db.run(`UPDATE companies SET is_active = ?, updated_at = ${NOW} WHERE id = ?`, [
        active ? 1 : 0,
        id
      ])
    }
    return readCompany(db, id)
  })
}

/** The company, or NOT_FOUND. */
export function readCompany(db: Db, id: number): Company {
  const row = db.get<CompanyRow>(`${SELECT_COMPANIES} WHERE c.id = ?`, [id])
  if (row === undefined) {
    throw new AppFailure({ code: 'NOT_FOUND', message: 'This company no longer exists.' })
  }
  return toCompany(row)
}

function assertNameFree(db: Db, name: string, ownId: number | null): void {
  const wanted = name.toLowerCase()
  const taken = db
    .all<{ id: number; name: string }>('SELECT id, name FROM companies')
    .some((row) => row.id !== ownId && row.name.toLowerCase() === wanted)
  if (taken) {
    const message = `A company named "${name}" already exists.`
    throw new AppFailure({ code: 'DUPLICATE', message, fieldErrors: { name: [message] } })
  }
}

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active === 1,
    productCount: row.product_count
  }
}
