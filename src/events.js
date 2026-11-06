'use strict';
// Realtime = Server-Sent Events. Events are only HINTS ("something changed in conv X"); clients recover
// correctness by cursor sync, so a missed/duplicated/reordered event can never corrupt history.
const clients = new Map(); // userId -> Set<res>
function subscribe(userId, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 2000\n\n');
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  res.on('close', () => { const s = clients.get(userId); if (s) { s.delete(res); if (!s.size) clients.delete(userId); } });
}
function publish(userIds, evt) {
  const data = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const u of userIds) for (const res of clients.get(u) || []) {
    if (res.writableLength > 262144) { res.destroy(); continue; } // slow client: drop it, it will resync on reconnect
    res.write(data);
  }
}
setInterval(() => { for (const s of clients.values()) for (const r of s) r.write(': ping\n\n'); }, 25e3).unref();
module.exports = { subscribe, publish };
