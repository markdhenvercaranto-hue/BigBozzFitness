const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

function migrateOrders(connection) {
  const migration = connection.transaction(() => {
    const columns = new Set(connection.pragma('table_info(orders)').map(column => column.name));
    const additions = [
      ['email', 'TEXT'],
      ['preferred_start_date', 'TEXT'],
      ['payment_method', 'TEXT'],
      ['payment_reference', 'TEXT'],
      ['amount_received', 'REAL'],
      ['paid_at', 'TEXT'],
      ['confirmed_by', 'TEXT']
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) connection.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
    }

    const table = connection.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();
    if (!table || !table.sql.includes("'Cancelled'")) {
      const orderIndexes = connection.prepare(`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orders' AND sql IS NOT NULL
      `).all();
      connection.exec(`
        ALTER TABLE orders RENAME TO orders_before_cancelled_migration;
        CREATE TABLE orders_migration_new (
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
        );
        INSERT INTO orders_migration_new (
          id, receipt_id, name, phone, plan, plan_key, trainer, total, status, date, member_id, created_at,
          email, preferred_start_date, payment_method, payment_reference, amount_received, paid_at, confirmed_by
        )
        SELECT
          id, receipt_id, name, phone, plan, plan_key, trainer, total, status, date, member_id, created_at,
          email, preferred_start_date, payment_method, payment_reference, amount_received, paid_at, confirmed_by
        FROM orders_before_cancelled_migration;
        DROP TABLE orders_before_cancelled_migration;
        ALTER TABLE orders_migration_new RENAME TO orders;
        CREATE INDEX orders_date_idx ON orders(date);
        CREATE INDEX orders_status_idx ON orders(status);
      `);
      for (const index of orderIndexes) {
        if (!['orders_date_idx', 'orders_status_idx'].includes(index.name)) {
          connection.exec(index.sql);
        }
      }
    }
  });
  migration();
}

