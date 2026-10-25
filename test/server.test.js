const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const OTPAuth = require('otpauth');
const { createClient } = require('@libsql/client');

process.env.SESSION_SECRET ||= 'test-session-secret-that-is-at-least-32-characters';
process.env.MFA_ENCRYPTION_KEY ||= '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

const { createApplication, calculateMembershipEndDate, getTodayDateString, isValidDateString } = require('../server');
const { createDatabase } = require('../database');

const TEST_PASSWORD = 'ExamplePassword-For-Tests-123';
const TEST_MFA_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function createTotp(secret, username = 'owner') {
  return new OTPAuth.TOTP({
    issuer: 'Big Bozz Fitness',
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret)
  });
}

async function createLocalDatabase(t) {
  const client = createClient({ url: 'file::memory:' });
  const database = createDatabase({ client });
  t.after(async () => {
    await database.close();
  });
  return { database, client };
}

test('server validates dates and clamps month-end membership dates', () => {
  assert.equal(calculateMembershipEndDate('2025-01-31', 'monthly'), '2025-02-28');
  assert.equal(calculateMembershipEndDate('2024-08-31', '6month'), '2025-02-28');
  assert.equal(isValidDateString('2024-02-29'), true);
  assert.equal(isValidDateString('2025-02-29'), false);
  assert.equal(isValidDateString('2025-13-01'), false);
});

test('server rejects missing or weak session and MFA encryption secrets', () => {
  assert.throws(() => createApplication({
    sessionSecret: 'change-me-session-secret-that-is-long-enough',
    mfaEncryptionKey: TEST_MFA_KEY
  }), /SESSION_SECRET/);
  assert.throws(() => createApplication({
    sessionSecret: 'test-session-secret-that-is-at-least-32-characters',
    mfaEncryptionKey: '0'.repeat(64)
  }), /MFA_ENCRYPTION_KEY/);
});

