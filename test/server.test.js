const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApplication, calculateMembershipEndDate, getTodayDateString, isValidDateString } = require('../server');
const Database = require('better-sqlite3');
const { createDatabase } = require('../database');

test('server validates dates and clamps month-end membership dates', () => {
  assert.equal(calculateMembershipEndDate('2025-01-31', 'monthly'), '2025-02-28');
  assert.equal(calculateMembershipEndDate('2024-08-31', '6month'), '2025-02-28');
  assert.equal(isValidDateString('2024-02-29'), true);
  assert.equal(isValidDateString('2025-02-29'), false);
  assert.equal(isValidDateString('2025-13-01'), false);
});

test('server requires a non-public data directory', () => {
  assert.throws(() => createApplication({
    dataDirectory: path.resolve(__dirname, '..', 'test-data'),
    adminPassword: 'AnExamplePassword123',
    sessionSecret: 'S'.repeat(48)
  }), /outside the public application directory/);
});

test('server refuses to start with placeholder administrator credentials', () => {
  assert.throws(() => createApplication({
    dataDirectory: path.join(os.tmpdir(), 'bbf-missing-secret-test'),
    adminPassword: 'CHANGE_ME',
    sessionSecret: 'CHANGE_ME'
  }), /ADMIN_PASSWORD/);
});

