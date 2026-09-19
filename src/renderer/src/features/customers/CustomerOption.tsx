import type { CustomerListItem } from '@shared/customers'

/** One customer as a suggestion reads: the code, the name, then whatever of shop, city and phone is known. */
export function CustomerOption({ customer }: { customer: CustomerListItem }): React.JSX.Element {
  return (
    <>
      <span className="font-mono text-xs">{customer.code}</span>{' '}
      <span className="font-medium">{customer.name}</span>
      <span className="text-xs text-muted-foreground">
        {[customer.shopName, customer.city, customer.phone]
          .filter((part) => part !== null)
          .map((part) => ` · ${part}`)
          .join('')}
      </span>
    </>
  )
}
