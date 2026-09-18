import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Plus, Power, PowerOff, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Company } from '@shared/companies'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@renderer/components/ui/table'
import { unwrap } from '@renderer/lib/api'
import { companiesQuery } from '@renderer/lib/app-queries'
import { errorMessage } from '@renderer/lib/format'
import { queryKeys } from '@renderer/lib/query-keys'

/** Manage Companies: add, rename, activate or deactivate. Companies are never deleted. */
export function CompaniesDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage Brands / Companies</DialogTitle>
          <DialogDescription>
            A brand / company is the maker or brand of a product, not the supplier you buy from
            (suppliers have their own page). An inactive company is not offered for new products,
            but stays on the products that have it.
          </DialogDescription>
        </DialogHeader>
        <CompaniesManager />
      </DialogContent>
    </Dialog>
  )
}

export function CompaniesManager(): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: companies, error } = useQuery(companiesQuery)
  const [newName, setNewName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: number; name: string; error: string | null } | null>(
    null
  )
  const [busy, setBusy] = useState(false)

  /** Runs one change; the lists of companies and products are refreshed afterwards. */
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies })
      void queryClient.invalidateQueries({ queryKey: queryKeys.products.all })
    }
  }

  const add = async (): Promise<void> => {
    setAddError(null)
    const company = await run(
      () => unwrap(window.api.companies.create({ name: newName })),
      setAddError
    )
    if (company) {
      setNewName('')
      toast.success(`Company ${company.name} added.`)
    }
  }

  const rename = async (): Promise<void> => {
    if (editing === null) return
    const target = editing
    const company = await run(
      () => unwrap(window.api.companies.update({ id: target.id, name: target.name })),
      (message) => setEditing({ ...target, error: message })
    )
    if (company) {
      setEditing(null)
      toast.success(`Company renamed to ${company.name}.`)
    }
  }

  const toggle = async (company: Company): Promise<void> => {
    const updated = await run(
      () => unwrap(window.api.companies.setActive({ id: company.id, active: !company.isActive })),
      (message) => toast.error(message)
    )
    if (updated)
      toast.success(`Company ${updated.name} ${updated.isActive ? 'activated' : 'deactivated'}.`)
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
        <div className="flex gap-2">
          <Input
            aria-label="New company name"
            placeholder="New company name"
            maxLength={80}
            value={newName}
            aria-invalid={addError ? true : undefined}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button type="submit" disabled={busy}>
            <Plus aria-hidden />
            Add company
          </Button>
        </div>
        {addError && <p className="text-sm text-destructive">{addError}</p>}
      </form>

      {error ? (
        <p className="text-sm text-destructive">{error.message}</p>
      ) : !companies ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : companies.length === 0 ? (
        <p className="text-sm text-muted-foreground">No companies yet.</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Company</TableHead>
                <TableHead className="text-right">Products</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-3 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.map((company) => (
                <TableRow key={company.id}>
                  <TableCell className="pl-3 whitespace-normal">
                    {editing?.id === company.id ? (
                      <div className="flex flex-col gap-1">
                        <Input
                          aria-label={`New name for ${company.name}`}
                          maxLength={80}
                          value={editing.name}
                          autoFocus
                          onChange={(event) =>
                            setEditing({ ...editing, name: event.target.value, error: null })
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void rename()
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
                    ) : (
                      company.name
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{company.productCount}</TableCell>
                  <TableCell>
                    {company.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell className="pr-3 text-right">
                    {editing?.id === company.id ? (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" disabled={busy} onClick={() => void rename()}>
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
                    ) : (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            setEditing({ id: company.id, name: company.name, error: null })
                          }
                        >
                          <Pencil aria-hidden />
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void toggle(company)}
                        >
                          {company.isActive ? <PowerOff aria-hidden /> : <Power aria-hidden />}
                          {company.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
