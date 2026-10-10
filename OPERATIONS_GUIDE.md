# Big Bozz Fitness Operations Guide

This guide covers local setup, membership handling, payment confirmation, backups, and day-to-day use of the gym dashboard.

## 1. First-time setup on Windows

Use Node.js 20.19 or newer. From PowerShell, open the project folder and create a private configuration folder outside the OneDrive-synced project:

```powershell
$privateDir = Join-Path $env:LOCALAPPDATA 'BigBozzFitness'
New-Item -ItemType Directory -Force -Path $privateDir | Out-Null
Copy-Item .env.example (Join-Path $privateDir '.env')
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Open `%LOCALAPPDATA%\BigBozzFitness\.env` in a text editor. Replace `ADMIN_PASSWORD` with your own unique password (at least 12 characters). Paste the generated random value into `SESSION_SECRET`. On the first run, the app hashes `ADMIN_PASSWORD` into the private SQLite `admin_settings` table. After that, change passwords from **Security** in the dashboard; the saved hash is authoritative, and changing `.env` will not reset it. This keeps the secrets and private database outside the synced website project. Do not share `.env`.

Install the locked dependencies once, then start the app:

```powershell
npm ci
npm start
```

Open `http://localhost:3000` in a browser, select **Owner Login**, and use the username and password you set in the private `.env` file. Leave the server terminal running while using the dashboard. Stop it with Ctrl+C when finished.

On Windows, the database and backups are stored under `%LOCALAPPDATA%\BigBozzFitness`, outside the OneDrive-synced website folder and outside the public web root. On other systems the default is a private sibling folder. Set `DATA_DIR` in the environment file only if you need a different private location; it must remain outside the application directory. `ENV_FILE` can point to an alternate configuration file.

## 2. Register and manage members

Open the admin dashboard and select **Members**.

- **Register a Member** creates a membership directly for an in-person registration. Enter the name, optionally enter a phone number, choose Monthly or 6-Month, and set the start date. The server calculates the end date.
- The list shows the current membership period, remaining days, and status. End dates count as active through that calendar day; a membership becomes expired the following day. Expiration and the Active Members count refresh at local midnight.
- Memberships expiring in seven days or less are highlighted. Expired records stay in the list so they can be renewed.
- **Edit** changes the member details and recalculates the end date. **Renew** is shown for expired memberships and starts the new period today. Changes are recorded in the audit history.
- Use a distinct member name and phone number for each person when possible; paid online reservations use both fields to match a returning member.

Older member records stored in this browser are copied into the server database when an admin first opens the upgraded dashboard. This one-time migration only sees data in the browser that held those records. Check the Members list after upgrading and before clearing browser data.

In the older version, orders and payment status existed only in the running Node.js process. If those old records matter, use **Export Data** in the still-running old dashboard before stopping or replacing it. That CSV is an archive; this upgrade does not automatically import old transaction CSV files.

## 3. Reservations and payment confirmation

The public pricing form records a **reservation**, not a payment. The server validates the selected plan and calculates the price; the browser cannot set the amount or mark the reservation as paid.

The form records an optional email and the customer's preferred start date. The date must be today or later; it is used when activating a new membership after payment. For an already active member, the existing remaining-days extension rule takes precedence.

When the gym has actually received the money:

1. Open **Orders & Registrations** (or **Customers** for membership reservations). The Orders tab has server-side name/phone/receipt search, status filters, pagination, and a Pending payments shortcut/count.
2. Find the correct receipt and verify the name, plan, and amount. Unpaid orders older than seven days are labelled stale.
3. Select **Confirm Payment** only after collection. Choose Cash or GCash, enter the amount received, and enter the GCash reference (required; at most 50 characters). If the amount does not match, explicitly select the mismatch override.
4. The app records the payment details and confirmer, creates or extends the membership in the same transaction, and then offers a printable/downloadable PAID receipt.

