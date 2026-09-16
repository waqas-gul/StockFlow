import { z } from 'zod'
import { IdSchema, requiredText } from './validation'

/*
 * Companies (brands) that products belong to. A company is never deleted: an inactive one is no longer offered for
 * new products, but stays on the products and documents that use it.
 */

export const COMPANY_NAME_MAX = 80

export const CompanyNameSchema = requiredText('company name', COMPANY_NAME_MAX)

/** `window.api.companies.create(...)`. */
export const CompanyCreateSchema = z.strictObject({ name: CompanyNameSchema })
export type CompanyCreateInput = z.output<typeof CompanyCreateSchema>

/** `window.api.companies.update(...)`: rename. */
export const CompanyUpdateSchema = z.strictObject({ id: IdSchema, name: CompanyNameSchema })
export type CompanyUpdateInput = z.output<typeof CompanyUpdateSchema>

export interface Company {
  readonly id: number
  readonly name: string
  readonly isActive: boolean
  /** Products (active or not) that belong to it. */
  readonly productCount: number
}
