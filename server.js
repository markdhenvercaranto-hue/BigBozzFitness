const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const { createDatabase } = require('./database');

const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

function encryptMfaSecret(secret, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}

function decryptMfaSecret(encrypted, key) {
  const stored = JSON.parse(encrypted);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(stored.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function createTotp(secret, username) {
  return new OTPAuth.TOTP({
    issuer: 'Big Bozz Fitness',
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret)
  });
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
}

function generateRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const code = crypto.randomBytes(16).toString('hex').toUpperCase();
    return { code: `${code.slice(0, 8)}-${code.slice(8)}`, hash: hashRecoveryCode(code) };
  });
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
    id: Number(row.id),
    receiptId: row.receipt_id,
    name: row.name,
    phone: row.phone,
    plan: row.plan,
    planKey: row.plan_key,
    trainer: Boolean(row.trainer),
    total: Number(row.total),
    status: row.status,
    date: row.date,
    memberId: row.member_id,
    createdAt: row.created_at,
    email: row.email || '',
    preferredStartDate: row.preferred_start_date || '',
    paymentMethod: row.payment_method || '',
    paymentReference: row.payment_reference || '',
    amountReceived: row.amount_received == null ? null : Number(row.amount_received),
    paidAt: row.paid_at || '',
    confirmedBy: row.confirmed_by || ''
  };
}

