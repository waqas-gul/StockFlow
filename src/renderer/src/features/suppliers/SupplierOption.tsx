import type { SupplierListItem } from '@shared/suppliers'

/** One supplier as a suggestion reads: the code, the name, then contact, city and phone, and whether it is retired. */
export function SupplierOption({ supplier }: { supplier: SupplierListItem }): React.JSX.Element {
  return (
    <>
      <span className="font-mono text-xs">{supplier.code}</span>{' '}
      <span className="font-medium">{supplier.name}</span>
      <span className="text-xs text-muted-foreground">
        {[supplier.contactPerson, supplier.city, supplier.phone]
          .filter((part) => part !== null)
          .map((part) => ` · ${part}`)
          .join('')}
        {supplier.isActive ? '' : ' · inactive'}
      </span>
    </>
  )
}