test('startup migration preserves legacy order rows and adds cancelled/payment columns', async t => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bigbozz-migration-test-'));
  const legacyFile = path.join(temporaryDirectory, 'bigbozz.sqlite');
  const legacy = new Database(legacyFile);
  legacy.exec(`
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      membership_type TEXT NOT NULL CHECK (membership_type IN ('monthly', '6month')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      plan TEXT NOT NULL,
      plan_key TEXT NOT NULL CHECK (plan_key IN ('walkin', 'monthly', '6month')),
      trainer INTEGER NOT NULL DEFAULT 0 CHECK (trainer IN (0, 1)),
      total INTEGER NOT NULL CHECK (total >= 0),
      status TEXT NOT NULL CHECK (status IN ('Unpaid', 'Paid')),
      date TEXT NOT NULL,
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX orders_date_idx ON orders(date);
    CREATE INDEX orders_status_idx ON orders(status);
    INSERT INTO orders (receipt_id, name, phone, plan, plan_key, total, status, date, created_at)
    VALUES ('BB-LEGACY', 'Legacy Guest', '555-1000', 'Walk-in', 'walkin', 50, 'Unpaid', '2025-01-01', '2025-01-01T00:00:00.000Z');
  `);
  legacy.close();
  let migrated;
  let migratedInspection;
  t.after(async () => {
    if (migratedInspection) migratedInspection.close();
    if (migrated) migrated.close();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  migrated = createDatabase(temporaryDirectory);
  const legacyOrder = migrated.getOrder(1);
  assert.equal(legacyOrder.receipt_id, 'BB-LEGACY');
  assert.equal(legacyOrder.status, 'Unpaid');
  assert.equal(legacyOrder.email, null);
  assert.equal(legacyOrder.payment_method, null);
  migratedInspection = new Database(legacyFile, { readonly: true });
  const orderIndexes = new Set(migratedInspection.pragma('index_list(orders)').map(index => index.name));
  assert.ok(orderIndexes.has('orders_date_idx'));
  assert.ok(orderIndexes.has('orders_status_idx'));
  const orderForeignKeys = migratedInspection.pragma('foreign_key_list(orders)');
  assert.ok(orderForeignKeys.some(key => key.table === 'members' && key.from === 'member_id'));
  const cancelled = migrated.cancelOrder(1, 'owner');
  assert.equal(cancelled.result, 'cancelled');
  assert.equal(migrated.getOrder(1).status, 'Cancelled');
});

test('authenticated member, order, audit, and backup workflows persist', async t => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bigbozz-test-'));
  const dataDirectory = path.join(temporaryDirectory, 'private');
  let app = createApplication({
    dataDirectory,
    adminUsername: 'owner',
    adminEmail: 'owner@example.test',
    adminPassword: 'AnExamplePassword123',
    sessionSecret: 'session-secret-for-tests-that-is-at-least-32-characters'
  });
  let server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  let baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie;

  async function request(route, options = {}) {
    const headers = { ...(options.headers || {}) };
    const method = (options.method || 'GET').toUpperCase();
    if (route.startsWith('/api/admin/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      headers['X-Requested-With'] = headers['X-Requested-With'] || 'fetch';
      headers.Origin = headers.Origin || baseUrl;
    }
    if (cookie) headers.Cookie = cookie;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}${route}`, { ...options, headers });
  }

  async function closeServer() {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    app.locals.database.close();
  }

  t.after(async () => {
    if (server && server.listening) await closeServer();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const unauthenticatedMembers = await request('/api/admin/members');
  assert.equal(unauthenticatedMembers.status, 401);
  assert.equal(unauthenticatedMembers.headers.get('cache-control'), 'no-store');
  for (const [route, method] of [
    ['/api/admin/stats', 'GET'],
    ['/api/admin/members', 'GET'],
    ['/api/admin/orders', 'GET'],
    ['/api/admin/audit', 'GET'],
    ['/api/admin/backups/bigbozz-2025-01-01T00-00-00-000Z.sqlite', 'GET'],
    ['/api/admin/members', 'POST'],
    ['/api/admin/members/import-legacy', 'POST'],
    ['/api/admin/members/unknown', 'PATCH'],
    ['/api/admin/members/unknown/renew', 'POST'],
    ['/api/admin/members/unknown', 'DELETE'],
    ['/api/admin/orders/1/payment', 'PATCH'],
    ['/api/admin/orders/1/cancel', 'PATCH'],
    ['/api/admin/password', 'PATCH'],
    ['/api/admin/backups', 'POST']
  ]) {
    const options = { method };
    if (method !== 'GET') options.body = JSON.stringify({});
    assert.equal((await request(route, options)).status, 401, `${method} ${route}`);
  }
  const homePage = await request('/');
  assert.equal(homePage.status, 200);
  assert.match(await homePage.text(), /ADMIN DASHBOARD/);
  const frontendScript = await request('/BBFfunc.js');
  assert.equal(frontendScript.status, 200);
  assert.match(await frontendScript.text(), /function adminApi/);
  const adminPage = await request('/admin', { redirect: 'manual' });
  assert.equal(adminPage.status, 302);
  const privateSource = await request('/database.js');
  assert.equal(privateSource.status, 404);
  const privateCookieFile = await request('/cookies.txt');
  assert.equal(privateCookieFile.status, 404);

  const badLogin = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ usernameOrEmail: 'owner', password: 'wrong-password' })
  });
  assert.equal(badLogin.status, 401);

  const login = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ usernameOrEmail: 'owner', password: 'AnExamplePassword123' })
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];

  const csrfRejected = await fetch(`${baseUrl}/api/admin/password`, {
    method: 'PATCH',
    headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'AnExamplePassword123', newPassword: 'AnotherExamplePassword123' })
  });
  assert.equal(csrfRejected.status, 403);
  const badOriginRejected = await fetch(`${baseUrl}/api/admin/password`, {
    method: 'PATCH',
    headers: {
      Cookie: cookie,
      Origin: 'https://attacker.example',
      'X-Requested-With': 'fetch',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ currentPassword: 'AnExamplePassword123', newPassword: 'AnotherExamplePassword123' })
  });
  assert.equal(badOriginRejected.status, 403);

  const reservationResponse = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Alex Member',
      phone: '555-0100',
      email: 'alex@example.test',
      preferredStartDate: getTodayDateString(),
      planKey: 'monthly',
      trainer: true,
      total: 1,
      status: 'Paid'
    })
  });
  assert.equal(reservationResponse.status, 201);
  const reservation = await reservationResponse.json();
  assert.equal(reservation.total, 2000);
  assert.equal(reservation.status, 'Unpaid');
  assert.equal(reservation.email, 'alex@example.test');
  assert.equal(reservation.preferredStartDate, getTodayDateString());
  const invalidEmail = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bad Email', phone: '555-0100', email: 'not-an-email', planKey: 'walkin' })
  });
  assert.equal(invalidEmail.status, 400);
  const pastStartDate = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({ name: 'Past Date', phone: '555-0100', preferredStartDate: '2000-01-01', planKey: 'walkin' })
  });
  assert.equal(pastStartDate.status, 400);
  let reservationStatsResponse = await request('/api/admin/stats');
  assert.equal((await reservationStatsResponse.json()).activeMembers, 0);

  const unauthorizedPayment = await fetch(`${baseUrl}/api/admin/orders/${reservation.id}/payment`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Paid' })
  });
  assert.equal(unauthorizedPayment.status, 401);

  const missingReference = await request(`/api/admin/orders/${reservation.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid', paymentMethod: 'GCash', amountReceived: 2000 })
  });
  assert.equal(missingReference.status, 400);
  const amountMismatch = await request(`/api/admin/orders/${reservation.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid', paymentMethod: 'GCash', paymentReference: 'GC-100', amountReceived: 1999 })
  });
  assert.equal(amountMismatch.status, 400);
  assert.equal((await amountMismatch.json()).requiresMismatchConfirmation, true);

  const confirmedPayment = await request(`/api/admin/orders/${reservation.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'Paid',
      paymentMethod: 'GCash',
      paymentReference: 'GC-100',
      amountReceived: 1999,
      allowMismatch: true
    })
  });
  assert.equal(confirmedPayment.status, 200);
  const paidOrder = await confirmedPayment.json();
  assert.equal(paidOrder.status, 'Paid');
  assert.equal(paidOrder.paymentMethod, 'GCash');
  assert.equal(paidOrder.paymentReference, 'GC-100');
  assert.equal(paidOrder.amountReceived, 1999);
  assert.equal(paidOrder.confirmedBy, 'owner');
  assert.ok(paidOrder.memberId);
  const confirmedTwice = await request(`/api/admin/orders/${reservation.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'Paid',
      paymentMethod: 'Cash',
      amountReceived: 3000
    })
  });
  assert.equal(confirmedTwice.status, 200);
  const duplicatePaidOrder = await confirmedTwice.json();
  assert.equal(duplicatePaidOrder.paymentMethod, 'GCash');
  assert.equal(duplicatePaidOrder.amountReceived, 1999);

  let membersResponse = await request('/api/admin/members');
  let members = await membersResponse.json();
  assert.equal(members.length, 1);
  assert.equal(members[0].startDate, getTodayDateString());

  const paidCancellation = await request(`/api/admin/orders/${reservation.id}/cancel`, {
    method: 'PATCH',
    body: JSON.stringify({})
  });
  assert.equal(paidCancellation.status, 409);

  const cancelledReservationResponse = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cancel Me', phone: '555-0102', planKey: 'walkin', preferredStartDate: getTodayDateString() })
  });
  const cancelledReservation = await cancelledReservationResponse.json();
  const cancelledResponse = await request(`/api/admin/orders/${cancelledReservation.id}/cancel`, {
    method: 'PATCH',
    body: JSON.stringify({})
  });
  assert.equal(cancelledResponse.status, 200);
  assert.equal((await cancelledResponse.json()).status, 'Cancelled');
  const cancelledPayment = await request(`/api/admin/orders/${cancelledReservation.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid', paymentMethod: 'Cash', amountReceived: 50 })
  });
  assert.equal(cancelledPayment.status, 409);

  const today = getTodayDateString();
  const futureStart = new Date(`${today}T12:00:00`);
  futureStart.setDate(futureStart.getDate() + 5);
  const preferredDate = `${futureStart.getFullYear()}-${String(futureStart.getMonth() + 1).padStart(2, '0')}-${String(futureStart.getDate()).padStart(2, '0')}`;
  const futureReservation = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Future Member',
      phone: '555-0103',
      planKey: 'monthly',
      preferredStartDate: preferredDate
    })
  });
  const futureOrder = await futureReservation.json();
  const cashPayment = await request(`/api/admin/orders/${futureOrder.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid', paymentMethod: 'Cash', amountReceived: 500 })
  });
  assert.equal(cashPayment.status, 200);
  assert.equal((await cashPayment.json()).paymentMethod, 'Cash');
  const walkinReservation = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cash Walk-in', phone: '555-0104', planKey: 'walkin' })
  });
  const walkinOrder = await walkinReservation.json();
  const walkinPayment = await request(`/api/admin/orders/${walkinOrder.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid', paymentMethod: 'Cash', amountReceived: 50 })
  });
  assert.equal(walkinPayment.status, 200);
  membersResponse = await request('/api/admin/members');
  members = await membersResponse.json();
  assert.equal(members.find(member => member.name === 'Future Member').startDate, preferredDate);

  const filteredOrders = await request('/api/admin/orders?status=Cancelled&q=Cancel%20Me&limit=10&offset=0');
  const filteredData = await filteredOrders.json();
  assert.equal(filteredData.orders.length, 1);
  assert.equal(filteredData.orders[0].status, 'Cancelled');
  assert.equal(filteredData.pendingCount, 0);
  const pendingReservationResponse = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({ name: 'Pending Search', phone: '555-0105', planKey: 'walkin' })
  });
  const pendingReservation = await pendingReservationResponse.json();
  const pendingSearch = await request('/api/admin/orders?status=Unpaid&q=Pending%20Search&limit=10&offset=0');
  const pendingData = await pendingSearch.json();
  assert.equal(pendingData.orders[0].id, pendingReservation.id);
  assert.equal(pendingData.pendingCount, 1);
  const receiptSearch = await request(`/api/admin/orders?status=All&q=${encodeURIComponent(reservation.receiptId)}&limit=10&offset=0`);
  assert.equal((await receiptSearch.json()).orders[0].receiptId, reservation.receiptId);

  let statsResponse = await request('/api/admin/stats');
  let stats = await statsResponse.json();
  assert.equal(stats.activeMembers, 2);
  assert.equal(stats.totalRevenue, 2550);
  assert.equal(stats.walkinsToday, 1);

  const expiredMemberResponse = await request('/api/admin/members', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Expired Member',
      phone: '555-0101',
      membershipType: 'monthly',
      startDate: '2025-01-31'
    })
  });
  assert.equal(expiredMemberResponse.status, 201);
  const expiredMember = await expiredMemberResponse.json();
  assert.equal(expiredMember.endDate, '2025-02-28');
  assert.equal(expiredMemberResponse.ok, true);
  const expiredStatsResponse = await request('/api/admin/stats');
  assert.equal((await expiredStatsResponse.json()).activeMembers, 2);

  const invalidEdit = await request(`/api/admin/members/${expiredMember.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: 'Expired Member',
      phone: '555-0101',
      membershipType: 'monthly',
      startDate: '2025-02-29'
    })
  });
  assert.equal(invalidEdit.status, 400);

  const memberEdit = await request(`/api/admin/members/${expiredMember.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: 'Edited Expired Member',
      phone: '555-0199',
      membershipType: '6month',
      startDate: '2025-01-31'
    })
  });
  assert.equal(memberEdit.status, 200);
  assert.equal((await memberEdit.json()).endDate, '2025-07-31');

  const renewal = await request(`/api/admin/members/${expiredMember.id}/renew`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(renewal.status, 200);
  const renewedMember = await renewal.json();
  assert.equal(renewedMember.startDate, getTodayDateString());
  const renewedStatsResponse = await request('/api/admin/stats');
  assert.equal((await renewedStatsResponse.json()).activeMembers, 3);

  const deleteMember = await request(`/api/admin/members/${expiredMember.id}`, { method: 'DELETE' });
  assert.equal(deleteMember.status, 204);
  const deletedStatsResponse = await request('/api/admin/stats');
  assert.equal((await deletedStatsResponse.json()).activeMembers, 2);

  const legacyImport = await request('/api/admin/members/import-legacy', {
    method: 'POST',
    body: JSON.stringify({
      members: [{
        name: 'Imported Legacy Record',
        phone: '',
        membershipType: 'monthly',
        startDate: '2020-01-31'
      }]
    })
  });
  assert.equal(legacyImport.status, 201);
  assert.equal((await legacyImport.json()).importedCount, 1);

  const repeatedLegacyImport = await request('/api/admin/members/import-legacy', {
    method: 'POST',
    body: JSON.stringify({
      members: [{
        name: 'Imported Legacy Record',
        phone: '',
        membershipType: 'monthly',
        startDate: '2020-01-31'
      }]
    })
  });
  assert.equal((await repeatedLegacyImport.json()).skippedCount, 1);

  const auditResponse = await request('/api/admin/audit');
  const audit = await auditResponse.json();
  assert.ok(audit.some(entry => entry.action === 'payment_confirmed'));
  const paymentAudit = audit.find(entry => entry.action === 'payment_confirmed' && entry.entityId === String(reservation.id));
  assert.equal(paymentAudit.actor, 'owner');
  assert.equal(paymentAudit.details.paymentMethod, 'GCash');
  assert.equal(paymentAudit.details.amountReceived, 1999);
  assert.equal(paymentAudit.details.allowMismatch, true);
  assert.ok(audit.some(entry => entry.action === 'failed_login'));
  assert.ok(audit.some(entry => entry.action === 'order_cancelled'));
  assert.ok(audit.some(entry => entry.action === 'member_updated'));
  assert.ok(audit.some(entry => entry.action === 'member_renewed'));
  assert.ok(audit.some(entry => entry.action === 'member_deleted'));

  const backupResponse = await request('/api/admin/backups', {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(backupResponse.status, 201);
  const backup = await backupResponse.json();
  const backupPath = path.join(dataDirectory, 'backups', backup.filename);
  assert.equal((await fs.readFile(backupPath)).subarray(0, 15).toString(), 'SQLite format 3');
  const downloadedBackup = await request(`/api/admin/backups/${encodeURIComponent(backup.filename)}`);
  assert.equal(downloadedBackup.status, 200);
  assert.equal(Buffer.from(await downloadedBackup.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');

  await closeServer();
  app = createApplication({
    dataDirectory,
    adminUsername: 'owner',
    adminEmail: 'owner@example.test',
    adminPassword: 'AnExamplePassword123',
    sessionSecret: 'session-secret-for-tests-that-is-at-least-32-characters'
  });
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const persistedMembers = await request('/api/admin/members');
  assert.equal(persistedMembers.status, 200);
  assert.equal((await persistedMembers.json()).length, 3);
  const wrongCurrentPassword = await request('/api/admin/password', {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword: 'wrong-password', newPassword: 'NewAdminPassword123' })
  });
  assert.equal(wrongCurrentPassword.status, 401);
  const shortNewPassword = await request('/api/admin/password', {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword: 'AnExamplePassword123', newPassword: 'short' })
  });
  assert.equal(shortNewPassword.status, 400);
  const passwordChanged = await request('/api/admin/password', {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword: 'AnExamplePassword123', newPassword: 'AnotherExamplePassword123' })
  });
  assert.equal(passwordChanged.status, 200);
  const loggedOut = await request('/api/logout', { method: 'POST' });
  assert.equal(loggedOut.status, 200);
  cookie = undefined;
  const oldPasswordLogin = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ usernameOrEmail: 'owner', password: 'AnExamplePassword123' })
  });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ usernameOrEmail: 'owner', password: 'AnotherExamplePassword123' })
  });
  assert.equal(newPasswordLogin.status, 200);
  cookie = newPasswordLogin.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
  const finalLogout = await request('/api/logout', { method: 'POST' });
  assert.equal(finalLogout.status, 200);
  cookie = undefined;
  const sessionAfterLogout = await request('/api/admin/members');
  assert.equal(sessionAfterLogout.status, 401);
});