function createDatabase(dataDirectory) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const connection = new Database(path.join(dataDirectory, 'bigbozz.sqlite'));
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      membership_type TEXT NOT NULL CHECK (membership_type IN ('monthly', '6month')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS members_end_date_idx ON members(end_date);
    CREATE INDEX IF NOT EXISTS members_phone_idx ON members(phone);

    CREATE TABLE IF NOT EXISTS orders (
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
    );
    CREATE INDEX IF NOT EXISTS orders_date_idx ON orders(date);
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_created_at_idx ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  migrateOrders(connection);

  const statements = {
    insertMember: connection.prepare(`
      INSERT INTO members (id, name, phone, membership_type, start_date, end_date, created_at, updated_at)
      VALUES (@id, @name, @phone, @membershipType, @startDate, @endDate, @now, @now)
    `),
    selectMember: connection.prepare('SELECT * FROM members WHERE id = ?'),
    listMembers: connection.prepare('SELECT * FROM members ORDER BY created_at DESC, rowid DESC'),
    updateMember: connection.prepare(`
      UPDATE members SET name = @name, phone = @phone, membership_type = @membershipType,
        start_date = @startDate, end_date = @endDate, updated_at = @now
      WHERE id = @id
    `),
    insertAudit: connection.prepare(`
      INSERT INTO audit_log (created_at, actor, action, entity_type, entity_id, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertOrder: connection.prepare(`
      INSERT INTO orders (
        receipt_id, name, phone, plan, plan_key, trainer, total, status, date, created_at, email, preferred_start_date
      ) VALUES (
        @receiptId, @name, @phone, @plan, @planKey, @trainer, @total, 'Unpaid', @date, @createdAt, @email, @preferredStartDate
      )
    `),
    selectOrder: connection.prepare('SELECT * FROM orders WHERE id = ?'),
    listOrders: connection.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC'),
    countPendingOrders: connection.prepare("SELECT COUNT(*) AS count FROM orders WHERE status = 'Unpaid'"),
    updateOrderPayment: connection.prepare(`
      UPDATE orders SET status = 'Paid', member_id = ?, payment_method = ?, payment_reference = ?,
        amount_received = ?, paid_at = ?, confirmed_by = ? WHERE id = ?
    `),
    cancelOrder: connection.prepare("UPDATE orders SET status = 'Cancelled' WHERE id = ? AND status = 'Unpaid'"),
    getAdminPasswordHash: connection.prepare("SELECT value FROM admin_settings WHERE key = 'password_hash'"),
    insertAdminPasswordHash: connection.prepare(`
      INSERT OR IGNORE INTO admin_settings (key, value, updated_at) VALUES ('password_hash', ?, ?)
    `),
    updateAdminPasswordHash: connection.prepare(`
      UPDATE admin_settings SET value = ?, updated_at = ? WHERE key = 'password_hash'
    `),
    listAudit: connection.prepare(`
      SELECT id, created_at AS createdAt, actor, action, entity_type AS entityType,
        entity_id AS entityId, details_json AS details
      FROM audit_log ORDER BY id DESC LIMIT ?
    `),
    paidRevenue: connection.prepare("SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status = 'Paid'"),
    walkinsToday: connection.prepare("SELECT COUNT(*) AS count FROM orders WHERE plan_key = 'walkin' AND status = 'Paid' AND date = ?"),
    trainerCount: connection.prepare("SELECT COUNT(*) AS count FROM orders WHERE trainer = 1 AND status = 'Paid'"),
    activeCount: connection.prepare('SELECT COUNT(*) AS count FROM members WHERE end_date >= ?'),
    findMemberByIdentity: connection.prepare(`
      SELECT * FROM members WHERE phone = ? AND lower(name) = lower(?) ORDER BY updated_at DESC LIMIT 1
    `),
    findLegacyDuplicate: connection.prepare(`
      SELECT id FROM members
      WHERE lower(trim(name)) = lower(trim(?))
        AND COALESCE(phone, '') = COALESCE(?, '')
        AND membership_type = ? AND start_date = ? AND end_date = ?
      LIMIT 1
    `),
    deleteMember: connection.prepare('DELETE FROM members WHERE id = ?'),
    deleteExpiredSessions: connection.prepare('DELETE FROM sessions WHERE expires <= ?')
  };
  let sessionCleanupTimer;

  function recordAudit(actor, action, entityType, entityId, details) {
    statements.insertAudit.run(new Date().toISOString(), actor, action, entityType, String(entityId), JSON.stringify(details));
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

  function createMember(member, actor) {
    const now = new Date().toISOString();
    const record = { ...member, now };
    const transaction = connection.transaction(() => {
      statements.insertMember.run(record);
      const inserted = statements.selectMember.get(member.id);
      recordAudit(actor, 'member_created', 'member', member.id, { after: memberSnapshot(inserted) });
      return inserted;
    });
    return transaction();
  }

  return {
    createMember,
    listMembers: () => statements.listMembers.all(),
    createOrder(order) {
      const now = new Date().toISOString();
      const transaction = connection.transaction(() => {
        const result = statements.insertOrder.run({
          ...order,
          email: order.email || null,
          preferredStartDate: order.preferredStartDate || null,
          trainer: order.trainer ? 1 : 0,
          createdAt: now
        });
        const inserted = statements.selectOrder.get(result.lastInsertRowid);
        recordAudit('public', 'registration_received', 'order', inserted.id, {
          receiptId: inserted.receipt_id,
          plan: inserted.plan_key,
          status: inserted.status
        });
        return inserted;
      });
      return transaction();
    },
    updateMember(id, changes, actor) {
      const transaction = connection.transaction(() => {
        const before = statements.selectMember.get(id);
        if (!before) return null;
        statements.updateMember.run({ ...changes, id, now: new Date().toISOString() });
        const after = statements.selectMember.get(id);
        recordAudit(actor, 'member_updated', 'member', id, {
          before: memberSnapshot(before),
          after: memberSnapshot(after)
        });
        return after;
      });
      return transaction();
    },
    renewMember(id, today, calculateEndDate, addDate, actor) {
      const transaction = connection.transaction(() => {
        const before = statements.selectMember.get(id);
        if (!before) return null;
        const startDate = before.end_date >= today ? addDate(before.end_date, 1) : today;
        statements.updateMember.run({
          id,
          name: before.name,
          phone: before.phone,
          membershipType: before.membership_type,
          startDate,
          endDate: calculateEndDate(startDate, before.membership_type),
          now: new Date().toISOString()
        });
        const after = statements.selectMember.get(id);
        recordAudit(actor, 'member_renewed', 'member', id, {
          before: memberSnapshot(before),
          after: memberSnapshot(after)
        });
        return after;
      });
      return transaction();
    },
    deleteMember(id, actor) {
      const transaction = connection.transaction(() => {
        const before = statements.selectMember.get(id);
        if (!before) return false;
        statements.deleteMember.run(id);
        recordAudit(actor, 'member_deleted', 'member', id, { before: memberSnapshot(before) });
        return true;
      });
      return transaction();
    },
    listOrders(filters = {}) {
      const conditions = [];
      const values = [];
      if (filters.status && filters.status !== 'All') {
        conditions.push('status = ?');
        values.push(filters.status);
      }
      if (filters.query) {
        conditions.push("(lower(name) LIKE lower(?) OR lower(phone) LIKE lower(?) OR lower(receipt_id) LIKE lower(?))");
        const query = `%${filters.query}%`;
        values.push(query, query, query);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const total = connection.prepare(`SELECT COUNT(*) AS count FROM orders ${where}`).get(...values).count;
      const limit = Number.isInteger(filters.limit) ? filters.limit : 10000;
      const offset = Number.isInteger(filters.offset) ? filters.offset : 0;
      const orders = connection.prepare(`
        SELECT * FROM orders ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
      `).all(...values, limit, offset);
      return { orders, total, pendingCount: statements.countPendingOrders.get().count };
    },
    getOrder: id => statements.selectOrder.get(id),
    confirmPayment(id, today, calculateEndDate, addDate, actor, payment) {
      const transaction = connection.transaction(() => {
        const order = statements.selectOrder.get(id);
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
          const existing = statements.findMemberByIdentity.get(order.phone, order.name.trim());
          if (existing) {
            memberId = existing.id;
            memberBefore = memberSnapshot(existing);
            const startDate = existing.end_date >= today ? addDate(existing.end_date, 1) : preferredStartDate;
            statements.updateMember.run({
              id: memberId,
              name: order.name,
              phone: order.phone,
              membershipType: order.plan_key,
              startDate,
              endDate: calculateEndDate(startDate, order.plan_key),
              now: new Date().toISOString()
            });
            const updatedMember = statements.selectMember.get(memberId);
            recordAudit(actor, 'membership_extended_by_payment', 'member', memberId, {
              before: memberBefore,
              after: memberSnapshot(updatedMember),
              orderId: order.id
            });
          } else {
            memberId = crypto.randomUUID();
            const startDate = preferredStartDate;
            statements.insertMember.run({
              id: memberId,
              name: order.name,
              phone: order.phone,
              membershipType: order.plan_key,
              startDate,
              endDate: calculateEndDate(startDate, order.plan_key),
              now: new Date().toISOString()
            });
            const createdMember = statements.selectMember.get(memberId);
            recordAudit(actor, 'membership_created_by_payment', 'member', memberId, {
              after: memberSnapshot(createdMember),
              orderId: order.id
            });
          }
        }

        const paidAt = new Date().toISOString();
        statements.updateOrderPayment.run(
          memberId,
          payment.paymentMethod,
          payment.paymentReference || null,
          payment.amountReceived,
          paidAt,
          actor,
          id
        );
        const paidOrder = statements.selectOrder.get(id);
        recordAudit(actor, 'payment_confirmed', 'order', id, {
          receiptId: order.receipt_id,
          expectedAmount: order.total,
          paymentMethod: payment.paymentMethod,
          paymentReference: payment.paymentReference || null,
          amountReceived: payment.amountReceived,
          allowMismatch: payment.allowMismatch === true,
          paidAt,
          confirmedBy: actor,
          memberId
        });
        return paidOrder;
      });
      return transaction();
    },
    cancelOrder(id, actor) {
      const transaction = connection.transaction(() => {
        const before = statements.selectOrder.get(id);
        if (!before) return { result: 'missing' };
        if (before.status !== 'Unpaid') return { result: 'not_unpaid', order: before };
        statements.cancelOrder.run(id);
        const after = statements.selectOrder.get(id);
        recordAudit(actor, 'order_cancelled', 'order', id, {
          receiptId: before.receipt_id,
          previousStatus: before.status,
          status: after.status
        });
        return { result: 'cancelled', order: after };
      });
      return transaction();
    },
    seedAdminPasswordHash(passwordHash) {
      const transaction = connection.transaction(() => {
        const result = statements.insertAdminPasswordHash.run(passwordHash, new Date().toISOString());
        if (result.changes) {
          recordAudit('system', 'admin_password_seeded', 'admin_settings', 'password_hash', {
            source: 'ADMIN_PASSWORD'
          });
        }
        return statements.getAdminPasswordHash.get().value;
      });
      return transaction();
    },
    getAdminPasswordHash() {
      const row = statements.getAdminPasswordHash.get();
      return row ? row.value : null;
    },
    changeAdminPasswordHash(passwordHash, actor) {
      const transaction = connection.transaction(() => {
        statements.updateAdminPasswordHash.run(passwordHash, new Date().toISOString());
        recordAudit(actor, 'admin_password_changed', 'admin_settings', 'password_hash', {
          changedAt: new Date().toISOString()
        });
      });
      transaction();
    },
    recordFailedLogin(actor) {
      recordAudit(actor || 'anonymous', 'failed_login', 'admin', 'login', {
        attemptedAt: new Date().toISOString()
      });
    },
    listAudit(limit) {
      return statements.listAudit.all(Math.min(Math.max(Number(limit) || 100, 1), 500))
        .map(row => ({ ...row, details: JSON.parse(row.details) }));
    },
    recordAudit,
    stats(today) {
      return {
        totalRevenue: statements.paidRevenue.get().total,
        activeMembers: statements.activeCount.get(today).count,
        walkinsToday: statements.walkinsToday.get(today).count,
        trainerCount: statements.trainerCount.get().count
      };
    },
    importLegacyMembers(members, actor, calculateEndDate) {
      const transaction = connection.transaction(() => {
        const imported = [];
        let skippedCount = 0;
        for (const member of members) {
          const endDate = calculateEndDate(member.startDate, member.membershipType);
          if (statements.findLegacyDuplicate.get(
            member.name, member.phone, member.membershipType, member.startDate, endDate
          )) {
            skippedCount += 1;
            continue;
          }
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          statements.insertMember.run({
            ...member,
            id,
            endDate,
            now
          });
          const stored = statements.selectMember.get(id);
          recordAudit(actor, 'legacy_member_imported', 'member', id, { after: memberSnapshot(stored) });
          imported.push(stored);
        }
        if (imported.length) {
          recordAudit(actor, 'legacy_members_imported', 'member', 'legacy-import', {
            importedCount: imported.length,
            skippedCount
          });
        }
        return { members: statements.listMembers.all(), importedCount: imported.length, skippedCount };
      });
      return transaction();
    },
    createSessionStore(sessionLibrary) {
      const store = new sessionLibrary.Store();
      sessionCleanupTimer = setInterval(() => {
        try {
          statements.deleteExpiredSessions.run(Date.now());
        } catch (error) {
          console.error('Unable to remove expired admin sessions.', error);
        }
      }, 60 * 60 * 1000);
      sessionCleanupTimer.unref();
      store.get = (sid, callback) => {
        try {
          const row = connection.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
          if (!row) return callback(null, null);
          if (row.expires <= Date.now()) {
            connection.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
            return callback(null, null);
          }
          return callback(null, JSON.parse(row.sess));
        } catch (error) {
          return callback(error);
        }
      };
      store.set = (sid, sess, callback = () => {}) => {
        try {
          const expiration = sess.cookie && sess.cookie.expires
            ? new Date(sess.cookie.expires).getTime()
            : Date.now() + (sess.cookie && sess.cookie.originalMaxAge || 0);
          connection.prepare(`
            INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
          `).run(sid, JSON.stringify(sess), expiration);
          return callback(null);
        } catch (error) {
          return callback(error);
        }
      };
      store.touch = (sid, sess, callback = () => {}) => {
        try {
          const expiration = sess.cookie && sess.cookie.expires
            ? new Date(sess.cookie.expires).getTime()
            : Date.now() + (sess.cookie && sess.cookie.originalMaxAge || 0);
          connection.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expiration, sid);
          return callback(null);
        } catch (error) {
          return callback(error);
        }
      };
      store.destroy = (sid, callback = () => {}) => {
        try {
          connection.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
          return callback(null);
        } catch (error) {
          return callback(error);
        }
      };
      store.clearExpired = () => statements.deleteExpiredSessions.run(Date.now());
      store.close = () => clearInterval(sessionCleanupTimer);
      return store;
    },
    backup: fullPath => connection.backup(fullPath),
    close: () => {
      if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
      connection.close();
    }
  };
}

module.exports = { createDatabase };
