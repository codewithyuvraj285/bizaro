'use strict';
// Core messaging service. All authorization lives here (server-side). Non-members get 404, not 403,
// so conversation existence is not leaked.
const { HttpError } = require('./http');
const { tx } = require('./db');
const EDIT_WINDOW_MS = 15 * 60e3;
const MSG = 'SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id';
const bad = (m) => new HttpError(400, m);
const int = (v, d = null) => (Number.isInteger(v) && v >= 0 ? v : d);

function membership(db, convId, userId) {
  const m = db.prepare('SELECT * FROM members WHERE conv_id=? AND user_id=? AND left_at IS NULL').get(convId, userId);
  if (!m) throw new HttpError(404, 'Conversation not found');
  return m;
}
const conv = (db, id) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
const receiptRows = (db, convId) => db.prepare('SELECT user_id,delivered_seq,read_seq,joined_seq FROM members WHERE conv_id=? AND left_at IS NULL').all(convId);
const publicReceipts = (rs) => rs.map(r => ({ userId: r.user_id, deliveredSeq: r.delivered_seq, readSeq: r.read_seq, joinedSeq: r.joined_seq }));
const memberIds = (db, convId) => db.prepare('SELECT user_id FROM members WHERE conv_id=? AND left_at IS NULL').all(convId).map(r => r.user_id);

// Status meaning: sent = accepted by server; delivered = every other member's device has fetched it;
// read = every other member opened the chat with it visible. Only members present when it was sent count.
function shape(row, me, rs) {
  let status = null;
  if (row.sender_id === me) {
    const others = rs.filter(r => r.user_id !== me && r.joined_seq < row.seq);
    status = others.length && others.every(r => r.read_seq >= row.seq) ? 'read'
      : others.length && others.every(r => r.delivered_seq >= row.seq) ? 'delivered' : 'sent';
  }
  return { id: row.id, seq: row.seq, rev: row.rev, clientId: row.sender_id === me ? row.client_id : undefined, senderId: row.sender_id,
    sender: row.sender_name, text: row.deleted_at ? null : row.text, replyTo: row.reply_to, at: row.created_at,
    editedAt: row.edited_at, deleted: !!row.deleted_at, status, out: row.sender_id === me };
}
const bump = (db, convId) => db.prepare('UPDATE conversations SET last_rev=last_rev+1 WHERE id=? RETURNING last_rev').get(convId).last_rev;

function usersByPhones(db, phones) {
  if (!Array.isArray(phones) || !phones.length || phones.length > 50) throw bad('phones must be a list of 1-50 numbers');
  return phones.map(p => {
    if (typeof p !== 'string' || !/^\+\d{10,15}$/.test(p)) throw bad('Invalid phone number');
    const u = db.prepare('SELECT id FROM users WHERE phone=?').get(p);
    if (!u) throw new HttpError(404, `${p} is not registered`);
    return u.id;
  });
}
const cleanName = (n) => { const s = typeof n === 'string' ? n.trim() : ''; if (!s || s.length > 60) throw bad('Group name must be 1-60 characters'); return s; };

function createConversation(db, userId, { type, name, phones }) {
  if (type !== 'direct' && type !== 'group') throw bad('type must be direct or group');
  const others = [...new Set(usersByPhones(db, phones))].filter(id => id !== userId);
  if (!others.length) throw bad('Add at least one other person');
  const key = type === 'direct' ? [userId, others[0]].sort((a, b) => a - b).join(':') : null;
  if (type === 'direct') {
    if (others.length !== 1) throw bad('A direct chat has exactly one other person');
    const ex = db.prepare('SELECT id FROM conversations WHERE direct_key=?').get(key);
    if (ex) return { id: ex.id, created: false };
  }
  const gname = type === 'group' ? cleanName(name) : null;
  try {
    return tx(db, () => {
      const id = db.prepare('INSERT INTO conversations(type,name,direct_key,created_by,created_at) VALUES(?,?,?,?,?)').run(type, gname, key, userId, Date.now()).lastInsertRowid;
      const ins = db.prepare('INSERT INTO members(conv_id,user_id,role,joined_at) VALUES(?,?,?,?)');
      ins.run(id, userId, type === 'group' ? 'admin' : 'member', Date.now());
      for (const o of others) ins.run(id, o, 'member', Date.now());
      return { id, created: true, members: [userId, ...others] };
    });
  } catch (e) {
    const ex = key && db.prepare('SELECT id FROM conversations WHERE direct_key=?').get(key);
    if (ex) return { id: ex.id, created: false }; // lost a creation race: return the winner
    throw e;
  }
}