function mapAdminAccount(account) {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    createdAt: account.createdAt,
    disabled: Boolean(account.disabled),
    mfaEnabled: Boolean(account.mfaEnabled)
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
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
  const mfaEncryptionSecret = options.mfaEncryptionKey || process.env.MFA_ENCRYPTION_KEY;
  const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';

  if (!sessionSecret || sessionSecret.length < 32 || new Set(sessionSecret).size < 12 || /change[_ -]?me|placeholder|example/i.test(sessionSecret)) {
    throw new Error('Set SESSION_SECRET to a unique random value of at least 32 characters.');
  }
  if (!/^[0-9a-f]{64}$/i.test(mfaEncryptionSecret || '') || new Set(Buffer.from(mfaEncryptionSecret, 'hex')).size < 10) {
    throw new Error('Set MFA_ENCRYPTION_KEY to a unique random 32-byte hex value.');
  }
  if (isProduction && !options.database && !process.env.TURSO_DATABASE_URL) {
    throw new Error('Set TURSO_DATABASE_URL in production; the local database fallback is for development only.');
  }
  if (isProduction && !options.database && !process.env.TURSO_AUTH_TOKEN) {
    throw new Error('Set TURSO_AUTH_TOKEN in production.');
  }
  const mfaEncryptionKey = Buffer.from(mfaEncryptionSecret, 'hex');

  const database = options.database || createDatabase(options.databaseOptions);
  const app = express();
  const sessionStore = database.createSessionStore(session);
  let databaseReady;
  const initializeDatabase = () => {
    if (!databaseReady) {
      databaseReady = (async () => {
        await database.initialize();
        if (!await database.adminAccountCount()) {
          throw new Error('No admin accounts exist. Run "npm run admin:create" to migrate the legacy owner account.');
        }
      })();
    }
    return databaseReady;
  };

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    initializeDatabase().then(() => next()).catch(error => {
      console.error('Database initialization failed.', error);
      res.status(503).json({ message: 'The application database is unavailable.' });
    });
  });
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
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: SESSION_IDLE_TIMEOUT_MS
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
  function enforceAdminSessionTimeout(req, res, next) {
    if (!req.session || !req.session.isAuthenticated) return next();
    const now = Date.now();
    const authenticatedAt = Number(req.session.authenticatedAt);
    const lastActivityAt = Number(req.session.lastActivityAt);
    if (
      !Number.isFinite(authenticatedAt) ||
      !Number.isFinite(lastActivityAt) ||
      now - authenticatedAt >= SESSION_ABSOLUTE_TIMEOUT_MS ||
      now - lastActivityAt >= SESSION_IDLE_TIMEOUT_MS
    ) {
      return req.session.destroy(error => {
        if (error) {
          console.error('Unable to expire admin session.', error);
          return res.status(500).json({ message: 'Unable to verify the admin session.' });
        }
        res.clearCookie('bbf.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
        if (req.baseUrl === '/admin') return res.redirect('/');
        return res.status(401).json({ message: 'Admin session expired. Sign in again.' });
      });
    }
    req.session.lastActivityAt = now;
    return next();
  }
  app.use('/api/admin', enforceAdminSessionTimeout);
  app.use('/admin', enforceAdminSessionTimeout);

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

  app.get('/api/admin/stats', isAuthenticated, async (req, res) => {
    try {
      return res.json(await database.stats(getTodayDateString()));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.get('/api/dashboard/overview', async (req, res) => {
    try {
      return res.set('Cache-Control', 'no-store').json(await database.publicOverview(getTodayDateString()));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.post('/api/admin/records/reset', isAuthenticated, requireOwner, async (req, res) => {
    if (req.body.confirmed !== true) {
      return res.status(400).json({ message: 'Confirm the dashboard record reset before continuing.' });
    }
    try {
      return res.json(await database.resetDashboardRecords(req.session.user.username));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  async function isAuthenticated(req, res, next) {
    try {
      if (!req.session || !req.session.isAuthenticated || !req.session.user || !req.session.user.id) {
        return res.status(401).json({ message: 'Unauthorized: admin access required.' });
      }
      const account = await database.getAdminAccountById(req.session.user.id);
      if (!account || account.disabled) {
        return req.session.destroy(() => res.status(401).json({ message: 'Unauthorized: admin access required.' }));
      }
      req.session.user = { id: account.id, username: account.username, role: account.role };
      return next();
    } catch (error) {
      return next(error);
    }
  }

  function requireOwner(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'owner') return next();
    return res.status(403).json({ message: 'Owner access is required for this action.' });
  }

  function establishAdminSession(req, res, next, account, extra = {}) {
    return req.session.regenerate(error => {
      if (error) return next(error);
      req.session.isAuthenticated = true;
      req.session.user = { id: account.id, username: account.username, role: account.role };
      req.session.authenticatedAt = Date.now();
      req.session.lastActivityAt = req.session.authenticatedAt;
      return req.session.save(saveError => {
        if (saveError) return next(saveError);
        return database.recordAudit(account.username, 'admin_login_succeeded', 'admin_account', account.id, {}).then(() => res.json({
          success: true,
          user: req.session.user,
          message: 'Admin login successful.',
          ...extra
        }), next);
      });
    });
  }

  function beginMfaChallenge(req, res, next, account, setup) {
    const createChallenge = async () => {
      let responseFields = { mfaRequired: true };
      let encryptedSecret;
      if (setup) {
        const secret = new OTPAuth.Secret({ size: 20 }).base32;
        const totp = createTotp(secret, account.username);
        encryptedSecret = encryptMfaSecret(secret, mfaEncryptionKey);
        responseFields = {
          mfaSetupRequired: true,
          qrCodeDataUrl: await QRCode.toDataURL(totp.toString()),
          manualSecret: secret
        };
      }
      return req.session.regenerate(error => {
        if (error) return next(error);
        req.session.mfaPendingAdminId = account.id;
        if (setup) req.session.mfaEnrollmentSecret = encryptedSecret;
        return req.session.save(saveError => {
          if (saveError) return next(saveError);
          return res.json(responseFields);
        });
      });
    };
    return createChallenge().catch(next);
  }

  function respondWithError(res, error) {
    console.error('API request failed.', error);
    return res.status(500).json({ message: 'The request could not be completed. Please try again.' });
  }

  app.get('/api/session', async (req, res, next) => {
    try {
    const account = req.session && req.session.user
      ? await database.getAdminAccountById(req.session.user.id)
      : null;
    const authenticated = Boolean(req.session && req.session.isAuthenticated && account && !account.disabled);
    res.json({
      authenticated,
      user: authenticated ? { id: account.id, username: account.username, role: account.role } : null
    });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/login', loginLimiter, async (req, res, next) => {
    try {
      const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      const account = username ? await database.getAdminAccountByUsername(username) : null;
      const isValidPassword = await bcrypt.compare(password, account ? account.passwordHash : DUMMY_PASSWORD_HASH);

      if (!account || account.disabled || !isValidPassword) {
        await database.recordFailedLogin(username.slice(0, 120) || 'anonymous');
        return res.status(401).json({ message: 'Invalid admin credentials.' });
      }
      return beginMfaChallenge(req, res, next, account, !account.mfaEnabled);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/login/verify-mfa', loginLimiter, async (req, res, next) => {
    try {
      const adminId = req.session && req.session.mfaPendingAdminId;
      const account = adminId ? await database.getAdminAccountById(adminId) : null;
      const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
      if (!account || account.disabled) {
        await database.recordFailedLogin('mfa-challenge');
        return res.status(401).json({ message: 'Invalid admin credentials or verification code.' });
      }

      if (req.session.mfaEnrollmentSecret) {
        const secret = decryptMfaSecret(req.session.mfaEnrollmentSecret, mfaEncryptionKey);
        const validToken = /^\d{6}$/.test(code) && createTotp(secret, account.username).validate({ token: code, window: 1 }) !== null;
        if (!validToken) {
          await database.recordFailedLogin(account.username);
          return res.status(401).json({ message: 'Invalid admin credentials or verification code.' });
        }
        const recoveryCodes = generateRecoveryCodes();
        if (!await database.enableAdminMfa(
          account.id,
          encryptMfaSecret(secret, mfaEncryptionKey),
          recoveryCodes,
          account.username
        )) {
          return res.status(401).json({ message: 'Invalid admin credentials or verification code.' });
        }
        return establishAdminSession(
          req,
          res,
          next,
          account,
          { recoveryCodes: recoveryCodes.map(item => item.code) }
        );
      }

      const secret = account.mfaEnabled && account.totpSecret
        ? decryptMfaSecret(account.totpSecret, mfaEncryptionKey)
        : null;
      const validTotp = secret && /^\d{6}$/.test(code)
        ? createTotp(secret, account.username).validate({ token: code, window: 1 }) !== null
        : false;
      const validRecoveryCode = validTotp ? false : await database.consumeAdminRecoveryCode(account.id, hashRecoveryCode(code));
      if (!validTotp && !validRecoveryCode) {
        await database.recordFailedLogin(account.username);
        return res.status(401).json({ message: 'Invalid admin credentials or verification code.' });
      }
      return establishAdminSession(req, res, next, account);
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

  app.post('/api/registrations', registrationLimiter, async (req, res) => {
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

      const order = await database.createOrder({
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
      if (!order || !order.receipt_id || !Number.isSafeInteger(Number(order.id))) {
        throw new Error('The order was saved but its receipt details could not be loaded.');
      }
      return res.status(201).json(mapOrder(order));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.get('/api/admin/members', isAuthenticated, async (req, res) => {
    try {
      return res.json((await database.listMembers()).map(mapMember));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.post('/api/admin/members/import-legacy', isAuthenticated, async (req, res) => {
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
      const result = await database.importLegacyMembers(
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

  app.post('/api/admin/members', isAuthenticated, async (req, res) => {
    const validation = validateMemberInput(req.body);
    if (validation.error) return res.status(400).json({ message: validation.error });
    try {
      const member = await database.createMember({
        id: crypto.randomUUID(),
        ...validation.value,
        endDate: calculateMembershipEndDate(validation.value.startDate, validation.value.membershipType)
      }, req.session.user.username);
      return res.status(201).json(mapMember(member));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.patch('/api/admin/members/:id', isAuthenticated, async (req, res) => {
    const validation = validateMemberInput(req.body);
    if (validation.error) return res.status(400).json({ message: validation.error });
    try {
      const member = await database.updateMember(req.params.id, {
        ...validation.value,
        endDate: calculateMembershipEndDate(validation.value.startDate, validation.value.membershipType)
      }, req.session.user.username);
      if (!member) return res.status(404).json({ message: 'Member not found.' });
      return res.json(mapMember(member));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.post('/api/admin/members/:id/renew', isAuthenticated, async (req, res) => {
    try {
      const member = await database.renewMember(
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

  app.delete('/api/admin/members/:id', isAuthenticated, async (req, res) => {
    try {
      if (!await database.deleteMember(req.params.id, req.session.user.username)) {
        return res.status(404).json({ message: 'Member not found.' });
      }
      return res.status(204).end();
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.get('/api/admin/orders', isAuthenticated, async (req, res) => {
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
      const result = await database.listOrders({
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

  app.patch('/api/admin/orders/:id/payment', isAuthenticated, async (req, res) => {
    if (req.body.status !== 'Paid') {
      return res.status(400).json({ message: 'Payments can only be confirmed after collection; paid orders cannot be reverted here.' });
    }
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }
    try {
      const currentOrder = await database.getOrder(orderId);
      if (!currentOrder) return res.status(404).json({ message: 'Order not found.' });
      const expectedTotal = Number(currentOrder.total);
      if (!Number.isFinite(expectedTotal)) {
        throw new Error('The order total is not a valid number.');
      }
      if (currentOrder.status === 'Paid') return res.json(mapOrder(currentOrder));
      if (currentOrder.status === 'Cancelled') {
        return res.status(409).json({ message: 'Cancelled orders cannot be paid.' });
      }

      const paymentMethod = req.body.paymentMethod === undefined ? 'Cash' : req.body.paymentMethod;
      if (req.body.paymentReference !== undefined && typeof req.body.paymentReference !== 'string') {
        return res.status(400).json({ message: 'Reference number must be text.' });
      }
      const paymentReference = typeof req.body.paymentReference === 'string' ? req.body.paymentReference.trim() : '';
      if (!['Cash', 'GCash'].includes(paymentMethod)) {
        return res.status(400).json({ message: 'Choose Cash or GCash as the payment method.' });
      }
      if (paymentReference.length > 50 || (paymentMethod === 'GCash' && !paymentReference)) {
        return res.status(400).json({ message: 'Reference numbers must be 50 characters or fewer; GCash requires one.' });
      }
      const amountReceived = req.body.amountReceived;
      const received = amountReceived === undefined ? expectedTotal : Number(amountReceived);
      if (typeof received !== 'number' || !Number.isFinite(received) || received < 0 || received > 1000000000) {
        return res.status(400).json({ message: 'Enter a valid amount received.' });
      }
      if (received !== expectedTotal && req.body.allowMismatch !== true) {
        return res.status(400).json({
          message: `Amount received must equal ₱${expectedTotal.toLocaleString()} unless you explicitly allow the mismatch.`,
          requiresMismatchConfirmation: true
        });
      }
      const order = await database.confirmPayment(
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

  app.patch('/api/admin/orders/:id/cancel', isAuthenticated, async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return res.status(400).json({ message: 'Invalid order ID.' });
    try {
      const result = await database.cancelOrder(orderId, req.session.user.username);
      if (result.result === 'missing') return res.status(404).json({ message: 'Order not found.' });
      if (result.result === 'not_unpaid') return res.status(409).json({ message: 'Only unpaid orders can be cancelled.' });
      return res.json(mapOrder(result.order));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.patch('/api/admin/password', isAuthenticated, async (req, res, next) => {
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    if (newPassword.length < 12) return res.status(400).json({ message: 'New password must be at least 12 characters.' });
    const currentUser = req.session.user;
    try {
      const account = await database.getAdminAccountById(currentUser.id);
      if (!account || !await bcrypt.compare(currentPassword, account.passwordHash)) {
        return res.status(401).json({ message: 'Current password is incorrect.' });
      }
      await database.changeAdminAccountPassword(currentUser.id, await bcrypt.hash(newPassword, 12), currentUser.username);
      return req.session.regenerate(error => {
        if (error) return next(error);
        req.session.isAuthenticated = true;
        req.session.user = currentUser;
        req.session.authenticatedAt = Date.now();
        req.session.lastActivityAt = req.session.authenticatedAt;
        return req.session.save(saveError => {
          if (saveError) return next(saveError);
          return sessionStore.destroyAdminSessions(currentUser.id, req.sessionID, revokeError => {
            if (revokeError) return next(revokeError);
            return res.json({ success: true, message: 'Password updated. Other sessions for your account have been logged out.' });
          });
        });
      });
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.post('/api/admin/sessions/revoke-all', isAuthenticated, (req, res, next) => {
    const adminId = req.session.user.id;
    return sessionStore.destroyAdminSessions(adminId, null, error => {
      if (error) return next(error);
      return req.session.destroy(destroyError => {
        if (destroyError) return next(destroyError);
        res.clearCookie('bbf.sid', { httpOnly: true, sameSite: 'lax', secure: isProduction });
        return res.json({ success: true, message: 'All sessions for your account have been logged out.' });
      });
    });
  });

  app.get('/api/admin/accounts', isAuthenticated, requireOwner, async (req, res, next) => {
    try {
      return res.json(await database.listAdminAccounts());
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/admin/accounts', isAuthenticated, requireOwner, async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const role = req.body.role;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(username)) {
      return res.status(400).json({ message: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens.' });
    }
    if (password.length < 12 || password.length > 1024) {
      return res.status(400).json({ message: 'Password must be at least 12 characters and no more than 1,024 characters.' });
    }
    if (!['owner', 'staff'].includes(role)) {
      return res.status(400).json({ message: 'Choose the owner or staff role.' });
    }
    try {
      const account = await database.createAdminAccount({
        id: crypto.randomUUID(),
        username,
        passwordHash: await bcrypt.hash(password, 12),
        role
      }, req.session.user.username);
      return res.status(201).json(mapAdminAccount(account));
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ message: 'That username is already in use.' });
      }
      return respondWithError(res, error);
    }
  });

  app.patch('/api/admin/accounts/:id', isAuthenticated, requireOwner, async (req, res, next) => {
    const { role, disabled } = req.body;
    if (role !== undefined && !['owner', 'staff'].includes(role)) {
      return res.status(400).json({ message: 'Choose the owner or staff role.' });
    }
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      return res.status(400).json({ message: 'Disabled must be true or false.' });
    }
    if (req.params.id === req.session.user.id && disabled === true) {
      return res.status(400).json({ message: 'You cannot disable the account currently in use.' });
    }
    try {
      const account = await database.updateAdminAccount(req.params.id, { role, disabled }, req.session.user.username);
      if (!account) return res.status(404).json({ message: 'Admin account not found.' });
      if (account.disabled) {
        return sessionStore.destroyAdminSessions(account.id, null, error => {
          if (error) return next(error);
          return res.json(mapAdminAccount(account));
        });
      }
      return res.json(mapAdminAccount(account));
    } catch (error) {
      if (error.message === 'At least one active owner account must remain.') {
        return res.status(409).json({ message: error.message });
      }
      return respondWithError(res, error);
    }
  });

  app.get('/api/admin/audit', isAuthenticated, requireOwner, async (req, res) => {
    try {
      return res.json(await database.listAudit(100));
    } catch (error) {
      return respondWithError(res, error);
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ message: 'API endpoint not found.' }));
  app.get('/BBFDesign.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'BBFDesign.css')));
  app.get('/BBFfunc.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'BBFfunc.js')));
  app.get('/BBFIndex.html', (req, res) => res.sendFile(path.join(__dirname, 'BBFIndex.html')));
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
  app.locals.initializeDatabase = initializeDatabase;
  Object.defineProperty(app.locals, 'databaseReady', { get: initializeDatabase });
  app.locals.sessionStore = sessionStore;
  return app;
}

const app = createApplication();
app.createApplication = createApplication;
app.calculateMembershipEndDate = calculateMembershipEndDate;
app.getTodayDateString = getTodayDateString;
app.isValidDateString = isValidDateString;

module.exports = app;

if (require.main === module) {
  try {
    const port = Number(process.env.PORT || 3000);
    app.locals.initializeDatabase().then(() => app.listen(port, () => {
      console.log(`Big Bozz Fitness is running on port ${port}.`);
    })).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