test('production startup refuses the ephemeral local database fallback', () => {
  const oldUrl = process.env.TURSO_DATABASE_URL;
  const oldToken = process.env.TURSO_AUTH_TOKEN;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  try {
    assert.throws(() => createApplication({
      sessionSecret: 'test-session-secret-that-is-at-least-32-characters',
      mfaEncryptionKey: TEST_MFA_KEY,
      isProduction: true
    }), /TURSO_DATABASE_URL/);
  } finally {
    if (oldUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = oldToken;
  }
});

test('libSQL creates the final schema and preserves atomic order workflows', async t => {
  const { database, client } = await createLocalDatabase(t);
  await database.initialize();
  const foreignKeys = await client.execute('PRAGMA foreign_keys');
  assert.equal(Number(foreignKeys.rows[0].foreign_keys), 1);
  await database.createFirstAdmin({
    id: crypto.randomUUID(),
    username: 'owner',
    passwordHash: await bcrypt.hash(TEST_PASSWORD, 4)
  });

  const order = await database.createOrder({
    receiptId: 'BB-TEST-001',
    name: 'Test Member',
    phone: '555-0100',
    plan: 'Monthly Standard Plan',
    planKey: 'monthly',
    trainer: false,
    total: 500,
    date: getTodayDateString(),
    email: null,
    preferredStartDate: getTodayDateString()
  });
  assert.equal(order.status, 'Unpaid');
  assert.equal(order.email, null);
  assert.equal(order.payment_method, null);

  const cancelled = await database.cancelOrder(order.id, 'owner');
  assert.equal(cancelled.result, 'cancelled');
  assert.equal((await database.getOrder(order.id)).status, 'Cancelled');
  await assert.rejects(
    database.confirmPayment(order.id, getTodayDateString(), calculateMembershipEndDate, (date, days) => date, 'owner', {
      paymentMethod: 'Cash',
      paymentReference: '',
      amountReceived: 500,
      allowMismatch: false
    }),
    error => error.code === 'ORDER_CANCELLED'
  );

  const accountCount = await database.adminAccountCount();
  assert.equal(accountCount, 1);
});

test('Express serves static assets and async admin workflows using local libSQL', async t => {
  const { database } = await createLocalDatabase(t);
  await database.initialize();
  await database.createFirstAdmin({
    id: crypto.randomUUID(),
    username: 'owner',
    passwordHash: await bcrypt.hash(TEST_PASSWORD, 4)
  });

  const app = createApplication({
    database,
    sessionSecret: 'test-session-secret-that-is-at-least-32-characters',
    mfaEncryptionKey: TEST_MFA_KEY,
    isProduction: false
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie;

  async function request(route, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    const { sessionCookie, ...fetchOptions } = options;
    if (route.startsWith('/api/admin/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      headers['X-Requested-With'] = 'fetch';
      headers.Origin = baseUrl;
    }
    if (Object.hasOwn(options, 'sessionCookie')) {
      if (sessionCookie) headers.Cookie = sessionCookie;
    } else if (cookie && !headers.Cookie) {
      headers.Cookie = cookie;
    }
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}${route}`, { ...fetchOptions, headers });
  }

  async function closeServer() {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  t.after(async () => {
    if (server.listening) await closeServer();
  });

  const publicPage = await request('/');
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /ADMIN DASHBOARD/);
  assert.equal((await request('/BBFIndex.html')).status, 200);
  const paymentModalMarkup = await (await request('/BBFIndex.html')).text();
  assert.match(paymentModalMarkup, /<\/div>\s*<\/div>\s*<div id="paymentConfirmationModal"/);
  for (const id of [
    'paymentConfirmationModal',
    'paymentConfirmationForm',
    'paymentOrderId',
    'paymentOrderSummary',
    'paymentMethod',
    'paymentReference',
    'amountReceived',
    'paymentMismatch',
    'paymentFormStatus'
  ]) {
    assert.match(paymentModalMarkup, new RegExp(`id="${id}"`));
  }
  assert.equal((await request('/BBFDesign.css')).status, 200);
  assert.equal((await request('/BBFfunc.js')).status, 200);
  assert.equal((await request('/api/admin/members')).status, 401);
  assert.equal((await request('/api/admin/records/reset', {
    method: 'POST',
    body: JSON.stringify({ confirmed: true })
  })).status, 401);

  const publicOverview = await request('/api/dashboard/overview');
  assert.equal(publicOverview.status, 200);
  assert.deepEqual(Object.keys(await publicOverview.json()).sort(), [
    'activeMembers', 'totalRevenue', 'trainerCount', 'walkinsToday'
  ]);

  const login = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: TEST_PASSWORD })
  });
  assert.equal(login.status, 200);
  const challenge = await login.json();
  assert.equal(challenge.mfaSetupRequired, true);
  assert.ok(challenge.qrCodeDataUrl.startsWith('data:image/png;base64,'));
  const mfaCode = createTotp(challenge.manualSecret).generate();
  const verify = await request('/api/login/verify-mfa', {
    method: 'POST',
    headers: { Cookie: login.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0] },
    body: JSON.stringify({ code: mfaCode })
  });
  assert.equal(verify.status, 200);
  const verified = await verify.json();
  assert.equal(verified.recoveryCodes.length, 10);
  cookie = verify.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
  const setupSecret = challenge.manualSecret;
  const recoveryCode = verified.recoveryCodes[0];

  assert.equal((await request('/api/logout', { method: 'POST' })).status, 200);
  cookie = undefined;
  const recoveryLogin = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: TEST_PASSWORD })
  });
  const recoveryChallengeCookie = recoveryLogin.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
  const recoveryVerify = await request('/api/login/verify-mfa', {
    method: 'POST',
    sessionCookie: recoveryChallengeCookie,
    body: JSON.stringify({ code: recoveryCode })
  });
  assert.equal(recoveryVerify.status, 200);
  cookie = recoveryVerify.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];

  const replayLogin = await request('/api/login', {
    method: 'POST',
    sessionCookie: null,
    body: JSON.stringify({ username: 'owner', password: TEST_PASSWORD })
  });
  const replayChallengeCookie = replayLogin.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
  const replayVerify = await request('/api/login/verify-mfa', {
    method: 'POST',
    sessionCookie: replayChallengeCookie,
    body: JSON.stringify({ code: recoveryCode })
  });
  assert.equal(replayVerify.status, 401);

  const registration = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Alex Member',
      phone: '555-0100',
      email: 'alex@example.test',
      preferredStartDate: getTodayDateString(),
      planKey: 'monthly',
      trainer: true
    })
  });
  assert.equal(registration.status, 201);
  const order = await registration.json();
  assert.equal(typeof order.id, 'number');
  assert.match(order.receiptId, /^BB-[A-F0-9]{10}$/);
  assert.equal(order.name, 'Alex Member');
  assert.equal(order.phone, '555-0100');
  assert.equal(order.plan, 'Monthly Standard Plan');
  assert.equal(order.planKey, 'monthly');
  assert.equal(order.trainer, true);
  assert.equal(order.total, 2000);
  assert.equal(order.status, 'Unpaid');
  assert.equal(order.email, 'alex@example.test');
  assert.equal(order.preferredStartDate, getTodayDateString());
  assert.equal((await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bad email', phone: '555', email: 'not-an-email', planKey: 'walkin' })
  })).status, 400);
  assert.equal((await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({ name: 'Past start', phone: '555', preferredStartDate: '2000-01-01', planKey: 'walkin' })
  })).status, 400);

  const missingReference = await request(`/api/admin/orders/${order.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid', paymentMethod: 'GCash', amountReceived: 2000 })
  });
  assert.equal(missingReference.status, 400);
  const amountMismatch = await request(`/api/admin/orders/${order.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid', paymentMethod: 'Cash', amountReceived: 1999 })
  });
  assert.equal(amountMismatch.status, 400);
  assert.equal((await amountMismatch.json()).requiresMismatchConfirmation, true);
  const paid = await request(`/api/admin/orders/${order.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid', paymentMethod: 'Cash', amountReceived: 2000 })
  });
  assert.equal(paid.status, 200);
  const paidOrder = await paid.json();
  assert.equal(typeof paidOrder.id, 'number');
  assert.equal(typeof paidOrder.total, 'number');
  assert.doesNotThrow(() => JSON.stringify(paidOrder));
  assert.equal(paidOrder.status, 'Paid');
  assert.equal(paidOrder.confirmedBy, 'owner');
  assert.ok(paidOrder.memberId);

  const members = await request('/api/admin/members');
  assert.equal(members.status, 200);
  const createdMembers = await members.json();
  assert.equal(createdMembers.length, 1);
  assert.equal(createdMembers[0].id, paidOrder.memberId);
  assert.equal(createdMembers[0].name, order.name);
  assert.equal(createdMembers[0].phone, order.phone);
  assert.equal(createdMembers[0].membershipType, order.planKey);
  assert.equal(createdMembers[0].startDate, order.preferredStartDate);
  assert.equal(createdMembers[0].endDate, calculateMembershipEndDate(order.preferredStartDate, order.planKey));
  const audit = await request('/api/admin/audit');
  assert.equal(audit.status, 200);
  assert.ok((await audit.json()).some(entry => entry.action === 'payment_confirmed' && entry.actor === 'owner'));

  const expiredMember = await request('/api/admin/members', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Expired Member',
      phone: '555-0101',
      membershipType: 'monthly',
      startDate: '2025-01-31'
    })
  });
  assert.equal(expiredMember.status, 201);
  const expiredRecord = await expiredMember.json();
  assert.equal(expiredRecord.endDate, '2025-02-28');
  const editedMember = await request(`/api/admin/members/${expiredRecord.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: 'Edited Member',
      phone: '555-0102',
      membershipType: '6month',
      startDate: '2025-01-31'
    })
  });
  assert.equal(editedMember.status, 200);
  assert.equal((await editedMember.json()).endDate, '2025-07-31');
  const renewedMember = await request(`/api/admin/members/${expiredRecord.id}/renew`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(renewedMember.status, 200);
  assert.equal((await renewedMember.json()).startDate, getTodayDateString());
  assert.equal((await request(`/api/admin/members/${expiredRecord.id}`, { method: 'DELETE' })).status, 204);

  const legacyMemberPayload = {
    name: 'Imported Legacy Record',
    phone: '',
    membershipType: 'monthly',
    startDate: '2020-01-31'
  };
  const legacyImport = await request('/api/admin/members/import-legacy', {
    method: 'POST',
    body: JSON.stringify({ members: [legacyMemberPayload] })
  });
  assert.equal(legacyImport.status, 201);
  assert.equal((await legacyImport.json()).importedCount, 1);
  const duplicateImport = await request('/api/admin/members/import-legacy', {
    method: 'POST',
    body: JSON.stringify({ members: [legacyMemberPayload] })
  });
  assert.equal((await duplicateImport.json()).skippedCount, 1);

  const cancelledOrderResponse = await request('/api/registrations', {
    method: 'POST',
    body: JSON.stringify({ name: 'Cancel Me', phone: '555-0200', planKey: 'walkin' })
  });
  const cancelledOrder = await cancelledOrderResponse.json();
  const cancelResponse = await request(`/api/admin/orders/${cancelledOrder.id}/cancel`, {
    method: 'PATCH',
    body: JSON.stringify({})
  });
  assert.equal(cancelResponse.status, 200);
  assert.equal((await cancelResponse.json()).status, 'Cancelled');
  const cancelledPayment = await request(`/api/admin/orders/${cancelledOrder.id}/payment`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Paid', paymentMethod: 'Cash', amountReceived: 50 })
  });
  assert.equal(cancelledPayment.status, 409);

  const filteredOrders = await request('/api/admin/orders?status=Cancelled&q=Cancel%20Me&limit=10&offset=0');
  assert.equal(filteredOrders.status, 200);
  assert.equal((await filteredOrders.json()).total, 1);

  const secondLogin = await request('/api/login', {
    method: 'POST',
    sessionCookie: null,
    body: JSON.stringify({ username: 'owner', password: TEST_PASSWORD })
  });
  assert.equal(secondLogin.status, 200);
  const secondChallengeCookie = secondLogin.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
  const secondVerify = await request('/api/login/verify-mfa', {
    method: 'POST',
    sessionCookie: secondChallengeCookie,
    body: JSON.stringify({ code: createTotp(setupSecret).generate() })
  });
  assert.equal(secondVerify.status, 200);
  const secondSessionCookie = secondVerify.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];

  const passwordChange = await request('/api/admin/password', {
    method: 'PATCH',
    body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'Another-Example-Password-456' })
  });
  assert.equal(passwordChange.status, 200);
  cookie = passwordChange.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
  assert.equal((await request('/api/admin/members')).status, 200);
  assert.equal((await request('/api/admin/members', { sessionCookie: secondSessionCookie })).status, 401);

  const encodedSessionId = decodeURIComponent(cookie.slice('bbf.sid='.length)).split('.')[0];
  const sessionId = encodedSessionId.slice(2);
  const currentSession = await new Promise((resolve, reject) => {
    app.locals.sessionStore.get(sessionId, (error, value) => error ? reject(error) : resolve(value));
  });
  currentSession.lastActivityAt = Date.now() - 31 * 60 * 1000;
  await new Promise((resolve, reject) => {
    app.locals.sessionStore.set(sessionId, currentSession, error => error ? reject(error) : resolve());
  });
  assert.equal((await request('/api/admin/members')).status, 401);
  cookie = undefined;

  const freshLogin = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'owner', password: 'Another-Example-Password-456' })
  });
  const freshChallengeCookie = freshLogin.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
  const freshVerify = await request('/api/login/verify-mfa', {
    method: 'POST',
    sessionCookie: freshChallengeCookie,
    body: JSON.stringify({ code: createTotp(setupSecret).generate() })
  });
  assert.equal(freshVerify.status, 200);
  cookie = freshVerify.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
  const logout = await request('/api/admin/sessions/revoke-all', {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(logout.status, 200);
  cookie = undefined;
  assert.equal((await request('/api/admin/members')).status, 401);

  await closeServer();
});

test('dashboard record reset requires owner confirmation and preserves admin data', async t => {
  const { database } = await createLocalDatabase(t);
  await database.initialize();
  const owner = await database.createFirstAdmin({
    id: crypto.randomUUID(),
    username: 'owner',
    passwordHash: await bcrypt.hash(TEST_PASSWORD, 4)
  });
  const staff = await database.createAdminAccount({
    id: crypto.randomUUID(),
    username: 'staff-user',
    passwordHash: await bcrypt.hash(TEST_PASSWORD, 4),
    role: 'staff'
  }, 'owner');
  await database.createMember({
    id: crypto.randomUUID(),
    name: 'Reset Test Member',
    phone: '555-0100',
    membershipType: 'monthly',
    startDate: getTodayDateString(),
    endDate: calculateMembershipEndDate(getTodayDateString(), 'monthly')
  }, 'owner');
  await database.createOrder({
    receiptId: 'BB-RESET-TEST',
    name: 'Reset Test Member',
    phone: '555-0100',
    plan: 'Monthly Standard Plan',
    planKey: 'monthly',
    trainer: false,
    total: 500,
    date: getTodayDateString(),
    email: null,
    preferredStartDate: getTodayDateString()
  });

  const app = createApplication({
    database,
    sessionSecret: 'test-session-secret-that-is-at-least-32-characters',
    mfaEncryptionKey: TEST_MFA_KEY,
    isProduction: false
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  async function request(route, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    const { sessionCookie, ...fetchOptions } = options;
    if (route.startsWith('/api/admin/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      headers['X-Requested-With'] = 'fetch';
      headers.Origin = baseUrl;
    }
    if (sessionCookie) headers.Cookie = sessionCookie;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}${route}`, { ...fetchOptions, headers });
  }

  async function signIn(username) {
    const login = await request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password: TEST_PASSWORD })
    });
    assert.equal(login.status, 200);
    const challengeCookie = login.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
    const challenge = await login.json();
    const verify = await request('/api/login/verify-mfa', {
      method: 'POST',
      sessionCookie: challengeCookie,
      body: JSON.stringify({
        code: createTotp(challenge.manualSecret, username).generate()
      })
    });
    assert.equal(verify.status, 200);
    return verify.headers.get('set-cookie').match(/bbf\.sid=[^;]+/)[0];
  }

  assert.equal((await request('/api/admin/records/reset', {
    method: 'POST',
    body: JSON.stringify({ confirmed: true })
  })).status, 401);

  const staffCookie = await signIn(staff.username);
  assert.equal((await request('/api/admin/records/reset', {
    method: 'POST',
    sessionCookie: staffCookie,
    body: JSON.stringify({ confirmed: true })
  })).status, 403);

  const ownerCookie = await signIn(owner.username);
  assert.equal((await request('/api/admin/records/reset', {
    method: 'POST',
    sessionCookie: ownerCookie,
    body: JSON.stringify({})
  })).status, 400);

  const reset = await request('/api/admin/records/reset', {
    method: 'POST',
    sessionCookie: ownerCookie,
    body: JSON.stringify({ confirmed: true })
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { membersDeleted: 1, ordersDeleted: 1 });
  assert.equal((await database.listMembers()).length, 0);
  assert.equal((await database.listOrders()).total, 0);
  assert.equal(await database.adminAccountCount(), 2);
  assert.equal((await request('/api/admin/members', { sessionCookie: staffCookie })).status, 200);
  const audit = await request('/api/admin/audit', { sessionCookie: ownerCookie });
  const auditItems = await audit.json();
  assert.ok(auditItems.some(entry => entry.action === 'registration_received'));
  assert.ok(auditItems.some(entry =>
    entry.action === 'dashboard_records_reset' &&
    entry.actor === 'owner' &&
    entry.details.membersDeleted === 1 &&
    entry.details.ordersDeleted === 1
  ));
  assert.deepEqual(await (await request('/api/dashboard/overview')).json(), {
    totalRevenue: 0,
    activeMembers: 0,
    walkinsToday: 0,
    trainerCount: 0
  });
});
