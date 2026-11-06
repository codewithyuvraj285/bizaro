'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 3300 + Math.floor(Math.random() * 500), BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
let proc;
const start = () => new Promise((ok, no) => {
  proc = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT, DATA_DIR: DATA, DEV_OTP: '1', AUTH_RATE: '1000', SEND_RATE: '1000', NODE_ENV: 'test' } });
  proc.stdout.on('data', d => { if (String(d).includes('listening')) ok(); });
  proc.stderr.on('data', d => process.stderr.write(d)); proc.on('error', no);
});
const stop = () => new Promise(ok => { proc.once('exit', ok); proc.kill(); });
const call = async (jar, method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: jar.c || '' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) jar.c = sc.split(';')[0];
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const login = async (phone, name) => {
  const jar = {}, a = await call(jar, 'POST', '/api/auth/request-otp', { phone });
  const b = await call(jar, 'POST', '/api/auth/verify', { phone, code: a.j.devOtp, name });
  assert.equal(b.s, 200); jar.user = b.j.user; jar.phone = phone; return jar;
};
let A, B, C, D, direct;
const id = () => 'cid-' + Math.random().toString(36).slice(2, 12) + Date.now();
before(async () => {
  await start();
  [A, B, C, D] = [await login('+919000000001', 'Alice'), await login('+919000000002', 'Bob'), await login('+919000000003', 'Carol'), await login('+919000000004', 'Dave')];
  direct = (await call(A, 'POST', '/api/conversations', { type: 'direct', phones: [B.phone] })).j.id;
});
after(async () => { await stop(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('1 two users exchange messages; sender comes from session, not body', async () => {
  const r = await call(A, 'POST', `/api/conversations/${direct}/messages`, { clientId: id(), text: 'hi bob', senderId: B.user.id, sender: 'Mallory' });
  assert.equal(r.s, 201); assert.equal(r.j.message.sender, 'Alice'); assert.equal(r.j.message.senderId, A.user.id);
  const h = await call(B, 'GET', `/api/conversations/${direct}/messages`);
  assert.equal(h.j.messages.at(-1).text, 'hi bob'); assert.equal(h.j.messages.at(-1).out, false);
  const again = await call(B, 'POST', '/api/conversations', { type: 'direct', phones: [A.phone] });
  assert.equal(again.j.id, direct); // same 1:1, no duplicate conversation
});
test('2 idempotent retry: same clientId => one message, same seq', async () => {
  const cid = id(), a = await call(A, 'POST', `/api/conversations/${direct}/messages`, { clientId: cid, text: 'once' });
  const b = await call(A, 'POST', `/api/conversations/${direct}/messages`, { clientId: cid, text: 'once' });
  assert.equal(b.s, 200); assert.equal(b.j.duplicate, true); assert.equal(a.j.message.id, b.j.message.id); assert.equal(a.j.message.seq, b.j.message.seq);
});
test('3 30 concurrent sends get unique contiguous seq', async () => {
  const base = (await call(A, 'GET', `/api/conversations/${direct}/messages?limit=1`)).j.messages[0].seq;
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => call(i % 2 ? A : B, 'POST', `/api/conversations/${direct}/messages`, { clientId: id(), text: 'c' + i })));
  const seqs = rs.map(r => r.j.message.seq).sort((x, y) => x - y);
  assert.deepEqual(seqs, Array.from({ length: 30 }, (_, i) => base + 1 + i));
});
test('4 receipts: sent -> delivered -> read, monotonic', async () => {
  const m = (await call(A, 'POST', `/api/conversations/${direct}/messages`, { clientId: id(), text: 'rcpt' })).j.message;
  const st = async () => (await call(A, 'GET', `/api/conversations/${direct}/messages?limit=1`)).j.messages[0].status;
  assert.equal(await st(), 'sent');
  await call(B, 'POST', `/api/conversations/${direct}/receipts`, { delivered: m.seq }); assert.equal(await st(), 'delivered');
  await call(B, 'POST', `/api/conversations/${direct}/receipts`, { read: m.seq }); assert.equal(await st(), 'read');
  const back = await call(B, 'POST', `/api/conversations/${direct}/receipts`, { delivered: 1, read: 1 }); assert.equal(back.j.readSeq, m.seq); // never regresses
  await call(B, 'POST', `/api/conversations/${direct}/receipts`, { read: 999999 }); // clamped to last_seq
  assert.equal((await call(B, 'POST', `/api/conversations/${direct}/receipts`, {})).j.readSeq, m.seq);
});
test('5 missed events: cursor sync returns only what changed', async () => {
  const cur = (await call(B, 'GET', `/api/conversations/${direct}/messages?limit=1`)).j.lastRev;
  for (let i = 0; i < 3; i++) await call(A, 'POST', `/api/conversations/${direct}/messages`, { clientId: id(), text: 'missed' + i });
  const s = await call(B, 'GET', `/api/conversations/${direct}/sync?after=${cur}`);
  assert.deepEqual(s.j.messages.map(m => m.text), ['missed0', 'missed1', 'missed2']);
  assert.equal((await call(B, 'GET', `/api/conversations/${direct}/sync?after=${s.j.lastRev}`)).j.messages.length, 0);
});
test('6 unauthorized access is blocked (no session, non-member, non-JSON)', async () => {
  assert.equal((await call({}, 'GET', '/api/conversations')).s, 401);
  for (const [m, u, b] of [['GET', `/api/conversations/${direct}/messages`], ['GET', `/api/conversations/${direct}/sync?after=0`], ['POST', `/api/conversations/${direct}/messages`, { clientId: id(), text: 'x' }], ['POST', `/api/conversations/${direct}/receipts`, { read: 1 }], ['POST', `/api/conversations/${direct}/typing`, {}], ['GET', `/api/conversations/${direct}`]])
    assert.equal((await call(C, m, u, b)).s, 404, m + ' ' + u);
  const r = await fetch(BASE + `/api/conversations/${direct}/messages`, { method: 'POST', headers: { 'content-type': 'text/plain', cookie: A.c }, body: '{}' });
  assert.equal(r.status, 415);
  const x = await fetch(BASE + `/api/conversations/${direct}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: A.c, origin: 'https://evil.example' }, body: '{}' });
  assert.equal(x.status, 403);
});
test('7 edit/delete: only sender; delete erases text; clients see it via sync', async () => {
  const m = (await call(A, 'POST', `/api/conversations/${direct}/messages`, { clientId: id(), text: 'typo' })).j.message;
  const cur = (await call(B, 'GET', `/api/conversations/${direct}/messages?limit=1`)).j.lastRev;
  assert.equal((await call(B, 'PATCH', `/api/conversations/${direct}/messages/${m.id}`, { text: 'hax' })).s, 403);
  assert.equal((await call(B, 'DELETE', `/api/conversations/${direct}/messages/${m.id}`)).s, 403);
  assert.equal((await call(A, 'PATCH', `/api/conversations/${direct}/messages/${m.id}`, { text: 'fixed' })).s, 200);
  let s = await call(B, 'GET', `/api/conversations/${direct}/sync?after=${cur}`); assert.equal(s.j.messages[0].text, 'fixed'); assert.ok(s.j.messages[0].editedAt);
  assert.equal((await call(A, 'DELETE', `/api/conversations/${direct}/messages/${m.id}`)).s, 200);
  s = await call(B, 'GET', `/api/conversations/${direct}/sync?after=${cur}`); assert.equal(s.j.messages[0].deleted, true); assert.equal(s.j.messages[0].text, null);
  assert.equal((await call(A, 'PATCH', `/api/conversations/${direct}/messages/${m.id}`, { text: 'again' })).s, 409);
});
test('8 pagination: cursor pages cover 75 messages exactly once, in order', async () => {
  const g = (await call(A, 'POST', '/api/conversations', { type: 'group', name: 'Pages', phones: [B.phone] })).j.id;
  for (let i = 0; i < 75; i++) await call(A, 'POST', `/api/conversations/${g}/messages`, { clientId: id(), text: 'm' + i });
  const got = []; let before = '';
  for (let p = 0; p < 10; p++) { const h = (await call(A, 'GET', `/api/conversations/${g}/messages?limit=30${before}`)).j; got.unshift(...h.messages); if (!h.hasMore) break; before = '&before=' + h.messages[0].seq; }
  assert.deepEqual(got.map(m => m.text), Array.from({ length: 75 }, (_, i) => 'm' + i));
});
test('9 groups: admin-only changes, join-time history, leave, admin handover', async () => {
  const g = (await call(A, 'POST', '/api/conversations', { type: 'group', name: 'Team', phones: [B.phone] })).j.id;
  await call(A, 'POST', `/api/conversations/${g}/messages`, { clientId: id(), text: 'before carol' });
  assert.equal((await call(B, 'POST', `/api/conversations/${g}/members`, { phones: [C.phone] })).s, 403);
  assert.equal((await call(A, 'POST', `/api/conversations/${g}/members`, { phones: [C.phone] })).s, 200);
  await call(A, 'POST', `/api/conversations/${g}/messages`, { clientId: id(), text: 'after carol' });
  assert.deepEqual((await call(C, 'GET', `/api/conversations/${g}/messages`)).j.messages.map(m => m.text), ['after carol']);
  assert.equal((await call(B, 'PATCH', `/api/conversations/${g}`, { name: 'Hax' })).s, 403);
  assert.equal((await call(B, 'DELETE', `/api/conversations/${g}/members/${C.user.id}`)).s, 403);
  assert.equal((await call(C, 'DELETE', `/api/conversations/${g}/members/${C.user.id}`)).s, 200); // Carol leaves
  assert.equal((await call(C, 'GET', `/api/conversations/${g}/messages`)).s, 404);
  assert.equal((await call(A, 'DELETE', `/api/conversations/${g}/members/${A.user.id}`)).s, 200); // last admin leaves
  assert.equal((await call(B, 'GET', `/api/conversations/${g}`)).j.myRole, 'admin');
  assert.equal((await call(B, 'DELETE', `/api/conversations/${direct}/members/${A.user.id}`)).s, 400); // direct chats can't be left
});
test('10 group delivery is per participant: read only when ALL others read', async () => {
  const g = (await call(A, 'POST', '/api/conversations', { type: 'group', name: 'Recv', phones: [B.phone, D.phone] })).j.id;
  const m = (await call(A, 'POST', `/api/conversations/${g}/messages`, { clientId: id(), text: 'r' })).j.message;
  const st = async () => (await call(A, 'GET', `/api/conversations/${g}/messages?limit=1`)).j.messages[0].status;
  await call(B, 'POST', `/api/conversations/${g}/receipts`, { read: m.seq }); assert.equal(await st(), 'sent');
  await call(D, 'POST', `/api/conversations/${g}/receipts`, { delivered: m.seq }); assert.equal(await st(), 'delivered');
  await call(D, 'POST', `/api/conversations/${g}/receipts`, { read: m.seq }); assert.equal(await st(), 'read');
  const l = (await call(B, 'GET', '/api/conversations')).j.conversations.find(c => c.id === g); assert.equal(l.unread, 0);
  const l2 = (await call(D, 'GET', '/api/conversations')).j.conversations.find(c => c.id === g); assert.equal(l2.unread, 0);
});
test('11 realtime hint arrives over SSE (and typing is ephemeral)', async () => {
  const ac = new AbortController(), r = await fetch(BASE + '/api/events', { headers: { cookie: B.c }, signal: ac.signal });
  const reader = r.body.getReader(); let buf = '';
  const wait = (async () => { while (!buf.includes('"t":"msg"')) { const { value } = await reader.read(); buf += new TextDecoder().decode(value); } })();
  await call(A, 'POST', `/api/conversations/${direct}/typing`, {});
  await call(A, 'POST', `/api/conversations/${direct}/messages`, { clientId: id(), text: 'live' });
  await Promise.race([wait, new Promise((_, no) => setTimeout(() => no(new Error('no SSE event in 3s')), 3000))]);
  assert.ok(buf.includes('"t":"typing"')); ac.abort();
});
test('12 OTP: wrong code counts attempts and locks; name required for new users', async () => {
  const jar = {}, ph = '+919000000099', a = await call(jar, 'POST', '/api/auth/request-otp', { phone: ph });
  assert.equal((await call(jar, 'POST', '/api/auth/verify', { phone: ph, code: a.j.devOtp })).j.needsName, true);
  for (let i = 0; i < 5; i++) assert.equal((await call(jar, 'POST', '/api/auth/verify', { phone: ph, code: '0000' === a.j.devOtp ? '1111' : '0000' })).s, 400);
  assert.equal((await call(jar, 'POST', '/api/auth/verify', { phone: ph, code: a.j.devOtp, name: 'Z' })).s, 429);
  assert.equal((await call({}, 'POST', '/api/auth/request-otp', { phone: 'abc' })).s, 400);
});
test('13 restart: history and session survive; no sample data', async () => {
  const before = (await call(A, 'GET', `/api/conversations/${direct}/messages?limit=50`)).j.messages.length;
  await stop(); await start();
  const after = await call(A, 'GET', `/api/conversations/${direct}/messages?limit=50`); // same cookie => same session
  assert.equal(after.s, 200); assert.equal(after.j.messages.length, before); assert.ok(before > 5);
  await call(A, 'POST', '/api/auth/logout'); assert.equal((await call(A, 'GET', '/api/me')).s, 401);
});
