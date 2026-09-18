import './invoice-print.css'

import { formatDisplayDate } from '@shared/dates'
import type { PaperSize, PrintableInvoice } from '@shared/invoice-print'
import { salesmanPhoneText } from '@shared/invoices'
import {
  freeQuantityText,
  invoicePageCss,
  lineDiscount,
  printBalance,
  printColumns,
  printMoney,
  printQuantityRows
} from './invoice-print'

export interface InvoicePrintDocumentProps {
  readonly invoice: PrintableInvoice
  readonly paperSize: PaperSize
}

/**
 * The customer invoice as printed and saved as PDF (Phase 9B). It shows the saved invoice exactly: plain black on
 * white, bordered tables and right-aligned amounts. The header carries the shop, its address and the salesman saved
 * with the invoice; an invoice posted before they were kept shows only the shop name, as it always did. The main process prints this element's page; its data attributes
 * tell it which invoice and paper are shown.
 */
export function InvoicePrintDocument({
  invoice,
  paperSize
}: InvoicePrintDocumentProps): React.JSX.Element {
  const isVoid = invoice.status === 'VOID'
  const money = (minor: number): string => printMoney(minor, invoice.currency)
  const columns = printColumns(invoice.lines)
  const { totals } = invoice
  const deductions =
    totals.lineDiscountMinor > 0 || totals.lineSchemeMinor > 0 || totals.extraDiscountMinor > 0
  const salesmanPhones =
    invoice.salesman === null
      ? null
      : salesmanPhoneText(invoice.salesman.phone1, invoice.salesman.phone2)

  return (
    <article
      className="ip-sheet"
      data-print-document=""
      data-invoice-no={invoice.invoiceNo}
      data-paper-size={paperSize}
      data-status={invoice.status}
    >
      <style>{invoicePageCss(paperSize, invoice.invoiceNo)}</style>
      {isVoid && (
        <div className="ip-watermark" aria-hidden="true">
          VOID
        </div>
      )}

      <header className="ip-head">
        <div className="ip-seller">
          <p className="ip-business">{invoice.businessName}</p>
          {invoice.businessAddress !== null && (
            <p className="ip-address">{invoice.businessAddress}</p>
          )}
          {invoice.salesman !== null && (
            <>
              <p className="ip-salesman">
                Salesman: <span className="ip-strong">{invoice.salesman.name}</span>
              </p>
              {salesmanPhones !== null && (
                <p className="ip-salesman">{`Phone: ${salesmanPhones}`}</p>
              )}
            </>
          )}
        </div>
        <div className="ip-doc">
          <h1 className="ip-title">INVOICE</h1>
          <dl className="ip-meta">
            <Detail label="Invoice No" value={invoice.invoiceNo} />
            <Detail label="Date" value={formatDisplayDate(invoice.invoiceDate)} />
            {invoice.invoiceCode !== null && (
              <Detail label="Invoice Code" value={invoice.invoiceCode} />
            )}
          </dl>
        </div>
      </header>

      {isVoid && (
        <section className="ip-void">
          <p className="ip-void-title">VOID</p>
          <p>
            This invoice was voided on{' '}
            {invoice.voidDate === null ? '' : formatDisplayDate(invoice.voidDate)}. Reason:{' '}
            {invoice.voidReason}
          </p>
        </section>
      )}

      <section className="ip-parties">
        <div className="ip-box">
          <h2 className="ip-box-title">Bill To</h2>
          <dl className="ip-fields">
            <Detail label="Customer" value={invoice.customer.name} strong />
            <OptionalDetail label="Shop Name" value={invoice.customer.shopName} />
            <OptionalDetail label="Contact" value={invoice.customer.phone} />
            <OptionalDetail label="Address" value={invoice.customer.address} />
            <OptionalDetail label="City" value={invoice.customer.city} />
          </dl>
        </div>
        <div className="ip-box">
          <h2 className="ip-box-title">Dispatch</h2>
          <dl className="ip-fields">
            <BlankableDetail label="Bilty Number" value={invoice.dispatch.biltyNo} />
            <BlankableDetail label="Transport Service" value={invoice.dispatch.transportName} />
            <BlankableDetail label="Adda Name" value={invoice.dispatch.addaName} />
          </dl>
        </div>
      </section>

      <p className="ip-note">Amounts in {invoice.currency.symbol}</p>
      <table className="ip-items">
        <thead>
          <tr>
            <th className="ip-num">#</th>
            <th className="ip-text">Product</th>
            <th className="ip-text">Packing</th>
            <th className="ip-text">Quantity</th>
            <th className="ip-num">Price</th>
            <th className="ip-num">Gross Amount</th>
            {columns.discount && <th className="ip-num">Discount</th>}
            {columns.ctn && <th className="ip-num">Ctn</th>}
            {columns.scheme && <th className="ip-num">Sch</th>}
            <th className="ip-num">Net Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => {
            const rows = printQuantityRows(line, invoice.currency)
            const discount = lineDiscount(line, invoice.currency)
            const free = freeQuantityText(line)
            return (
              <tr key={line.lineNo}>
                <td className="ip-num">{line.lineNo}</td>
                <td className="ip-text ip-product">{line.productName}</td>
                <td className="ip-text">{line.packingLabel}</td>
                <td className="ip-text ip-nowrap">
                  {rows.map((row, index) => (
                    <div key={index}>{row.quantity}</div>
                  ))}
                </td>
                <td className="ip-num">
                  {rows.map((row, index) => (
                    <div key={index}>{row.price}</div>
                  ))}
                </td>
                <td className="ip-num">{money(line.grossMinor)}</td>
                {columns.discount && (
                  <td className="ip-num">
                    {discount !== null && (
                      <>
                        <div>{discount.amount}</div>
                        {discount.percent !== null && (
                          <div className="ip-sub">{discount.percent}</div>
                        )}
                      </>
                    )}
                  </td>
                )}
                {columns.ctn && <td className="ip-num">{line.ctnCount}</td>}
                {columns.scheme && (
                  <td className="ip-num">
                    {line.schemeMinor > 0 && <div>{money(line.schemeMinor)}</div>}
                    {free !== null && <div className="ip-sub">Free {free}</div>}
                  </td>
                )}
                <td className="ip-num ip-strong">{money(line.netMinor)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <section className="ip-closing">
        <div className="ip-summary">
          <div className="ip-words">
            <h2 className="ip-box-title">Amount in Words</h2>
            <p>{invoice.amountInWords}</p>
          </div>
          <table className="ip-totals">
            <tbody>
              {deductions && <Total label="Gross Amount" value={money(totals.grossMinor)} />}
              {totals.lineDiscountMinor > 0 && (
                <Total label="Discount" value={money(totals.lineDiscountMinor)} />
              )}
              {totals.lineSchemeMinor > 0 && (
                <Total label="Scheme" value={money(totals.lineSchemeMinor)} />
              )}
              {totals.extraDiscountMinor > 0 && (
                <Total label="Extra Discount" value={money(totals.extraDiscountMinor)} />
              )}
              <Total label="Current Invoice" value={money(totals.netMinor)} kind="strong" />
              <Total label="Freight" value={money(totals.freightMinor)} />
              <Total label="Invoice Total" value={money(totals.totalMinor)} kind="strong" />
              <Total
                label="Previous Balance"
                value={printBalance(totals.previousBalanceMinor, invoice.currency)}
              />
              <Total label="Received" value={money(totals.receivedMinor)} />
              <Total
                label="Net Outstanding"
                value={printBalance(totals.netOutstandingMinor, invoice.currency)}
                kind="grand"
              />
            </tbody>
          </table>
        </div>

        <div className="ip-sign">
          <div className="ip-sign-field">
            <span className="ip-sign-label">Checked By</span>
            <span className="ip-sign-line">{invoice.checkedBy}</span>
          </div>
          <div className="ip-sign-field">
            <span className="ip-sign-label">Signature</span>
            <span className="ip-sign-line" />
          </div>
        </div>
        <p className="ip-brand">Generated with StockFlow</p>
      </section>
    </article>
  )
}

function Detail({
  label,
  value,
  strong
}: {
  label: string
  value: string
  strong?: boolean
}): React.JSX.Element {
  return (
    <div className="ip-field">
      <dt>{label}</dt>
      <dd className={strong ? 'ip-strong' : undefined}>{value}</dd>
    </div>
  )
}

/** Left out when empty. */
function OptionalDetail({
  label,
  value
}: {
  label: string
  value: string | null
}): React.JSX.Element | null {
  return value === null ? null : <Detail label={label} value={value} />
}

/** A blank line to write on when empty. */
function BlankableDetail({
  label,
  value
}: {
  label: string
  value: string | null
}): React.JSX.Element {
  return (
    <div className="ip-field">
      <dt>{label}</dt>
      {value === null ? <dd className="ip-blank" /> : <dd>{value}</dd>}
    </div>
  )
}

function Total({
  label,
  value,
  kind
}: {
  label: string
  value: string
  kind?: 'strong' | 'grand'
}): React.JSX.Element {
  return (
    <tr className={kind === undefined ? undefined : `ip-${kind}`}>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  )
}