function list(db, userId) {
  const rows = db.prepare(`SELECT c.id,c.type,c.name,c.last_seq,c.last_rev,m.role,m.read_seq,
    (SELECT COUNT(*) FROM messages x WHERE x.conv_id=c.id AND x.seq>MAX(m.read_seq,m.joined_seq) AND x.sender_id<>? AND x.deleted_at IS NULL) AS unread,
    (SELECT u.name FROM members mm JOIN users u ON u.id=mm.user_id WHERE mm.conv_id=c.id AND mm.user_id<>? LIMIT 1) AS peer_name,
    (SELECT COUNT(*) FROM members mm WHERE mm.conv_id=c.id AND mm.left_at IS NULL) AS member_count,
    (SELECT x.text FROM messages x WHERE x.conv_id=c.id AND x.seq>m.joined_seq ORDER BY x.seq DESC LIMIT 1) AS lm_text,
    (SELECT x.created_at FROM messages x WHERE x.conv_id=c.id AND x.seq>m.joined_seq ORDER BY x.seq DESC LIMIT 1) AS lm_at,
    (SELECT x.deleted_at FROM messages x WHERE x.conv_id=c.id AND x.seq>m.joined_seq ORDER BY x.seq DESC LIMIT 1) AS lm_deleted,
    (SELECT x.sender_id FROM messages x WHERE x.conv_id=c.id AND x.seq>m.joined_seq ORDER BY x.seq DESC LIMIT 1) AS lm_sender
    FROM members m JOIN conversations c ON c.id=m.conv_id WHERE m.user_id=? AND m.left_at IS NULL ORDER BY c.last_rev DESC`).all(userId, userId, userId);
  return rows.map(r => ({ id: r.id, type: r.type, name: r.type === 'direct' ? r.peer_name : r.name, memberCount: r.member_count, role: r.role,
    unread: r.unread, lastSeq: r.last_seq, lastRev: r.last_rev, readSeq: r.read_seq,
    last: r.lm_at ? { text: r.lm_deleted ? null : r.lm_text, at: r.lm_at, mine: r.lm_sender === userId, deleted: !!r.lm_deleted } : null }));
}
function details(db, userId, convId) {
  const me = membership(db, convId, userId), c = conv(db, convId);
  const members = db.prepare('SELECT u.id,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.conv_id=? AND m.left_at IS NULL ORDER BY m.joined_at').all(convId);
  return { id: c.id, type: c.type, name: c.name, myRole: me.role, members };
}

