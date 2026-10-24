# Big Bozz Fitness Operations Guide

This guide covers local development, Vercel deployment, Turso database setup, membership handling, payment confirmation, and recovery.

## 1. First-time setup on Windows

Use Node.js 20.19 or newer. Copy `.env.example` to `.env` in the project folder and set the local secrets. Keep `.env` private; it is ignored by Git.

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Put the first generated value in `SESSION_SECRET` and the second in `MFA_ENCRYPTION_KEY`. The latter must be exactly 64 hexadecimal characters. Leave `TURSO_DATABASE_URL` blank for local development; the app then uses `file:local.db`. To use a remote database locally, set both Turso variables. For first-owner setup, temporarily set `ADMIN_PASSWORD` to a unique password of at least 12 characters.

Install the locked dependencies once, then start the app:

```powershell
npm ci
npm start
```

For a new database, create the first owner account with `npm run admin:create -- owner`, then start the app with `npm start`. Open `http://localhost:3000`. The first sign-in prompts you to enroll an authenticator app using a QR code and then displays one-time recovery codes. Store those codes securely. Remove `ADMIN_PASSWORD` from `.env` after account creation. Keep the server terminal running while using the dashboard; stop it with Ctrl+C.

Local SQLite fallback is for development and tests only. A Vercel deployment must use Turso so data persists across serverless invocations.

## 2. Register and manage members

Open the admin dashboard, enter the admin code, and select **Members**. Visitors without the code can see aggregate dashboard metrics only; names, contact details, registrations, payments, audit history, and all management controls remain protected.

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

The Vercel/Turso setup creates the final schema for a fresh database. It does not automatically copy records from an older local SQLite database; plan and verify a data transfer before switching production traffic if existing member, order, or audit records must be retained.

## 4. Change history, exports, and backups

**Audit** shows recent member, payment, and administrator events, including before/after membership dates for edits and renewals. The log is restricted to the admin dashboard.

The dashboard can export member and order data as CSV. Database backups are managed by Turso; configure its backup/restore options and retain an off-platform export for disaster recovery. The app does not write database backups to the Vercel function filesystem.

Open **Security** to change the administrator password. Changing it rotates the current session and logs out other devices. **Log out all sessions** ends every admin session, including the current device. Admin sessions expire after 30 minutes without admin activity and have an eight-hour absolute lifetime. Failed sign-in attempts are audited without recording passwords, MFA secrets, or recovery codes.

## 5. Deployment and security checklist

### Deploying to Vercel and Turso

1. Install the Turso CLI and authenticate using the official Turso instructions.
2. Create a database: `turso db create bigbozz-fitness`.
3. Get its URL with `turso db show --url bigbozz-fitness`.
4. Create a database token with `turso db tokens create bigbozz-fitness`. Keep the token private.
5. In the Vercel project settings, add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
6. Generate a 48-byte random hex value for `SESSION_SECRET` and a separate 32-byte random hex value for `MFA_ENCRYPTION_KEY`; add both to Vercel. Do not reuse or commit secrets.
7. Before deployment, bootstrap the first owner against that Turso database from a trusted machine. Set the database URL, auth token, and a temporary `ADMIN_PASSWORD` in a local `.env`, then run `npm run admin:create -- owner`. Remove `ADMIN_PASSWORD` from all environments after the owner is created. This operation creates the final schema and first account.
8. Deploy the project to Vercel. `vercel.json` routes requests to the Express function and includes the HTML/CSS/JS assets. Vercel serves production over HTTPS; the app trusts one proxy hop and marks production session cookies Secure, HttpOnly, and SameSite=Lax.
9. Open the deployed site, sign in as the owner, enroll an authenticator, and securely save the displayed one-time recovery codes. Verify registrations, member creation, payment confirmation, audit history, and session logout before going live.
10. Configure Turso backup retention and test a restore. Keep exports encrypted and off-platform; never assume a Vercel function's local filesystem persists between invocations.

Required Vercel environment variables: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET`, and `MFA_ENCRYPTION_KEY`. `NODE_ENV` is supplied by Vercel, and `PORT` is managed by the platform. `ADMIN_PASSWORD` is only needed temporarily for initial owner creation.

## 6. Common problems

- **The server says setup is incomplete:** set a `SESSION_SECRET` of at least 32 characters and a 64-character hexadecimal `MFA_ENCRYPTION_KEY`. For Vercel, confirm the required environment variables are set for the deployment environment and redeploy after changing them.
- **Port 3000 is in use:** change `PORT` in the environment file, restart the server, and open that port in the browser.
- **The database is unavailable:** verify `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, check Turso status, and redeploy after correcting variables.
- **No owner account exists:** set the Turso variables locally and run `npm run admin:create -- owner` from a trusted machine.
- **A payment or member change does not save:** check function logs and Turso connectivity. The interface reports server errors rather than pretending the save succeeded.
- **Records from the old local SQLite file are missing in Turso:** the new database schema is created fresh and does not automatically import the old file. Keep the old database unchanged and arrange a verified data transfer before relying on the Turso deployment.
