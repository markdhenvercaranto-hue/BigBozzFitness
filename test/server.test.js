const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApplication, calculateMembershipEndDate, getTodayDateString, isValidDateString } = require('../server');

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

  const reservationResponse = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Alex Member',
      phone: '555-0100',
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
  let reservationStatsResponse = await request('/api/admin/stats');
  assert.equal((await reservationStatsResponse.json()).activeMembers, 0);

  const unauthorizedPayment = await fetch(`${baseUrl}/api/admin/orders/${reservation.id}/payment`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Paid' })
  });
  assert.equal(unauthorizedPayment.status, 401);

  const confirmedPayment = await request(`/api/admin/orders/${reservation.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid' })
  });
  assert.equal(confirmedPayment.status, 200);
  const paidOrder = await confirmedPayment.json();
  assert.equal(paidOrder.status, 'Paid');
  assert.ok(paidOrder.memberId);

  let membersResponse = await request('/api/admin/members');
  let members = await membersResponse.json();
  assert.equal(members.length, 1);
  assert.equal(members[0].startDate, getTodayDateString());

  let statsResponse = await request('/api/admin/stats');
  let stats = await statsResponse.json();
  assert.equal(stats.activeMembers, 1);
  assert.equal(stats.totalRevenue, 2000);

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
  assert.equal((await expiredStatsResponse.json()).activeMembers, 1);

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
  assert.equal((await renewedStatsResponse.json()).activeMembers, 2);

  const deleteMember = await request(`/api/admin/members/${expiredMember.id}`, { method: 'DELETE' });
  assert.equal(deleteMember.status, 204);
  const deletedStatsResponse = await request('/api/admin/stats');
  assert.equal((await deletedStatsResponse.json()).activeMembers, 1);

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
  assert.equal((await persistedMembers.json()).length, 2);
  const loggedOut = await request('/api/logout', { method: 'POST' });
  assert.equal(loggedOut.status, 200);
  cookie = undefined;
  const sessionAfterLogout = await request('/api/admin/members');
  assert.equal(sessionAfterLogout.status, 401);
});