function send(db, userId, convId, { clientId, text, replyTo }) {
  if (typeof clientId !== 'string' || !/^[\w-]{8,64}$/.test(clientId)) throw bad('clientId must be 8-64 chars [A-Za-z0-9_-]');
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw bad('Message must be 1-4000 characters');
  const { row, duplicate } = tx(db, () => {
    const mem = membership(db, convId, userId);
    const dup = db.prepare(`${MSG} WHERE m.conv_id=? AND m.sender_id=? AND m.client_id=?`).get(convId, userId, clientId);
    if (dup) return { row: dup, duplicate: true };           // idempotent retry: same answer, no new row
    if (replyTo != null && !db.prepare('SELECT 1 FROM messages WHERE id=? AND conv_id=? AND seq>? AND deleted_at IS NULL').get(replyTo, convId, mem.joined_seq)) throw bad('Reply target not available');
    const c = db.prepare('UPDATE conversations SET last_seq=last_seq+1,last_rev=last_rev+1 WHERE id=? RETURNING last_seq,last_rev').get(convId);
    const id = db.prepare('INSERT INTO messages(conv_id,seq,rev,sender_id,client_id,text,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(convId, c.last_seq, c.last_rev, userId, clientId, text.trim(), replyTo ?? null, Date.now()).lastInsertRowid;
    db.prepare('UPDATE members SET delivered_seq=MAX(delivered_seq,?),read_seq=MAX(read_seq,?) WHERE conv_id=? AND user_id=?').run(c.last_seq, c.last_seq, convId, userId);
    return { row: db.prepare(`${MSG} WHERE m.id=?`).get(id), duplicate: false };
  });
  return { message: shape(row, userId, receiptRows(db, convId)), duplicate };
}

function history(db, userId, convId, q) {
  const mem = membership(db, convId, userId);
  const limit = Math.min(50, Math.max(1, int(q.limit, 30)));
  const before = int(q.before, null);
  const rows = db.prepare(`${MSG} WHERE m.conv_id=? AND m.seq>? AND (? IS NULL OR m.seq<?) ORDER BY m.seq DESC LIMIT ?`).all(convId, mem.joined_seq, before, before, limit + 1);
  const hasMore = rows.length > limit; rows.length = Math.min(rows.length, limit); rows.reverse();
  const rs = receiptRows(db, convId);
  return { messages: rows.map(r => shape(r, userId, rs)), hasMore, lastRev: conv(db, convId).last_rev, receipts: publicReceipts(rs) };
}
function sync(db, userId, convId, afterRev) {
  const mem = membership(db, convId, userId);
  const rows = db.prepare(`${MSG} WHERE m.conv_id=? AND m.rev>? AND m.seq>? ORDER BY m.rev LIMIT 201`).all(convId, int(afterRev, 0), mem.joined_seq);
  const hasMore = rows.length > 200; rows.length = Math.min(rows.length, 200);
  const rs = receiptRows(db, convId);
  const lastRev = hasMore ? rows[rows.length - 1].rev : conv(db, convId).last_rev;
  return { messages: rows.map(r => shape(r, userId, rs)), hasMore, lastRev, receipts: publicReceipts(rs) };
}

function receipt(db, userId, convId, { delivered, read }) {
  return tx(db, () => {
    const mem = membership(db, convId, userId), top = conv(db, convId).last_seq;
    const r = Math.min(top, int(read, 0)), d = Math.min(top, Math.max(int(delivered, 0), r));
    db.prepare('UPDATE members SET delivered_seq=MAX(delivered_seq,?),read_seq=MAX(read_seq,?) WHERE conv_id=? AND user_id=?').run(d, r, convId, userId); // monotonic
    const now = db.prepare('SELECT delivered_seq,read_seq FROM members WHERE conv_id=? AND user_id=?').get(convId, userId);
    return { deliveredSeq: now.delivered_seq, readSeq: now.read_seq, changed: now.delivered_seq !== mem.delivered_seq || now.read_seq !== mem.read_seq };
  });
}

function mutate(db, userId, convId, msgId, patch) {
  return tx(db, () => {
    const mem = membership(db, convId, userId);
    const row = db.prepare('SELECT * FROM messages WHERE id=? AND conv_id=? AND seq>?').get(msgId, convId, mem.joined_seq);
    if (!row) throw new HttpError(404, 'Message not found');
    if (row.sender_id !== userId) throw new HttpError(403, 'You can only change your own messages');
    if (row.deleted_at) throw new HttpError(409, 'Message already deleted');
    const rev = bump(db, convId);
    if (patch.delete) db.prepare('UPDATE messages SET text=NULL,deleted_at=?,rev=? WHERE id=?').run(Date.now(), rev, msgId); // deleted for everyone; text erased from the row
    else {
      if (typeof patch.text !== 'string' || !patch.text.trim() || patch.text.length > 4000) throw bad('Message must be 1-4000 characters');
      if (Date.now() - row.created_at > EDIT_WINDOW_MS) throw new HttpError(403, 'Edit window (15 min) has passed');
      db.prepare('UPDATE messages SET text=?,edited_at=?,rev=? WHERE id=?').run(patch.text.trim(), Date.now(), rev, msgId);
    }
    return shape(db.prepare(`${MSG} WHERE m.id=?`).get(msgId), userId, receiptRows(db, convId));
  });
}

function addMembers(db, actor, convId, phones) {
  const ids = [...new Set(usersByPhones(db, phones))];
  return tx(db, () => {
    const me = membership(db, convId, actor), c = conv(db, convId);
    if (c.type !== 'group') throw bad('Only groups have members to add');
    if (me.role !== 'admin') throw new HttpError(403, 'Only admins can add members');
    for (const id of ids) {
      const row = db.prepare('SELECT left_at FROM members WHERE conv_id=? AND user_id=?').get(convId, id);
      if (!row) db.prepare('INSERT INTO members(conv_id,user_id,role,joined_seq,joined_at,delivered_seq,read_seq) VALUES(?,?,?,?,?,?,?)').run(convId, id, 'member', c.last_seq, Date.now(), c.last_seq, c.last_seq);
      else if (row.left_at) db.prepare("UPDATE members SET left_at=NULL,role='member',joined_seq=?,joined_at=?,delivered_seq=?,read_seq=? WHERE conv_id=? AND user_id=?").run(c.last_seq, Date.now(), c.last_seq, c.last_seq, convId, id);
    }
    bump(db, convId);
    return memberIds(db, convId);
  });
}
function removeMember(db, actor, convId, targetId) {
  return tx(db, () => {
    const me = membership(db, convId, actor);
    if (conv(db, convId).type !== 'group') throw bad('Direct chats cannot be left');
    if (targetId !== actor && me.role !== 'admin') throw new HttpError(403, 'Only admins can remove members');
    const t = db.prepare('SELECT role FROM members WHERE conv_id=? AND user_id=? AND left_at IS NULL').get(convId, targetId);
    if (!t) throw new HttpError(404, 'Member not found');
    const before = memberIds(db, convId);
    db.prepare('UPDATE members SET left_at=? WHERE conv_id=? AND user_id=?').run(Date.now(), convId, targetId);
    if (!db.prepare("SELECT 1 FROM members WHERE conv_id=? AND left_at IS NULL AND role='admin'").get(convId)) // never leave a group without an admin
      db.prepare("UPDATE members SET role='admin' WHERE conv_id=? AND user_id=(SELECT user_id FROM members WHERE conv_id=? AND left_at IS NULL ORDER BY joined_at,user_id LIMIT 1)").run(convId, convId);
    bump(db, convId);
    return before;
  });
}
function rename(db, actor, convId, name) {
  return tx(db, () => {
    const me = membership(db, convId, actor);
    if (conv(db, convId).type !== 'group') throw bad('Only groups can be renamed');
    if (me.role !== 'admin') throw new HttpError(403, 'Only admins can rename the group');
    db.prepare('UPDATE conversations SET name=? WHERE id=?').run(cleanName(name), convId); bump(db, convId);
    return memberIds(db, convId);
  });
}
module.exports = { createConversation, list, details, send, history, sync, receipt, mutate, addMembers, removeMember, rename, memberIds, membership };
