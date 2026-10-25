const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const schema = [
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    membership_type TEXT NOT NULL CHECK (membership_type IN ('monthly', '6month')),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS members_end_date_idx ON members(end_date)',
  'CREATE INDEX IF NOT EXISTS members_phone_idx ON members(phone)',
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    plan TEXT NOT NULL,
    plan_key TEXT NOT NULL CHECK (plan_key IN ('walkin', 'monthly', '6month')),
    trainer INTEGER NOT NULL DEFAULT 0 CHECK (trainer IN (0, 1)),
    total INTEGER NOT NULL CHECK (total >= 0),
    status TEXT NOT NULL CHECK (status IN ('Unpaid', 'Paid', 'Cancelled')),
    date TEXT NOT NULL,
    member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    email TEXT,
    preferred_start_date TEXT,
    payment_method TEXT,
    payment_reference TEXT,
    amount_received REAL,
    paid_at TEXT,
    confirmed_by TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS orders_date_idx ON orders(date)',
  'CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status)',
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details_json TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS audit_created_at_idx ON audit_log(created_at)',
  `CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires)',
  `CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
    created_at TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    totp_secret TEXT,
    mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS admin_recovery_codes (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at TEXT,
    UNIQUE (admin_id, code_hash)
  )`,
  'CREATE INDEX IF NOT EXISTS admin_recovery_admin_idx ON admin_recovery_codes(admin_id, used_at)'
];

function plainRow(row) {
  return row ? { ...row } : null;
}

async function one(executor, sql, args = []) {
  const result = await executor.execute({ sql, args });
  return plainRow(result.rows[0]);
}

async function all(executor, sql, args = []) {
  const result = await executor.execute({ sql, args });
  return result.rows.map(row => ({ ...row }));
}

async function run(executor, sql, args = []) {
  return executor.execute({ sql, args });
}

function createDatabase(options = {}) {
  const client = options.client || createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN
  });
  let initialization;

  function initialize() {
    if (!initialization) {
      initialization = (async () => {
        await client.execute('PRAGMA foreign_keys = ON');
        await client.batch(schema.map(sql => ({ sql, args: [] })), 'write');
      })();
    }
    return initialization;
  }

  async function recordAudit(actor, action, entityType, entityId, details, executor = client) {
    return run(executor, `INSERT INTO audit_log
      (created_at, actor, action, entity_type, entity_id, details_json)
      VALUES (?, ?, ?, ?, ?, ?)`, [
      new Date().toISOString(),
      actor,
      action,
      entityType,
      String(entityId),
      JSON.stringify(details)
    ]);
  }

  async function selectMember(executor, id) {
    return one(executor, 'SELECT * FROM members WHERE id = ?', [id]);
  }

  async function selectOrder(executor, id) {
    return one(executor, 'SELECT * FROM orders WHERE id = ?', [id]);
  }

  async function selectAdmin(executor, id) {
    return one(executor, `SELECT id, username, password_hash AS passwordHash, role,
      created_at AS createdAt, disabled, totp_secret AS totpSecret, mfa_enabled AS mfaEnabled
      FROM admin_accounts WHERE id = ?`, [id]);
  }

  async function withWriteTransaction(work) {
    await initialize();
    const transaction = await client.transaction('write');
    try {
      const result = await work(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    } finally {
      await transaction.close();
    }
  }

  async function removeAdminSessions(adminId, keepSid = null) {
    await initialize();
    return withWriteTransaction(async transaction => {
      const sessions = await all(transaction, 'SELECT sid, sess FROM sessions');
      for (const stored of sessions) {
        const storedSession = JSON.parse(stored.sess);
        if (storedSession.user && storedSession.user.id === adminId && stored.sid !== keepSid) {
          await run(transaction, 'DELETE FROM sessions WHERE sid = ?', [stored.sid]);
        }
      }
    });
  }

  return {
    initialize,
    async createMember(member, actor) {
      return withWriteTransaction(async transaction => {
        const now = new Date().toISOString();
        await run(transaction, `INSERT INTO members
          (id, name, phone, membership_type, start_date, end_date, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
          member.id, member.name, member.phone, member.membershipType, member.startDate,
          member.endDate, now, now
        ]);
        const inserted = await selectMember(transaction, member.id);
        await recordAudit(actor, 'member_created', 'member', member.id, { after: memberSnapshot(inserted) }, transaction);
        return inserted;
      });
    },
    async listMembers() {
      await initialize();
      return all(client, 'SELECT * FROM members ORDER BY created_at DESC, rowid DESC');
    },
    async resetDashboardRecords(actor) {
      return withWriteTransaction(async transaction => {
        const orderCount = await one(transaction, 'SELECT COUNT(*) AS count FROM orders');
        const memberCount = await one(transaction, 'SELECT COUNT(*) AS count FROM members');
        const ordersDeleted = Number(orderCount.count);
        const membersDeleted = Number(memberCount.count);
        await run(transaction, 'DELETE FROM orders');
        await run(transaction, 'DELETE FROM members');
        await recordAudit(actor, 'dashboard_records_reset', 'dashboard', 'records', {
          ordersDeleted,
          membersDeleted
        }, transaction);
        return { ordersDeleted, membersDeleted };
      });
    },
    async publicOverview(today) {
      await initialize();
      const [revenue, active, walkins, trainers] = await Promise.all([
        one(client, "SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status = 'Paid'"),
        one(client, 'SELECT COUNT(*) AS count FROM members WHERE end_date >= ?', [today]),
        one(client, "SELECT COUNT(*) AS count FROM orders WHERE plan_key = 'walkin' AND status = 'Paid' AND date = ?", [today]),
        one(client, 'SELECT COUNT(*) AS count FROM orders WHERE trainer = 1 AND status = \'Paid\'')
      ]);
      return {
        totalRevenue: Number(revenue.total),
        activeMembers: Number(active.count),
        walkinsToday: Number(walkins.count),
        trainerCount: Number(trainers.count)
      };
    },
    async createOrder(order) {
      return withWriteTransaction(async transaction => {
        const now = new Date().toISOString();
        const inserted = await run(transaction, `INSERT INTO orders (
          receipt_id, name, phone, plan, plan_key, trainer, total, status, date, created_at, email, preferred_start_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Unpaid', ?, ?, ?, ?)`, [
          order.receiptId, order.name, order.phone, order.plan, order.planKey, order.trainer ? 1 : 0,
          order.total, order.date, now, order.email || null, order.preferredStartDate || null
        ]);
        const row = await selectOrder(transaction, Number(inserted.lastInsertRowid));
        await recordAudit('public', 'registration_received', 'order', row.id, {
          receiptId: row.receipt_id,
          plan: row.plan_key,
          status: row.status
        }, transaction);
        return row;
      });
    },
    async updateMember(id, changes, actor) {
      return withWriteTransaction(async transaction => {
        const before = await selectMember(transaction, id);
        if (!before) return null;
        await run(transaction, `UPDATE members SET name = ?, phone = ?, membership_type = ?,
          start_date = ?, end_date = ?, updated_at = ? WHERE id = ?`, [
          changes.name, changes.phone, changes.membershipType, changes.startDate, changes.endDate,
          new Date().toISOString(), id
        ]);
        const after = await selectMember(transaction, id);
        await recordAudit(actor, 'member_updated', 'member', id, {
          before: memberSnapshot(before),
          after: memberSnapshot(after)
        }, transaction);
        return after;
      });
    },
    async renewMember(id, today, calculateEndDate, addDate, actor) {
      return withWriteTransaction(async transaction => {
        const before = await selectMember(transaction, id);
        if (!before) return null;
        const startDate = before.end_date >= today ? addDate(before.end_date, 1) : today;
        const endDate = calculateEndDate(startDate, before.membership_type);
        await run(transaction, `UPDATE members SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?`, [
          startDate, endDate, new Date().toISOString(), id
        ]);
        const after = await selectMember(transaction, id);
        await recordAudit(actor, 'member_renewed', 'member', id, {
          before: memberSnapshot(before),
          after: memberSnapshot(after)
        }, transaction);
        return after;
      });
    },
    async deleteMember(id, actor) {
      return withWriteTransaction(async transaction => {
        const before = await selectMember(transaction, id);
        if (!before) return false;
        await run(transaction, 'DELETE FROM members WHERE id = ?', [id]);
        await recordAudit(actor, 'member_deleted', 'member', id, { before: memberSnapshot(before) }, transaction);
        return true;
      });
    },
    async listOrders(filters = {}) {
      await initialize();
      const conditions = [];
      const values = [];
      if (filters.status && filters.status !== 'All') {
        conditions.push('status = ?');
        values.push(filters.status);
      }
      if (filters.query) {
        conditions.push('(lower(name) LIKE lower(?) OR lower(phone) LIKE lower(?) OR lower(receipt_id) LIKE lower(?))');
        const query = `%${filters.query}%`;
        values.push(query, query, query);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const total = await one(client, `SELECT COUNT(*) AS count FROM orders ${where}`, values);
      const limit = Number.isInteger(filters.limit) ? filters.limit : 10000;
      const offset = Number.isInteger(filters.offset) ? filters.offset : 0;
      const orders = await all(client, `SELECT * FROM orders ${where}
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...values, limit, offset]);
      const pending = await one(client, "SELECT COUNT(*) AS count FROM orders WHERE status = 'Unpaid'");
      return { orders, total: Number(total.count), pendingCount: Number(pending.count) };
    },
    async getOrder(id) {
      await initialize();
      return selectOrder(client, id);
    },
    async confirmPayment(id, today, calculateEndDate, addDate, actor, payment) {
      return withWriteTransaction(async transaction => {
        const order = await selectOrder(transaction, id);
        if (!order) return null;
        if (order.status === 'Paid') return order;
        if (order.status === 'Cancelled') {
          const error = new Error('Cancelled orders cannot be paid.');
          error.code = 'ORDER_CANCELLED';
          throw error;
        }

        let memberId = null;
        let memberBefore = null;
        const preferredStartDate = order.preferred_start_date && order.preferred_start_date >= today
          ? order.preferred_start_date
          : today;
        if (order.plan_key !== 'walkin') {
          const existing = await one(transaction, `SELECT * FROM members
            WHERE phone = ? AND lower(name) = lower(?) ORDER BY updated_at DESC LIMIT 1`, [
            order.phone, order.name.trim()
          ]);
          if (existing) {
            memberId = existing.id;
            memberBefore = memberSnapshot(existing);
            const startDate = existing.end_date >= today ? addDate(existing.end_date, 1) : preferredStartDate;
            const endDate = calculateEndDate(startDate, order.plan_key);
            await run(transaction, `UPDATE members SET name = ?, phone = ?, membership_type = ?,
              start_date = ?, end_date = ?, updated_at = ? WHERE id = ?`, [
              order.name, order.phone, order.plan_key, startDate, endDate, new Date().toISOString(), memberId
            ]);
            const updatedMember = await selectMember(transaction, memberId);
            await recordAudit(actor, 'membership_extended_by_payment', 'member', memberId, {
              before: memberBefore,
              after: memberSnapshot(updatedMember),
              orderId: order.id
            }, transaction);
          } else {
            memberId = crypto.randomUUID();
            const startDate = preferredStartDate;
            const endDate = calculateEndDate(startDate, order.plan_key);
            const now = new Date().toISOString();
            await run(transaction, `INSERT INTO members
              (id, name, phone, membership_type, start_date, end_date, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
              memberId, order.name, order.phone, order.plan_key, startDate, endDate, now, now
            ]);
            const createdMember = await selectMember(transaction, memberId);
            await recordAudit(actor, 'membership_created_by_payment', 'member', memberId, {
              after: memberSnapshot(createdMember),
              orderId: order.id
            }, transaction);
          }
        }

        const paidAt = new Date().toISOString();
        await run(transaction, `UPDATE orders SET status = 'Paid', member_id = ?, payment_method = ?,
          payment_reference = ?, amount_received = ?, paid_at = ?, confirmed_by = ? WHERE id = ?`, [
          memberId,
          payment.paymentMethod,
          payment.paymentReference || null,
          payment.amountReceived,
          paidAt,
          actor,
          id
        ]);
        const paidOrder = await selectOrder(transaction, id);
        await recordAudit(actor, 'payment_confirmed', 'order', id, {
          receiptId: order.receipt_id,
          expectedAmount: order.total,
          paymentMethod: payment.paymentMethod,
          paymentReference: payment.paymentReference || null,
          amountReceived: payment.amountReceived,
          allowMismatch: payment.allowMismatch === true,
          paidAt,
          confirmedBy: actor,
          memberId
        }, transaction);
        return paidOrder;
      });
    },
    async cancelOrder(id, actor) {
      return withWriteTransaction(async transaction => {
        const before = await selectOrder(transaction, id);
        if (!before) return { result: 'missing' };
        if (before.status !== 'Unpaid') return { result: 'not_unpaid', order: before };
        await run(transaction, "UPDATE orders SET status = 'Cancelled' WHERE id = ? AND status = 'Unpaid'", [id]);
        const after = await selectOrder(transaction, id);
        await recordAudit(actor, 'order_cancelled', 'order', id, {
          receiptId: before.receipt_id,
          previousStatus: before.status,
          status: after.status
        }, transaction);
        return { result: 'cancelled', order: after };
      });
    },
    async seedAdminPasswordHash(passwordHash) {
      await initialize();
      await run(client, `INSERT OR IGNORE INTO admin_settings (key, value, updated_at)
        VALUES ('password_hash', ?, ?)`, [passwordHash, new Date().toISOString()]);
      const stored = await one(client, "SELECT value FROM admin_settings WHERE key = 'password_hash'");
      return stored ? stored.value : null;
    },
    async getAdminPasswordHash() {
      await initialize();
      const row = await one(client, "SELECT value FROM admin_settings WHERE key = 'password_hash'");
      return row ? row.value : null;
    },
    async changeAdminPasswordHash(passwordHash, actor) {
      return withWriteTransaction(async transaction => {
        await run(transaction, "UPDATE admin_settings SET value = ?, updated_at = ? WHERE key = 'password_hash'", [
          passwordHash, new Date().toISOString()
        ]);
        await recordAudit(actor, 'admin_password_changed', 'admin_settings', 'password_hash', {
          changedAt: new Date().toISOString()
        }, transaction);
      });
    },
    async createFirstAdmin({ id, username, passwordHash }) {
      return withWriteTransaction(async transaction => {
        const count = await one(transaction, 'SELECT COUNT(*) AS count FROM admin_accounts');
        if (Number(count.count)) throw new Error('An admin account already exists.');
        const legacyHash = await one(transaction, "SELECT value FROM admin_settings WHERE key = 'password_hash'");
        const initialPasswordHash = legacyHash ? legacyHash.value : passwordHash;
        if (!initialPasswordHash) throw new Error('No legacy admin password hash is available to migrate.');
        const createdAt = new Date().toISOString();
        await run(transaction, `INSERT INTO admin_accounts (id, username, password_hash, role, created_at)
          VALUES (?, ?, ?, 'owner', ?)`, [id, username, initialPasswordHash, createdAt]);
        await run(transaction, "DELETE FROM admin_settings WHERE key = 'password_hash'");
        await recordAudit('system', 'legacy_admin_migrated', 'admin_account', id, {
          username,
          source: legacyHash ? 'legacy_password_hash' : 'bootstrap'
        }, transaction);
        return selectAdmin(transaction, id);
      });
    },
    async adminAccountCount() {
      await initialize();
      const result = await one(client, 'SELECT COUNT(*) AS count FROM admin_accounts');
      return Number(result.count);
    },
    async getAdminAccountById(id) {
      await initialize();
      return selectAdmin(client, id);
    },
    async getAdminAccountByUsername(username) {
      await initialize();
      return one(client, `SELECT id, username, password_hash AS passwordHash, role,
        created_at AS createdAt, disabled, totp_secret AS totpSecret, mfa_enabled AS mfaEnabled
        FROM admin_accounts WHERE username = ? COLLATE NOCASE`, [username]);
    },
    async listAdminAccounts() {
      await initialize();
      const accounts = await all(client, `SELECT id, username, role, created_at AS createdAt,
        disabled, mfa_enabled AS mfaEnabled FROM admin_accounts ORDER BY created_at, username`);
      return accounts.map(account => ({
        ...account,
        disabled: Boolean(account.disabled),
        mfaEnabled: Boolean(account.mfaEnabled)
      }));
    },
    async createAdminAccount({ id, username, passwordHash, role }, actor) {
      return withWriteTransaction(async transaction => {
        const createdAt = new Date().toISOString();
        await run(transaction, `INSERT INTO admin_accounts
          (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`, [
          id, username, passwordHash, role, createdAt
        ]);
        await recordAudit(actor, 'admin_account_created', 'admin_account', id, { username, role }, transaction);
        return selectAdmin(transaction, id);
      });
    },
    async updateAdminAccount(id, { role, disabled }, actor) {
      return withWriteTransaction(async transaction => {
        const current = await selectAdmin(transaction, id);
        if (!current) return null;
        const nextRole = role === undefined ? current.role : role;
        const nextDisabled = disabled === undefined ? Number(current.disabled) : Number(disabled);
        if (current.role === 'owner' && !current.disabled && (nextRole !== 'owner' || nextDisabled)) {
          const activeOwners = await one(transaction, `
            SELECT COUNT(*) AS count FROM admin_accounts WHERE role = 'owner' AND disabled = 0
          `);
          if (Number(activeOwners.count) <= 1) {
            throw new Error('At least one active owner account must remain.');
          }
        }
        await run(transaction, 'UPDATE admin_accounts SET role = ?, disabled = ? WHERE id = ?', [
          nextRole, nextDisabled, id
        ]);
        await recordAudit(actor, 'admin_account_updated', 'admin_account', id, {
          username: current.username,
          role: nextRole,
          disabled: Boolean(nextDisabled)
        }, transaction);
        const updated = await selectAdmin(transaction, id);
        return { ...updated, disabled: Boolean(updated.disabled), mfaEnabled: Boolean(updated.mfaEnabled) };
      });
    },
    async changeAdminAccountPassword(id, passwordHash, actor) {
      return withWriteTransaction(async transaction => {
        const current = await selectAdmin(transaction, id);
        if (!current) return false;
        await run(transaction, 'UPDATE admin_accounts SET password_hash = ? WHERE id = ?', [passwordHash, id]);
        await recordAudit(actor, 'admin_password_changed', 'admin_account', id, {
          changedAt: new Date().toISOString()
        }, transaction);
        return true;
      });
    },
    async enableAdminMfa(id, encryptedSecret, recoveryCodes, actor) {
      return withWriteTransaction(async transaction => {
        const account = await selectAdmin(transaction, id);
        if (!account || account.disabled) return false;
        await run(transaction, 'UPDATE admin_accounts SET totp_secret = ?, mfa_enabled = 1 WHERE id = ?', [
          encryptedSecret, id
        ]);
        await run(transaction, 'DELETE FROM admin_recovery_codes WHERE admin_id = ?', [id]);
        const now = new Date().toISOString();
        for (const code of recoveryCodes) {
          await run(transaction, `INSERT INTO admin_recovery_codes
            (id, admin_id, code_hash, created_at) VALUES (?, ?, ?, ?)`, [
            crypto.randomUUID(), id, code.hash, now
          ]);
        }
        await recordAudit(actor, 'admin_mfa_enabled', 'admin_account', id, {
          recoveryCodeCount: recoveryCodes.length
        }, transaction);
        return true;
      });
    },
    async consumeAdminRecoveryCode(id, codeHash) {
      await initialize();
      const result = await run(client, `UPDATE admin_recovery_codes SET used_at = ?
        WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL`, [
        new Date().toISOString(), id, codeHash
      ]);
      return result.rowsAffected === 1;
    },
    async recordFailedLogin(actor) {
      await initialize();
      await recordAudit(actor || 'anonymous', 'failed_login', 'admin', 'login', {
        attemptedAt: new Date().toISOString()
      });
    },
    async listAudit(limit) {
      await initialize();
      const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const rows = await all(client, `SELECT id, created_at AS createdAt, actor, action,
        entity_type AS entityType, entity_id AS entityId, details_json AS details
        FROM audit_log ORDER BY id DESC LIMIT ?`, [boundedLimit]);
      return rows.map(row => ({ ...row, details: JSON.parse(row.details) }));
    },
    async recordAudit(actor, action, entityType, entityId, details) {
      await initialize();
      return recordAudit(actor, action, entityType, entityId, details);
    },
    async stats(today) {
      return this.publicOverview(today);
    },
    async importLegacyMembers(members, actor, calculateEndDate) {
      return withWriteTransaction(async transaction => {
        const imported = [];
        let skippedCount = 0;
        for (const member of members) {
          const endDate = calculateEndDate(member.startDate, member.membershipType);
          const duplicate = await one(transaction, `SELECT id FROM members
            WHERE lower(trim(name)) = lower(trim(?))
              AND COALESCE(phone, '') = COALESCE(?, '')
              AND membership_type = ? AND start_date = ? AND end_date = ? LIMIT 1`, [
            member.name, member.phone, member.membershipType, member.startDate, endDate
          ]);
          if (duplicate) {
            skippedCount += 1;
            continue;
          }
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          await run(transaction, `INSERT INTO members
            (id, name, phone, membership_type, start_date, end_date, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            id, member.name, member.phone, member.membershipType, member.startDate, endDate, now, now
          ]);
          const stored = await selectMember(transaction, id);
          await recordAudit(actor, 'legacy_member_imported', 'member', id, {
            after: memberSnapshot(stored)
          }, transaction);
          imported.push(stored);
        }
        if (imported.length) {
          await recordAudit(actor, 'legacy_members_imported', 'member', 'legacy-import', {
            importedCount: imported.length,
            skippedCount
          }, transaction);
        }
        const allMembers = await all(transaction, 'SELECT * FROM members ORDER BY created_at DESC, rowid DESC');
        return { members: allMembers, importedCount: imported.length, skippedCount };
      });
    },
    createSessionStore(sessionLibrary) {
      const store = new sessionLibrary.Store();
      store.get = (sid, callback) => {
        (async () => {
          await initialize();
          const stored = await one(client, 'SELECT sess, expires FROM sessions WHERE sid = ?', [sid]);
          if (!stored) return null;
          if (Number(stored.expires) <= Date.now()) {
            await run(client, 'DELETE FROM sessions WHERE sid = ?', [sid]);
            return null;
          }
          return JSON.parse(stored.sess);
        })().then(value => callback(null, value), callback);
      };
      store.set = (sid, sess, callback = () => {}) => {
        (async () => {
          await initialize();
          const expiration = sess.cookie && sess.cookie.expires
            ? new Date(sess.cookie.expires).getTime()
            : Date.now() + (sess.cookie && sess.cookie.originalMaxAge || 0);
          await run(client, `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`, [
            sid, JSON.stringify(sess), expiration
          ]);
          if (Math.random() < 0.02) await run(client, 'DELETE FROM sessions WHERE expires <= ?', [Date.now()]);
        })().then(() => callback(null), callback);
      };
      store.touch = (sid, sess, callback = () => {}) => {
        (async () => {
          await initialize();
          const expiration = sess.cookie && sess.cookie.expires
            ? new Date(sess.cookie.expires).getTime()
            : Date.now() + (sess.cookie && sess.cookie.originalMaxAge || 0);
          await run(client, 'UPDATE sessions SET expires = ? WHERE sid = ?', [expiration, sid]);
        })().then(() => callback(null), callback);
      };
      store.destroy = (sid, callback = () => {}) => {
        (async () => {
          await initialize();
          await run(client, 'DELETE FROM sessions WHERE sid = ?', [sid]);
        })().then(() => callback(null), callback);
      };
      store.destroyAllExcept = (sid, callback = () => {}) => {
        (async () => {
          await initialize();
          await run(client, 'DELETE FROM sessions WHERE sid != ?', [sid]);
        })().then(() => callback(null), callback);
      };
      store.destroyAll = (callback = () => {}) => {
        (async () => {
          await initialize();
          await run(client, 'DELETE FROM sessions');
        })().then(() => callback(null), callback);
      };
      store.destroyAdminSessions = (adminId, keepSid = null, callback = () => {}) => {
        removeAdminSessions(adminId, keepSid).then(() => callback(null), callback);
      };
      store.clearExpired = async () => {
        await initialize();
        return run(client, 'DELETE FROM sessions WHERE expires <= ?', [Date.now()]);
      };
      store.close = () => {};
      return store;
    },
    async close() {
      return client.close();
    }
  };
}

function memberSnapshot(member) {
  return member ? {
    id: member.id,
    name: member.name,
    phone: member.phone || '',
    membershipType: member.membership_type,
    startDate: member.start_date,
    endDate: member.end_date
  } : null;
}

module.exports = { createDatabase };
