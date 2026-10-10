const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

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
      status TEXT NOT NULL CHECK (status IN ('Unpaid', 'Paid')),
      date TEXT NOT NULL,
      member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
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
  `);

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
      INSERT INTO orders (receipt_id, name, phone, plan, plan_key, trainer, total, status, date, created_at)
      VALUES (@receiptId, @name, @phone, @plan, @planKey, @trainer, @total, 'Unpaid', @date, @createdAt)
    `),
    selectOrder: connection.prepare('SELECT * FROM orders WHERE id = ?'),
    listOrders: connection.prepare('SELECT * FROM orders ORDER BY id DESC'),
    updateOrderPayment: connection.prepare('UPDATE orders SET status = ?, member_id = ? WHERE id = ?'),
    listAudit: connection.prepare(`
      SELECT id, created_at AS createdAt, actor, action, entity_type AS entityType,
        entity_id AS entityId, details_json AS details
      FROM audit_log ORDER BY id DESC LIMIT ?
    `),
    paidRevenue: connection.prepare("SELECT COALESCE(SUM(total), 0) AS total FROM orders WHERE status = 'Paid'"),
    walkinsToday: connection.prepare("SELECT COUNT(*) AS count FROM orders WHERE plan_key = 'walkin' AND date = ?"),
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
    listOrders: () => statements.listOrders.all(),
    confirmPayment(id, today, calculateEndDate, addDate, actor) {
      const transaction = connection.transaction(() => {
        const order = statements.selectOrder.get(id);
        if (!order) return null;
        if (order.status === 'Paid') return order;

        let memberId = null;
        let memberBefore = null;
        if (order.plan_key !== 'walkin') {
          const existing = statements.findMemberByIdentity.get(order.phone, order.name.trim());
          if (existing) {
            memberId = existing.id;
            memberBefore = memberSnapshot(existing);
            const startDate = existing.end_date >= today ? addDate(existing.end_date, 1) : today;
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
            const startDate = today;
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

        statements.updateOrderPayment.run('Paid', memberId, id);
        const paidOrder = statements.selectOrder.get(id);
        recordAudit(actor, 'payment_confirmed', 'order', id, {
          receiptId: order.receipt_id,
          amount: order.total,
          memberId
        });
        return paidOrder;
      });
      return transaction();
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
