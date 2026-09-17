# StockFlow 1.0.0: Release Notes for the Shop Owner

## Installing

- Run `StockFlow-1.0.0-setup.exe`.
  - Windows asks for permission, because StockFlow is installed for all users in `C:\Program Files\StockFlow`.
  - You can choose another folder.
  - A Start Menu entry and a desktop shortcut are created.
- The installer is not digitally signed yet. If Windows SmartScreen says "Windows protected your PC", click **More info** and then **Run anyway**.

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
- **Stock and Customer Balance reports show current figures only**, with no "as of date".
- **Reports cannot be exported** to Excel or PDF. Invoices can be saved as PDF.
- **One computer, one user:** no network database, logins or user accounts.
- **Other decisions:** weighted-average costing; payments are not allocated to individual invoices; the installer is unsigned.
