import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/adapter'
import {
  createSchemaDatabase,
  createTempDir,
  insertRow,
  thrown,
  type TempDir
} from '../db/test-utils'
import { AppFailure } from '../errors'
import { createCompany, listCompanies, setCompanyActive, updateCompany } from './companies.service'

let temp: TempDir
let db: Db

beforeEach(async () => {
  temp = createTempDir()
  db = await createSchemaDatabase(temp)
})

afterEach(() => {
  temp.remove()
})

function failure(fn: () => unknown): AppFailure['error'] {
  const error = thrown(fn)
  expect(error).toBeInstanceOf(AppFailure)
  return (error as AppFailure).error
}

function rows(): unknown[] {
  return db.all('SELECT id, name, is_active, created_at, updated_at FROM companies ORDER BY id')
}

describe('companies', () => {
  it('starts empty: no company is seeded', () => {
    expect(listCompanies(db)).toEqual([])
  })

  it('creates a company with a trimmed name, active, with no products', () => {
    expect(createCompany(db, { name: '  Acme Foods  ' })).toEqual({
      id: expect.any(Number),
      name: 'Acme Foods',
      isActive: true,
      productCount: 0
    })
    expect(listCompanies(db).map((company) => company.name)).toEqual(['Acme Foods'])
  })

  it('lists companies by name, active and inactive, with their product counts', () => {
    const zeta = createCompany(db, { name: 'Zeta' })
    const acme = createCompany(db, { name: 'acme' })
    setCompanyActive(db, { id: zeta.id, active: false })
    insertRow(db, 'products', { code: 'P-1', name: 'Tea', company_id: acme.id })
    insertRow(db, 'products', { code: 'P-2', name: 'Sugar', company_id: acme.id })

    expect(listCompanies(db)).toEqual([
      { id: acme.id, name: 'acme', isActive: true, productCount: 2 },
      { id: zeta.id, name: 'Zeta', isActive: false, productCount: 0 }
    ])
  })

  it.each([
    ['the same name', 'Acme Foods'],
    ['a different letter case', 'ACME foods'],
    ['extra spaces around it', '  acme foods '],
    ['non-English letters in another case', 'ÄCME FOODS']
  ])('rejects a duplicate name given with %s, and writes nothing', (_label, name) => {
    createCompany(db, { name: 'Acme Foods' })
    if (name.startsWith('Ä')) createCompany(db, { name: 'äcme foods' })
    const before = rows()

    expect(failure(() => createCompany(db, { name }))).toEqual({
      code: 'DUPLICATE',
      message: `A company named "${name.trim()}" already exists.`,
      fieldErrors: { name: [`A company named "${name.trim()}" already exists.`] }
    })
    expect(rows()).toEqual(before)
  })

  it.each<[string, unknown, string]>([
    ['a blank name', { name: '   ' }, 'Enter the company name.'],
    ['a name over 80 characters', { name: 'x'.repeat(81) }, 'Use at most 80 characters.'],
    ['a name on two lines', { name: 'Acme\nFoods' }, 'Use a single line of text.']
  ])('rejects %s', (_label, input, message) => {
    expect(failure(() => createCompany(db, input))).toEqual({
      code: 'VALIDATION',
      message: 'Check the highlighted fields.',
      fieldErrors: { name: [message] }
    })
    expect(listCompanies(db)).toEqual([])
  })

  it('renames a company and stamps updated_at; a change of letter case of its own name is allowed', () => {
    const acme = createCompany(db, { name: 'Acme' })
    db.run("UPDATE companies SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [acme.id])

    expect(updateCompany(db, { id: acme.id, name: 'ACME Foods' })).toMatchObject({
      name: 'ACME Foods'
    })
    expect(updateCompany(db, { id: acme.id, name: 'acme foods' })).toMatchObject({
      name: 'acme foods'
    })
    const row = db.get<{ updated_at: string }>('SELECT updated_at FROM companies WHERE id = ?', [
      acme.id
    ])
    expect(row?.updated_at).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('refuses to rename a company to the name of another one', () => {
    createCompany(db, { name: 'Acme' })
    const other = createCompany(db, { name: 'Other' })
    expect(failure(() => updateCompany(db, { id: other.id, name: 'acme' }))).toMatchObject({
      code: 'DUPLICATE',
      fieldErrors: { name: ['A company named "acme" already exists.'] }
    })
    expect(listCompanies(db).map((company) => company.name)).toEqual(['Acme', 'Other'])
  })

  it('deactivates and reactivates a company; its products keep it', () => {
    const acme = createCompany(db, { name: 'Acme' })
    insertRow(db, 'products', { code: 'P-1', name: 'Tea', company_id: acme.id })

    expect(setCompanyActive(db, { id: acme.id, active: false })).toEqual({
      id: acme.id,
      name: 'Acme',
      isActive: false,
      productCount: 1
    })
    expect(db.get('SELECT company_id FROM products')).toEqual({ company_id: acme.id })
    expect(setCompanyActive(db, { id: acme.id, active: true })).toMatchObject({ isActive: true })
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM companies')?.n).toBe(1)
  })

  it('reports a company that does not exist', () => {
    const missing = { code: 'NOT_FOUND', message: 'This company no longer exists.' }
    expect(failure(() => updateCompany(db, { id: 999, name: 'X' }))).toEqual(missing)
    expect(failure(() => setCompanyActive(db, { id: 999, active: false }))).toEqual(missing)
  })

  it('refuses input that is not exactly the expected shape', () => {
    expect(failure(() => createCompany(db, { name: 'Acme', isActive: false })).code).toBe(
      'VALIDATION'
    )
    expect(failure(() => updateCompany(db, { id: '1', name: 'Acme' })).code).toBe('VALIDATION')
    expect(failure(() => setCompanyActive(db, { id: 1 })).code).toBe('VALIDATION')
  })
})
