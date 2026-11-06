'use strict';
const crypto = require('crypto');
const { HttpError } = require('./http');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const PHONE = /^\+\d{10,15}$/, OTP_TTL = 5 * 60e3, SESSION_TTL = 30 * 864e5;

function requestOtp(db, phone) {
  if (typeof phone !== 'string' || !PHONE.test(phone)) throw new HttpError(400, 'Invalid phone number');
  const row = db.prepare('SELECT sent_at FROM otps WHERE phone=?').get(phone);
  if (row && Date.now() - row.sent_at < 30e3) throw new HttpError(429, 'Wait 30 seconds before requesting another code');
  const code = String(crypto.randomInt(1000, 10000));
  db.prepare('INSERT OR REPLACE INTO otps VALUES(?,?,?,0,?)').run(phone, sha(phone + ':' + code), Date.now() + OTP_TTL, Date.now());
  return code; // caller decides how to deliver (SMS provider / dev log). Never returned in production.
}
function verifyOtp(db, phone, code, name) {
  const row = typeof phone === 'string' && db.prepare('SELECT * FROM otps WHERE phone=?').get(phone);
  if (!row || row.expires_at < Date.now()) throw new HttpError(400, 'Code expired, request a new one');
  if (row.attempts >= 5) throw new HttpError(429, 'Too many attempts, request a new code');
  if (!same(sha(phone + ':' + String(code)), row.code_hash)) {
    db.prepare('UPDATE otps SET attempts=attempts+1 WHERE phone=?').run(phone);
    throw new HttpError(400, 'Incorrect code');
  }
  let user = db.prepare('SELECT id,phone,name FROM users WHERE phone=?').get(phone);
  if (!user) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n) return { needsName: true };               // code is NOT consumed yet
    if (n.length > 60) throw new HttpError(400, 'Name too long');
    const id = db.prepare('INSERT INTO users(phone,name,created_at) VALUES(?,?,?)').run(phone, n, Date.now()).lastInsertRowid;
    user = { id, phone, name: n };
  }
  db.prepare('DELETE FROM otps WHERE phone=?').run(phone);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(token), user.id, Date.now() + SESSION_TTL);
  return { user, token };
}
const userFromToken = (db, token) => token ? db.prepare('SELECT u.id,u.phone,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(sha(token), Date.now()) : null;
const endSession = (db, token) => token && db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
module.exports = { requestOtp, verifyOtp, userFromToken, endSession, SESSION_TTL };
