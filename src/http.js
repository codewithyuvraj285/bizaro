'use strict';
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const readBody = (req, limit = 16384) => new Promise((ok, no) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > limit) { no(new HttpError(413, 'Body too large')); req.destroy(); } });
  req.on('end', () => ok(b));
  req.on('error', no);
});
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, v.join('=')]));
function limiter(max, windowMs) {
  const hits = new Map(); setInterval(() => hits.clear(), windowMs).unref();
  return (key) => { const n = (hits.get(key) || 0) + 1; hits.set(key, n); return n <= max; };
}
module.exports = { HttpError, readBody, parseCookies, limiter };
