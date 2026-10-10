const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

const DEFAULT_PRIVATE_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'BigBozzFitness')
  : path.join(__dirname, '..', 'bbf-private-data');
const DEFAULT_ENV_FILE = process.env.LOCALAPPDATA
  ? path.join(DEFAULT_PRIVATE_DIR, '.env')
  : path.join(__dirname, '.env');

dotenv.config({ path: process.env.ENV_FILE || DEFAULT_ENV_FILE });

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { createDatabase } = require('./database');

const DEFAULT_DATA_DIR = DEFAULT_PRIVATE_DIR;
const MAX_BACKUP_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

function isOutsidePublicDirectory(directory) {
  const relativePath = path.relative(__dirname, directory);
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function getTodayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function calculateMembershipEndDate(startDate, membershipType) {
  const [year, month, day] = startDate.split('-').map(Number);
  const targetMonthIndex = month - 1 + (membershipType === '6month' ? 6 : 1);
  const endYear = year + Math.floor(targetMonthIndex / 12);
  const endMonth = targetMonthIndex % 12;
  const endDay = Math.min(day, new Date(Date.UTC(endYear, endMonth + 1, 0)).getUTCDate());
  return `${endYear}-${String(endMonth + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function mapMember(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone || '',
    membershipType: row.membership_type,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapOrder(row) {
  return {
    id: row.id,
    receiptId: row.receipt_id,
    name: row.name,
    phone: row.phone,
    plan: row.plan,
    planKey: row.plan_key,
    trainer: Boolean(row.trainer),
    total: row.total,
    status: row.status,
    date: row.date,
    memberId: row.member_id,
    createdAt: row.created_at,
    email: row.email || '',
    preferredStartDate: row.preferred_start_date || '',
    paymentMethod: row.payment_method || '',
    paymentReference: row.payment_reference || '',
    amountReceived: row.amount_received,
    paidAt: row.paid_at || '',
    confirmedBy: row.confirmed_by || ''
  };
}

function validateMemberInput(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const membershipType = body.membershipType;
  const startDate = body.startDate;

  if (!name || name.length > 100) return { error: 'Member name must be between 1 and 100 characters.' };
  if (phone.length > 30) return { error: 'Phone number must be 30 characters or fewer.' };
  if (!['monthly', '6month'].includes(membershipType)) return { error: 'Choose Monthly or 6-Month membership.' };
  if (!isValidDateString(startDate)) return { error: 'Enter a valid membership start date.' };

  return { value: { name, phone: phone || null, membershipType, startDate } };
}

function createApplication(options = {}) {
  const dataDirectory = options.dataDirectory
    ? path.resolve(options.dataDirectory)
    : process.env.DATA_DIR
      ? path.resolve(__dirname, process.env.DATA_DIR)
      : DEFAULT_DATA_DIR;
  if (!isOutsidePublicDirectory(dataDirectory)) {
    throw new Error('DATA_DIR must be outside the public application directory.');
  }

  const backupDirectory = path.join(dataDirectory, 'backups');
  const adminUsername = options.adminUsername || process.env.ADMIN_USERNAME || 'owner';
  const adminEmail = (options.adminEmail || process.env.ADMIN_EMAIL || 'owner@bigbozzfitness.com').toLowerCase();
  const adminPassword = options.adminPassword || process.env.ADMIN_PASSWORD;
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
  const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';

  if (adminPassword && adminPassword.length < 12) {
    throw new Error('Set ADMIN_PASSWORD to a password of at least 12 characters in the .env file.');
  }
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('Set SESSION_SECRET to a random value of at least 32 characters in the .env file.');
  }

  const database = options.database || createDatabase(dataDirectory);
  const app = express();
  if (adminPassword) database.seedAdminPasswordHash(bcrypt.hashSync(adminPassword, 12));
  if (!database.getAdminPasswordHash()) {
    throw new Error('Set ADMIN_PASSWORD to seed the initial admin password.');
  }
  const sessionStore = database.createSessionStore(session);

  if (isProduction) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        frameSrc: ['https://maps.google.com', 'https://www.google.com'],
        connectSrc: ["'self'", 'https://cdn.tailwindcss.com']
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(session({
    name: 'bbf.sid',
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 8
    }
  }));
  app.use('/api/admin', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (!req.session || !req.session.isAuthenticated) return next();
    const origin = req.get('origin');
    if (req.get('x-requested-with') !== 'fetch' || !origin) {
      return res.status(403).json({ message: 'This request could not be verified. Refresh the page and try again.' });
    }
    try {
      const originHost = new URL(origin).host.toLowerCase();
      if (originHost !== String(req.get('host') || '').toLowerCase()) {
        return res.status(403).json({ message: 'This request could not be verified. Refresh the page and try again.' });
      }
    } catch {
      return res.status(403).json({ message: 'This request could not be verified. Refresh the page and try again.' });
    }
    return next();
  });
  app.use('/api/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many login attempts. Please wait 15 minutes and try again.' }
  });
  const registrationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many registration attempts. Please try again later.' }
  });

  app.get('/api/admin/stats', isAuthenticated, (req, res) => {
    try {
      return res.json(database.stats(getTodayDateString()));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.get('/api/dashboard/overview', (req, res) => {
    try {
      return res.set('Cache-Control', 'no-store').json(database.publicOverview(getTodayDateString()));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  function isAuthenticated(req, res, next) {
    if (req.session && req.session.isAuthenticated) return next();
    return res.status(401).json({ message: 'Unauthorized: admin access required.' });
  }

  function respondWithError(res, error) {
    console.error('API request failed.', error);
    return res.status(500).json({ message: 'The request could not be completed. Please try again.' });
  }

  app.get('/api/session', (req, res) => {
    res.json({
      authenticated: !!(req.session && req.session.isAuthenticated),
      user: req.session && req.session.user ? req.session.user : null
    });
  });

  app.post('/api/login', loginLimiter, async (req, res, next) => {
    try {
      const usernameOrEmail = String(req.body.usernameOrEmail || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const matchesAdminIdentity = usernameOrEmail === adminUsername.toLowerCase() || usernameOrEmail === adminEmail;
      const isValidPassword = await bcrypt.compare(
        password,
        matchesAdminIdentity ? database.getAdminPasswordHash() : DUMMY_PASSWORD_HASH
      );

      if (!matchesAdminIdentity || !isValidPassword) {
        database.recordFailedLogin(usernameOrEmail.slice(0, 120) || 'anonymous');
        return res.status(401).json({ message: 'Invalid admin credentials.' });
      }

      return req.session.regenerate(error => {
        if (error) return next(error);
        req.session.isAuthenticated = true;
        req.session.user = { username: adminUsername, email: adminEmail, role: 'owner' };
        return req.session.save(saveError => {
          if (saveError) return next(saveError);
          return res.json({ success: true, user: req.session.user, message: 'Admin login successful.' });
        });
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/admin/unlock', loginLimiter, async (req, res, next) => {
    try {
      const code = typeof req.body.code === 'string' ? req.body.code : '';
      const isValidCode = await bcrypt.compare(code, database.getAdminPasswordHash());
      if (!isValidCode) {
        database.recordFailedLogin('admin-code');
        return res.status(401).json({ message: 'Invalid admin code.' });
      }
      return req.session.regenerate(error => {
        if (error) return next(error);
        req.session.isAuthenticated = true;
        req.session.user = { username: adminUsername, email: adminEmail, role: 'owner' };
        return req.session.save(saveError => {
          if (saveError) return next(saveError);
          return res.json({ success: true, user: req.session.user, message: 'Admin controls unlocked.' });
        });
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(error => {
      if (error) {
        console.error('Unable to destroy admin session.', error);
        return res.status(500).json({ message: 'Unable to logout right now.' });
      }
      res.clearCookie('bbf.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
      return res.json({ success: true, message: 'Logged out successfully.' });
    });
  });

  app.post('/api/registrations', registrationLimiter, (req, res) => {
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
      const planKey = req.body.planKey;
      const trainer = req.body.trainer === true;
      const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
      const preferredStartDate = req.body.preferredStartDate || getTodayDateString();
      const planDetails = {
        walkin: { name: 'Walk-in / Per Session', price: 50 },
        monthly: { name: 'Monthly Standard Plan', price: 500 },
        '6month': { name: '6-Month Plan (₱450/mo)', price: 2700 }
      }[planKey];

      if (!name || name.length > 100) return res.status(400).json({ message: 'Enter a name between 1 and 100 characters.' });
      if (!phone || phone.length > 30) return res.status(400).json({ message: 'Enter a phone number of 30 characters or fewer.' });
      if (!planDetails) return res.status(400).json({ message: 'Choose a valid membership plan.' });
      if (email.length > 320 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        return res.status(400).json({ message: 'Enter a valid email address, or leave it blank.' });
      }
      if (!isValidDateString(preferredStartDate) || preferredStartDate < getTodayDateString()) {
        return res.status(400).json({ message: 'Preferred start date must be a valid date today or later.' });
      }

      const order = database.createOrder({
        receiptId: `BB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
        name,
        phone,
        plan: planDetails.name,
        planKey,
        trainer,
        total: planDetails.price + (trainer ? 1500 : 0),
        date: getTodayDateString(),
        email: email || null,
        preferredStartDate
      });
      return res.status(201).json(mapOrder(order));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.get('/api/admin/members', isAuthenticated, (req, res) => {
    try {
      return res.json(database.listMembers().map(mapMember));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.post('/api/admin/members/import-legacy', isAuthenticated, (req, res) => {
    try {
      if (!Array.isArray(req.body.members) || req.body.members.length > 1000) {
        return res.status(400).json({ message: 'Legacy member data must be an array of at most 1,000 members.' });
      }
      const validatedMembers = [];
      for (const input of req.body.members) {
        const validation = validateMemberInput(input);
        if (validation.error) return res.status(400).json({ message: validation.error });
        validatedMembers.push(validation.value);
      }
      const result = database.importLegacyMembers(
        validatedMembers,
        req.session.user.username,
        calculateMembershipEndDate
      );
      return res.status(201).json({
        members: result.members.map(mapMember),
        importedCount: result.importedCount,
        skippedCount: result.skippedCount
      });
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.post('/api/admin/members', isAuthenticated, (req, res) => {
    const validation = validateMemberInput(req.body);
    if (validation.error) return res.status(400).json({ message: validation.error });
    try {
      const member = database.createMember({
        id: crypto.randomUUID(),
        ...validation.value,
        endDate: calculateMembershipEndDate(validation.value.startDate, validation.value.membershipType)
      }, req.session.user.username);
      return res.status(201).json(mapMember(member));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.patch('/api/admin/members/:id', isAuthenticated, (req, res) => {
    const validation = validateMemberInput(req.body);
    if (validation.error) return res.status(400).json({ message: validation.error });
    try {
      const member = database.updateMember(req.params.id, {
        ...validation.value,
        endDate: calculateMembershipEndDate(validation.value.startDate, validation.value.membershipType)
      }, req.session.user.username);
      if (!member) return res.status(404).json({ message: 'Member not found.' });
      return res.json(mapMember(member));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.post('/api/admin/members/:id/renew', isAuthenticated, (req, res) => {
    try {
      const member = database.renewMember(
        req.params.id,
        getTodayDateString(),
        calculateMembershipEndDate,
        addDays,
        req.session.user.username
      );
      if (!member) return res.status(404).json({ message: 'Member not found.' });
      return res.json(mapMember(member));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.delete('/api/admin/members/:id', isAuthenticated, (req, res) => {
    try {
      if (!database.deleteMember(req.params.id, req.session.user.username)) {
        return res.status(404).json({ message: 'Member not found.' });
      }
      return res.status(204).end();
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.get('/api/admin/orders', isAuthenticated, (req, res) => {
    try {
      const hasFilters = ['status', 'q', 'limit', 'offset'].some(key => Object.hasOwn(req.query, key));
      const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : 'All';
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
      const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
      if (!['All', 'Unpaid', 'Paid', 'Cancelled'].includes(status)) {
        return res.status(400).json({ message: 'Choose All, Unpaid, Paid, or Cancelled status.' });
      }
      if (query.length > 100) return res.status(400).json({ message: 'Search text must be 100 characters or fewer.' });
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ message: 'Limit must be an integer between 1 and 100.' });
      }
      if (!Number.isInteger(offset) || offset < 0) {
        return res.status(400).json({ message: 'Offset must be a non-negative integer.' });
      }
      const result = database.listOrders({
        status,
        query,
        limit: hasFilters ? limit : 10000,
        offset: hasFilters ? offset : 0
      });
      const orders = result.orders.map(mapOrder);
      if (!hasFilters) return res.json(orders);
      return res.json({ orders, total: result.total, limit, offset, pendingCount: result.pendingCount });
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.patch('/api/admin/orders/:id/payment', isAuthenticated, (req, res) => {
    if (req.body.status !== 'Paid') {
      return res.status(400).json({ message: 'Payments can only be confirmed after collection; paid orders cannot be reverted here.' });
    }
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }
    try {
      const currentOrder = database.getOrder(orderId);
      if (!currentOrder) return res.status(404).json({ message: 'Order not found.' });
      if (currentOrder.status === 'Paid') return res.json(mapOrder(currentOrder));
      if (currentOrder.status === 'Cancelled') {
        return res.status(409).json({ message: 'Cancelled orders cannot be paid.' });
      }
    } catch (error) {
      return respondWithError(res, error);
    }
    const paymentMethod = req.body.paymentMethod === undefined ? 'Cash' : req.body.paymentMethod;
    if (req.body.paymentReference !== undefined && typeof req.body.paymentReference !== 'string') {
      return res.status(400).json({ message: 'Reference number must be text.' });
    }
    const paymentReference = typeof req.body.paymentReference === 'string' ? req.body.paymentReference.trim() : '';
    const amountReceived = req.body.amountReceived === undefined
      ? undefined
      : req.body.amountReceived;
    if (!['Cash', 'GCash'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'Choose Cash or GCash as the payment method.' });
    }
    if (paymentReference.length > 50 || (paymentMethod === 'GCash' && !paymentReference)) {
      return res.status(400).json({ message: 'Reference numbers must be 50 characters or fewer; GCash requires one.' });
    }
    try {
      const currentOrder = database.getOrder(orderId);
      const received = amountReceived === undefined ? currentOrder.total : amountReceived;
      if (typeof received !== 'number' || !Number.isFinite(received) || received < 0 || received > 1000000000) {
        return res.status(400).json({ message: 'Enter a valid amount received.' });
      }
      if (received !== currentOrder.total && req.body.allowMismatch !== true) {
        return res.status(400).json({
          message: `Amount received must equal ₱${Number(currentOrder.total).toLocaleString()} unless you explicitly allow the mismatch.`,
          requiresMismatchConfirmation: true
        });
      }
      const order = database.confirmPayment(
        orderId,
        getTodayDateString(),
        calculateMembershipEndDate,
        addDays,
        req.session.user.username,
        { paymentMethod, paymentReference, amountReceived: received, allowMismatch: req.body.allowMismatch === true }
      );
      if (!order) return res.status(404).json({ message: 'Order not found.' });
      return res.json(mapOrder(order));
    } catch (error) {
      if (error.code === 'ORDER_CANCELLED') return res.status(409).json({ message: error.message });
      return respondWithError(res, error);
    }
  });

  app.patch('/api/admin/orders/:id/cancel', isAuthenticated, (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return res.status(400).json({ message: 'Invalid order ID.' });
    try {
      const result = database.cancelOrder(orderId, req.session.user.username);
      if (result.result === 'missing') return res.status(404).json({ message: 'Order not found.' });
      if (result.result === 'not_unpaid') return res.status(409).json({ message: 'Only unpaid orders can be cancelled.' });
      return res.json(mapOrder(result.order));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.patch('/api/admin/password', isAuthenticated, async (req, res) => {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    if (newPassword.length < 12) return res.status(400).json({ message: 'New password must be at least 12 characters.' });
    try {
      if (!await bcrypt.compare(currentPassword, database.getAdminPasswordHash())) {
        return res.status(401).json({ message: 'Current password is incorrect.' });
      }
      database.changeAdminPasswordHash(await bcrypt.hash(newPassword, 12), req.session.user.username);
      return res.json({ success: true, message: 'Admin password updated.' });
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.get('/api/admin/audit', isAuthenticated, (req, res) => {
    try {
      return res.json(database.listAudit(100));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  async function createBackup() {
    await fs.promises.mkdir(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `bigbozz-${stamp}.sqlite`;
    const fullPath = path.join(backupDirectory, filename);
    await database.backup(fullPath);
    await removeOldBackups(backupDirectory);
    return { filename, createdAt: new Date().toISOString() };
  }

  app.post('/api/admin/backups', isAuthenticated, async (req, res) => {
    try {
      const backup = await createBackup();
      database.recordAudit(req.session.user.username, 'database_backup_created', 'database', 'sqlite', {
        filename: backup.filename
      });
      return res.status(201).json({ success: true, ...backup });
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.get('/api/admin/backups/:filename', isAuthenticated, (req, res) => {
    const filename = req.params.filename;
    if (!/^bigbozz-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/.test(filename)) {
      return res.status(400).json({ message: 'Invalid backup filename.' });
    }
    const fullPath = path.join(backupDirectory, filename);
    return res.download(fullPath, filename, error => {
      if (error && !res.headersSent) {
        if (error.code === 'ENOENT') return res.status(404).json({ message: 'Backup file not found.' });
        return respondWithError(res, error);
      }
      return undefined;
    });
  });

  app.use('/api', (req, res) => res.status(404).json({ message: 'API endpoint not found.' }));
  app.get('/BBFDesign.css', (req, res) => res.sendFile(path.join(__dirname, 'BBFDesign.css')));
  app.get('/BBFfunc.js', (req, res) => res.sendFile(path.join(__dirname, 'BBFfunc.js')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'BBFIndex.html')));
  app.get('/admin', (req, res) => {
    if (!req.session || !req.session.isAuthenticated) return res.redirect('/');
    return res.sendFile(path.join(__dirname, 'BBFIndex.html'));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('Unhandled request error.', error);
    return res.status(500).json({ message: 'An unexpected server error occurred.' });
  });

  app.locals.database = database;
  app.locals.dataDirectory = dataDirectory;
  app.locals.createBackup = createBackup;
  app.locals.backupDirectory = backupDirectory;
  app.locals.sessionStore = sessionStore;
  return app;
}

async function removeOldBackups(directory) {
  const files = await fs.promises.readdir(directory, { withFileTypes: true });
  const oldestAllowed = Date.now() - MAX_BACKUP_AGE_MS;
  await Promise.all(files
    .filter(entry => entry.isFile() && /^bigbozz-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/.test(entry.name))
    .map(async entry => {
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.promises.stat(fullPath);
      if (stat.mtimeMs < oldestAllowed) await fs.promises.unlink(fullPath);
    }));
}

function scheduleDailyBackup(app) {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const timer = setTimeout(async () => {
    try {
      const backup = await app.locals.createBackup();
      app.locals.database.recordAudit('system', 'scheduled_database_backup_created', 'database', 'sqlite', {
        filename: backup.filename
      });
      console.log(`Daily database backup created: ${backup.filename}`);
    } catch (error) {
      console.error('Daily database backup failed.', error);
    } finally {
      scheduleDailyBackup(app);
    }
  }, nextMidnight.getTime() - now.getTime());
  timer.unref();
}

if (require.main === module) {
  try {
    const app = createApplication();
    const port = Number(process.env.PORT || 3000);
    app.listen(port, () => {
      console.log(`Big Bozz Fitness is running on port ${port}.`);
      console.log(`Data directory: ${app.locals.dataDirectory}`);
      scheduleDailyBackup(app);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApplication, calculateMembershipEndDate, getTodayDateString, isValidDateString };
