# StockFlow 1.0.0: Release Notes for the Shop Owner

## Installing

- Run `StockFlow-1.0.0-setup.exe`.
  - Windows asks for permission, because StockFlow is installed for all users in `C:\Program Files\StockFlow`.
  - You can choose another folder.
  - A Start Menu entry and a desktop shortcut are created.
- The installer is not digitally signed yet. If Windows SmartScreen says "Windows protected your PC", click **More info** and then **Run anyway**.

## Before you enter any prices or invoices

Check these in Settings first, because they lock:

- **Currency code, symbol and decimal places** lock once any price, stock, invoice, payment, expense, customer balance or supplier balance has been entered. Old invoices always reprint in the same currency.
- **Invoice starting number** locks once the first invoice has been created. Later invoices simply continue the numbering.

## Suppliers and what you owe them

- **Suppliers** (sidebar) are the people and firms you buy stock from. They are not the product's **Brand / Company**.
- On **Stock In**, choose the supplier: the receipt total is added to what you owe them. Money you pay at delivery goes in **Paid Now**. Pay later with **Pay Supplier** (Suppliers page, a supplier's page or the Dashboard).
- Paying more than you owe is allowed: the extra shows as a supplier **Advance**.
- Voiding a receipt removes the purchase from the supplier account but **keeps any payment made with it** (as an advance). If the supplier gave the money back, void that payment too.
- Stock corrections change stock only. If a supplier's bill changed, use **Adjust Balance** on the supplier's page.
- Supplier purchases and payments are **not expenses** and never appear in Profit & Loss: the goods reach profit only when they are sold.
- **Already owe an old supplier?** Receipts entered before this update are not linked to any supplier account. Add the supplier and enter what you owe them **today** as the **Opening Balance**.

## Where your data is kept

- Everything you enter is stored in `%APPDATA%\StockFlow\data\shop.db` (for example `C:\Users\<you>\AppData\Roaming\StockFlow\data\shop.db`).
  - The same StockFlow folder also holds `backups`, `logs` and `recovery`.
- Settings → About shows the data folder.
- The data is **per Windows user** and is **never** kept in the Program Files folder.

## Automatic backups

- StockFlow makes a checked backup the first time it opens each day, and when you close it (at most one an hour).
- They are kept in `%APPDATA%\StockFlow\backups\auto`: the last 14 days, plus one per month for 12 months.
- Before a new StockFlow version changes the database, a backup is made in `backups\pre-migration`. Before a restore, the current data is copied to `backups\pre-restore`.
- If a backup fails (for example, the disk is full), StockFlow keeps working. The top bar shows **Backup failed** within about a minute, and Settings shows the reason.

## Making a backup on a USB drive (recommended weekly)

1. Plug in the USB drive.
2. Settings → Backup & Restore → **Backup Now**.
3. Choose the USB drive and click **Save backup**. StockFlow checks the copy before it says it is saved.

A backup on the same computer does not protect you if the computer is lost or its disk fails.

## Restoring a backup

1. Settings → Backup & Restore → **Restore Backup**
2. Choose the backup file. StockFlow checks it and shows its date and how many products, customers and invoices it holds.
3. Type `RESTORE` to confirm.

StockFlow first saves the current data in `backups\pre-restore`, then restarts with the restored data.

If StockFlow cannot open its database at all, it offers **Restore Backup** by itself when it starts. The damaged file is kept in `%APPDATA%\StockFlow\recovery`.

## Updating to a newer version

- Close StockFlow and run the new installer. Your data in `%APPDATA%\StockFlow` is kept.
- The first start of the new version makes a pre-migration backup, if the database needs upgrading.
- There is no automatic updater: updates are always a new installer you run yourself.
- An older StockFlow will not open data from a newer version. It says so and changes nothing.

## Uninstalling

- Uninstalling removes the program only. **Your data, backups and logs in `%APPDATA%\StockFlow` stay**, so reinstalling brings everything back.
- To remove the data as well, delete that folder yourself after making a USB backup.

## Known limitations of V1

- **No sales returns.** Undo a mistaken invoice by voiding it.
- **No closed accounting periods.** Back-dated documents are allowed, down to each product's and customer's latest activity.
- **Historical COGS is frozen when an invoice is posted.** A later purchase-cost correction changes future inventory cost and future COGS, not old invoices.
- **Receipt cost corrections are not profit or loss by themselves.** They change the stock value, and that reaches profit through the cost of goods sold later. Profit & Loss lists them separately, for information only.
- **The Purchase Cost Correction expense category is fixed.** Reports use it, so its name and group cannot be changed; it can still be deactivated.
- **Stock and Customer Balance reports show current figures only**, with no "as of date".
- **Reports cannot be exported** to Excel or PDF. Invoices can be saved as PDF.
- **One computer, one user:** no network database, logins or user accounts.
- **Other decisions:** weighted-average costing; payments are not allocated to individual invoices; the installer is unsigned.
