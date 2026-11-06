'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { open } = require('./src/db'), auth = require('./src/auth'), msg = require('./src/messaging'), events = require('./src/events');
const { HttpError, readBody, parseCookies, limiter } = require('./src/http');
const PORT = +process.env.PORT || 3000, PROD = process.env.NODE_ENV === 'production', INVITE = process.env.ACCESS_CODE || '';
if (PROD && !INVITE) { console.error('Refusing to start: set ACCESS_CODE (invite code) in production.'); process.exit(1); }
const db = open(path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'bizaro.sqlite'));
const authOk = limiter(+process.env.AUTH_RATE || 20, 60e3), sendOk = limiter(+process.env.SEND_RATE || 60, 10e3), typingOk = limiter(20, 10e3);
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o })); // never logs message text or secrets
const n = (v) => (v == null || v === '' ? null : Number(v));
const ip = (req) => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
const cookie = (token, max) => `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${max}${PROD ? '; Secure' : ''}`;
const notify = (ids, evt, except) => events.publish(ids.filter(i => i !== except), evt);

const routes = [];
const route = (m, p, h, o = {}) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h, ...o });
// ---- auth ----
route('POST', '/api/auth/request-otp', (c) => {
  if (INVITE && c.body.invite !== INVITE) throw new HttpError(403, 'Invite code required');
  const code = auth.requestOtp(db, c.body.phone);
  if (process.env.DEV_OTP === '1') { log({ level: 'warn', msg: 'DEV_OTP: code generated (not sent)', phone: c.body.phone }); return { sent: true, devOtp: code }; }
  throw new HttpError(501, 'No SMS provider configured. Integrate one in server.js (see docs/ARCHITECTURE.md) or set DEV_OTP=1 for local testing.');
}, { public: true, rate: 'auth' });
route('POST', '/api/auth/verify', (c) => {
  const r = auth.verifyOtp(db, c.body.phone, c.body.code, c.body.name);
  if (r.needsName) return r;
  c.setCookie = cookie(r.token, auth.SESSION_TTL / 1000);
  return { user: r.user };
}, { public: true, rate: 'auth' });
route('POST', '/api/auth/logout', (c) => { auth.endSession(db, c.token); c.setCookie = cookie('', 0); return { ok: true }; });
route('GET', '/api/me', (c) => ({ user: c.user }));
// ---- conversations ----
route('GET', '/api/conversations', (c) => ({ conversations: msg.list(db, c.user.id) }));
route('POST', '/api/conversations', (c) => { const r = msg.createConversation(db, c.user.id, c.body); if (r.created) notify(r.members, { t: 'conv', conv: r.id }, c.user.id); return r; });
route('GET', '/api/conversations/:id', (c) => msg.details(db, c.user.id, +c.params.id));
route('PATCH', '/api/conversations/:id', (c) => { const ids = msg.rename(db, c.user.id, +c.params.id, c.body.name); notify(ids, { t: 'conv', conv: +c.params.id }); return { ok: true }; });
route('POST', '/api/conversations/:id/members', (c) => { const ids = msg.addMembers(db, c.user.id, +c.params.id, c.body.phones); notify(ids, { t: 'conv', conv: +c.params.id }); return { ok: true }; });
route('DELETE', '/api/conversations/:id/members/:uid', (c) => { const ids = msg.removeMember(db, c.user.id, +c.params.id, +c.params.uid); notify(ids, { t: 'conv', conv: +c.params.id }); return { ok: true }; });
// ---- messages ----
route('GET', '/api/conversations/:id/messages', (c) => msg.history(db, c.user.id, +c.params.id, { before: n(c.q.get('before')), limit: n(c.q.get('limit')) }));
route('GET', '/api/conversations/:id/sync', (c) => msg.sync(db, c.user.id, +c.params.id, n(c.q.get('after'))));
route('POST', '/api/conversations/:id/messages', (c) => {
  if (!sendOk('u' + c.user.id)) throw new HttpError(429, 'Slow down');
  const r = msg.send(db, c.user.id, +c.params.id, c.body); // sender comes from the session, never from the body
  if (!r.duplicate) notify(msg.memberIds(db, +c.params.id), { t: 'msg', conv: +c.params.id, rev: r.message.rev }, c.user.id);
  c.status = r.duplicate ? 200 : 201; return r;
});
route('PATCH', '/api/conversations/:id/messages/:mid', (c) => { const m = msg.mutate(db, c.user.id, +c.params.id, +c.params.mid, { text: c.body.text }); notify(msg.memberIds(db, +c.params.id), { t: 'msg', conv: +c.params.id, rev: m.rev }, c.user.id); return { message: m }; });
route('DELETE', '/api/conversations/:id/messages/:mid', (c) => { const m = msg.mutate(db, c.user.id, +c.params.id, +c.params.mid, { delete: true }); notify(msg.memberIds(db, +c.params.id), { t: 'msg', conv: +c.params.id, rev: m.rev }, c.user.id); return { message: m }; });
route('POST', '/api/conversations/:id/receipts', (c) => { const r = msg.receipt(db, c.user.id, +c.params.id, c.body); if (r.changed) notify(msg.memberIds(db, +c.params.id), { t: 'receipt', conv: +c.params.id }, c.user.id); return r; });
route('POST', '/api/conversations/:id/typing', (c) => { msg.membership(db, +c.params.id, c.user.id); if (typingOk('u' + c.user.id)) notify(msg.memberIds(db, +c.params.id), { t: 'typing', conv: +c.params.id, user: c.user.id, name: c.user.name }, c.user.id); return { ok: true }; });
route('GET', '/api/events', (c) => { events.subscribe(c.user.id, c.res); c.handled = true; });

