'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const dir = path.join(__dirname, '..', 'migrations');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  for (const f of fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    const v = parseInt(f, 10);
    if (done.has(v)) continue;
    tx(db, () => { db.exec(fs.readFileSync(path.join(dir, f), 'utf8')); db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(v, Date.now()); });
  }
  return db;
}
// BEGIN IMMEDIATE takes the write lock up front, so counters (seq/rev) are race-free even across processes.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
module.exports = { open, tx };
