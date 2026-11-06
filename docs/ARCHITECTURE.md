# Architecture & decisions
**Stack:** Node 22 (no npm deps), `node:sqlite` (experimental in Node 22, pin your Node version), SSE realtime, vanilla-JS PWA client.
**Layout:** `server.js` routes/HTTP · `src/messaging.js` all authorization + business rules · `src/auth.js` OTP/sessions · `src/events.js` SSE hub · `src/db.js` migrations/tx · `migrations/*.sql` · `public/app-core.js` client core.

## Message model
- `seq` per conversation = ordering (assigned inside `BEGIN IMMEDIATE`, server-authoritative). `rev` = change counter (new/edit/delete/membership) = **sync cursor**.
- Idempotency: `UNIQUE(conv_id, sender_id, client_id)`. A retry after a timeout returns the original message (`duplicate:true`).
- Status meaning: **sent** = server stored it. **delivered** = every other member's client fetched it. **read** = every other member had the chat open+visible+scrolled to bottom. Group = all others (members present at send time). Receipts are monotonic cursors (`delivered_seq/read_seq`), not per-message rows.
- Client states: `pending` (in persistent outbox, retried with exponential backoff+jitter, 8 tries) -> `failed` (tap to retry) -> server status. Nothing is silently dropped.
## Realtime
SSE pushes only hints (`msg|conv|receipt|typing`). Correctness comes from cursor sync (`GET /sync?after=rev`), run on every reconnect, so missed/duplicate/out-of-order events are harmless. Typing is ephemeral (no DB). Slow SSE clients are dropped (backpressure) and resync.
## Semantics
- Delete = "for everyone": text erased from the row, tombstone kept for sync. Not a claim of erasure from backups/recipient devices.
- Edit: sender only, 15 min window, marked "(edited)". New members see history only after they joined; leavers lose access. Group never left without admin (auto-promotes oldest member).
- Non-members get 404 (existence not leaked).
## Security model (current)
HttpOnly+SameSite=Strict session cookie (token stored hashed), same-origin check, JSON-only bodies, per-IP auth and per-user send rate limits, input validation, CSP (`unsafe-inline` still needed by the original inline script), structured logs without message text. **No end-to-end encryption**: the server can read messages. Don't add custom crypto; evaluate Signal/MLS later.
## AI extension point (not implemented)
An AI = a normal `users` row with a `kind='ai'` flag (add via migration) that joins conversations and posts through `send()` with its own `client_id`s; a worker listens for new messages (same `rev` cursor) and calls providers. The prototype adapters are preserved in `legacy/server-ai-prototype.js`.
## Not implemented / known gaps
Attachments/media, forwarding, reply UI (API supports `replyTo`), presence/last-seen, multi-process scaling (SSE hub is in-memory; SQLite single node), real SMS provider, contact discovery, unread-jump UI, message virtualization, user-facing privacy settings.