const MIME = { '.html': 'text/html; charset=utf-8', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.png': 'image/png' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  const t0 = Date.now(), u = new URL(req.url, 'http://x'), ctx = { req, res, q: u.searchParams, status: 200 };
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  try {
    if (!u.pathname.startsWith('/api/')) {
      const f = path.join(PUB, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname));
      if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' }); return fs.createReadStream(f).pipe(res);
    }
    const r = routes.map(x => ({ x, m: x.re.exec(u.pathname) })).find(o => o.m && o.x.m === req.method);
    if (!r) throw new HttpError(404, 'Not found');
    if (req.method !== 'GET') { // CSRF defence in depth: SameSite=Strict cookie + same-origin check + JSON-only bodies
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
      const raw = await readBody(req);
      if (raw) { if (!(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'JSON required'); try { ctx.body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); } }
    }
    ctx.body ||= {}; ctx.params = r.m.groups || {};
    if (r.x.rate === 'auth' && !authOk(ip(req))) throw new HttpError(429, 'Too many attempts');
    ctx.token = parseCookies(req).sid;
    if (!r.x.public) { ctx.user = auth.userFromToken(db, ctx.token); if (!ctx.user) throw new HttpError(401, 'Not logged in'); }
    const out = r.x.h(ctx);
    if (ctx.handled) { log({ level: 'info', m: req.method, p: u.pathname, uid: ctx.user?.id, msg: 'sse open' }); return; }
    const headers = { 'content-type': 'application/json' }; if (ctx.setCookie) headers['set-cookie'] = ctx.setCookie;
    res.writeHead(ctx.status, headers); res.end(JSON.stringify(out));
    log({ level: 'info', m: req.method, p: u.pathname.replace(/\d+/g, ':n'), s: ctx.status, ms: Date.now() - t0, uid: ctx.user?.id });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) log({ level: 'error', p: u.pathname, err: e.message });
    if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: status === 500 ? 'Internal error' : e.message })); }
  }
});
server.listen(PORT, () => log({ level: 'info', msg: 'listening', port: PORT }));