Unpaid orders can be cancelled from the Orders tab. Paid orders cannot be cancelled, and cancelled orders cannot create a membership or contribute to revenue. The Walk-ins Today metric counts paid walk-ins only.

Confirmed payments update the revenue figures. A confirmed Monthly or 6-Month order creates a membership; if the same name and phone already identify a member, it extends that member's dates without discarding remaining active days. Walk-in orders do not create memberships.

This project does not connect to a bank, e-wallet, or payment gateway. Confirming payment is an admin record-keeping action; it is not proof that an online payment was received.
Once marked Paid, an order cannot be reverted in this version. This avoids silently undoing recognized revenue or an active membership; record refunds or payment corrections separately until a dedicated refund workflow is added.

When updating an existing installation, make a separate database backup before starting the new app version. The startup migration safely adds missing order columns and rebuilds the order status constraint to support Cancelled, preserving stored orders. Do not remove the original database until the app has started and you have checked members and orders.

## 4. Change history, exports, and backups

**Audit & Backups** shows recent member, payment, and backup events, including before/after membership dates for edits and renewals. The log is restricted to the admin dashboard.

Open **Security** to change the administrator password. The current password is verified and new passwords must be at least 12 characters. Failed login attempts are recorded without passwords. State-changing admin requests must come from the same origin and include the app's custom request header; the dashboard sends this automatically.

- **Export Data** downloads a CSV containing the current member list and order history.
- **Create Backup** creates a SQLite backup, downloads a copy to the admin's browser, and keeps the server copy under `%LOCALAPPDATA%\BigBozzFitness\backups` (or `DATA_DIR\backups` if configured).
- The server also creates a backup at local midnight while it remains running. Backups older than 30 days are automatically removed.
- Keep another backup copy somewhere separate from the computer hosting the app. Do not rely on the server copy if the computer or disk fails.

To restore a backup, stop the server first. In File Explorer, copy the desired `.sqlite` backup from `%LOCALAPPDATA%\BigBozzFitness\backups` (or your configured data folder) to a safe folder, then copy that backup into the data folder and rename the copy to `bigbozz.sqlite`. Preserve the old database as a separate copy rather than deleting it. Start the server and verify members and orders before using the restored records.

## 5. Deployment and security checklist

Before making the website reachable from the public internet:

1. Set `NODE_ENV=production`, use a long random `SESSION_SECRET`, and keep `ADMIN_PASSWORD` unique and private.
2. Put the app behind an HTTPS reverse proxy and restrict access to the server and its data/backup folders. The production cookie is marked Secure, so the admin login requires HTTPS.
3. Back up the database off the host regularly and test restoring a copy.
4. Keep Node.js and npm dependencies up to date.
5. Avoid running multiple app processes against the same SQLite file. This configuration is intended for a single app instance on one host.
6. The current page loads Tailwind, icons, charts, and receipt-export libraries from public CDNs and uses inline event handlers. A stricter production setup should self-host or pin those front-end assets, replace inline event handlers, and tighten the content security policy.
7. Use the dashboard as an operational tool, not as an audited accounting system or a substitute for a payment processor.

The SQLite file contains personal details and member history. Limit access to the host, `.env`, database, and backups to trusted staff.

## 6. Common problems

- **The server says setup is incomplete:** on Windows, check `%LOCALAPPDATA%\BigBozzFitness\.env`; on other systems, check for `.env` beside `server.js` or confirm the `ENV_FILE` path. Verify that `ADMIN_PASSWORD` and `SESSION_SECRET` meet the minimum lengths.
- **Port 3000 is in use:** change `PORT` in the environment file, restart the server, and open that port in the browser.
- **A database path is rejected:** set `DATA_DIR` to a folder outside the project directory.
- **A payment or member change does not save:** check the server terminal and available disk space. The interface reports the server error instead of pretending the save succeeded.
- **An old member is missing after upgrade:** return to the browser that contained the old local data. Sign in and open Members there so its local records can be migrated; then verify the list.
