/* Messaging client core. Overrides the mock chat/auth functions of the original design with real ones.
   Source of truth = server. Local state: in-memory cache + a persistent outbox for unsent messages. */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
let me = null, es = null, listTimer = null, phone = '', otpCode = '', invite = '';
const rnd = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16));
const api = async (method, url, body) => {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return j;
};
const cur = () => chats.find(c => c.id === currentChatId);
const byId = (id) => chats.find(c => c.id === id);
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const css = document.createElement('style');
css.textContent = '.persona-bar,.pd-persona{display:none!important}#netBanner{display:none;background:#7c2d12;color:#fff;font-size:12px;text-align:center;padding:3px}#netBanner.on{display:block}.tick{margin-left:4px;font-size:11px}.retry{color:#fca5a5;cursor:pointer}';
document.head.appendChild(css);
const banner = document.createElement('div'); banner.id = 'netBanner'; banner.textContent = 'Reconnecting… messages will send when you are back online';
document.querySelector('.screen').prepend(banner);

/* ---------- outbox (persistent, survives restart) ---------- */
const OB = () => 'bt_outbox_' + me.id;
const loadOB = () => { try { return JSON.parse(localStorage.getItem(OB()) || '[]'); } catch { return []; } };
const saveOB = (a) => { try { localStorage.setItem(OB(), JSON.stringify(a)); } catch {} };
const backoff = (n) => Math.min(30000, 1000 * 2 ** n) * (0.5 + Math.random() / 2);
let flushing = false, wake = null, wakeAt = 0;
const schedule = (t) => { if (wake && wakeAt <= t) return; clearTimeout(wake); wakeAt = t; wake = setTimeout(() => { wake = null; wakeAt = 0; flush(); }, Math.max(50, t - Date.now()) + 50); };
async function flush() {
  if (flushing || !me) return; flushing = true;
  try {
    const blocked = new Set();
    for (const e of loadOB()) {
      if (e.failed || blocked.has(e.convId)) continue;       // keep per-chat order: stop at first unsent
      if (e.next > Date.now()) { blocked.add(e.convId); schedule(e.next); continue; }   // always leave a wake-up, even after a restart
      try {
        const r = await api('POST', `/api/conversations/${e.convId}/messages`, { clientId: e.clientId, text: e.text });
        saveOB(loadOB().filter(x => x.clientId !== e.clientId));
        const c = byId(e.convId); if (c) { upsert(c, r.message); c.messages.sort(cmp); } paint();
      } catch (err) {
        const all = loadOB(), x = all.find(o => o.clientId === e.clientId); if (!x) continue;
        if (err.status && err.status < 500 && err.status !== 429) { x.failed = true; x.error = err.message; }      // permanent: user must retry/see why
        else { x.tries++; if (x.tries >= 8) x.failed = true; else { x.next = Date.now() + backoff(x.tries); schedule(x.next); } blocked.add(e.convId); }
        saveOB(all); paint();
      }
    }
  } finally { flushing = false; }
}
window.addEventListener('online', flush);

/* ---------- message cache ---------- */
const cmp = (a, b) => (a.seq ?? 1e15) - (b.seq ?? 1e15);
function upsert(c, m) {
  const i = c.messages.findIndex(x => x.id === m.id || (m.clientId && x.clientId === m.clientId));
  if (i >= 0) c.messages[i] = m;
  else if (c.oldestSeq == null || m.seq >= c.oldestSeq) c.messages.push(m);   // never insert into an unloaded gap
  c.lastRev = Math.max(c.lastRev || 0, m.rev || 0);
}
function withOutbox(c) {
  for (const e of loadOB().filter(o => o.convId === c.id)) if (!c.messages.some(m => m.clientId === e.clientId))
    c.messages.push({ clientId: e.clientId, text: e.text, out: true, at: e.at || Date.now(), local: e.failed ? 'failed' : 'pending', error: e.error });
}
function statusOf(m, c) {
  if (m.local) return m.local;
  const o = (c.receipts || []).filter(r => r.userId !== me.id && r.joinedSeq < m.seq);
  return o.length && o.every(r => r.readSeq >= m.seq) ? 'read' : o.length && o.every(r => r.deliveredSeq >= m.seq) ? 'delivered' : 'sent';
}
const tick = (s) => ({ pending: '🕓', failed: '<span class="retry">⚠ tap to retry</span>', sent: '✓', delivered: '✓✓', read: '<span style="color:#53bdeb">✓✓</span>' }[s] || '');

/* ---------- load / sync ---------- */
async function loadList() {
  const { conversations } = await api('GET', '/api/conversations');
  const old = new Map(chats.map(c => [c.id, c]));
  chats = conversations.map(s => Object.assign(old.get(s.id) || { messages: [], loaded: false, receipts: [], lastRev: 0 }, { id: s.id, name: s.name, type: s.type, status: s.type === 'group' ? s.memberCount + ' members' : '', unread: s.unread, last: s.last, role: s.role, serverRev: s.lastRev }));
  if (document.querySelector('#view-chats.active')) renderChatList($('chatSearch').value);
  for (const c of chats) if (c.loaded && c.serverRev > c.lastRev) syncChat(c);
}
const scheduleList = () => { clearTimeout(listTimer); listTimer = setTimeout(() => loadList().catch(() => {}), 250); };
async function loadHistory(c, before) {
  const h = await api('GET', `/api/conversations/${c.id}/messages?limit=30${before ? '&before=' + before : ''}`);
  c.receipts = h.receipts; c.hasMore = h.hasMore;
  if (!before) { c.messages = h.messages; c.lastRev = h.lastRev; c.loaded = true; withOutbox(c); } else c.messages = [...h.messages, ...c.messages];
  c.oldestSeq = c.messages.find(m => m.seq)?.seq ?? null;
}
async function syncChat(c) {
  try {
    let more = true;
    while (more) { const s = await api('GET', `/api/conversations/${c.id}/sync?after=${c.lastRev}`); s.messages.forEach(m => upsert(c, m)); c.receipts = s.receipts; c.lastRev = Math.max(c.lastRev, s.lastRev); more = s.hasMore; }
    c.messages.sort(cmp); paint(c); report(c);
  } catch (e) { if (e.status === 404) { chats = chats.filter(x => x !== c); if (currentChatId === c.id) goToChats(); renderChatList(); } }
}
const nearBottom = () => { const a = $('messagesArea'); return a.scrollHeight - a.scrollTop - a.clientHeight < 80; };
async function report(c) {   // delivered = this device fetched it; read = chat open, tab visible, scrolled to bottom
  const last = Math.max(0, ...c.messages.filter(m => m.seq).map(m => m.seq));
  const read = currentChatId === c.id && document.visibilityState === 'visible' && nearBottom() ? last : 0;
  if (last <= (c.repD || 0) && read <= (c.repR || 0)) return;
  c.repD = Math.max(c.repD || 0, last); c.repR = Math.max(c.repR || 0, read);
  api('POST', `/api/conversations/${c.id}/receipts`, { delivered: last, read }).then(() => { if (read) { c.unread = 0; renderChatList(); } }).catch(() => { c.repD = c.repR = 0; });
}
function paint(c) { if (!c || c.id === currentChatId) renderMessages(); if (document.querySelector('#view-chats.active')) renderChatList($('chatSearch').value); }

/* ---------- realtime (SSE hints + cursor sync) ---------- */
function connect() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onopen = () => { banner.classList.remove('on'); loadList().then(() => chats.filter(c => c.loaded).forEach(syncChat)).catch(() => {}); flush(); };
  es.onerror = () => banner.classList.add('on');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data), c = byId(ev.conv);
    if (ev.t === 'typing' && c) { c.typingUntil = Date.now() + 4000; if (c.id === currentChatId) { $('convStatus').textContent = ev.name + ' is typing…'; setTimeout(() => { if (Date.now() >= c.typingUntil) $('convStatus').textContent = c.status; }, 4100); } return; }
    if (c && c.loaded) syncChat(c); scheduleList();
  };
}

/* ---------- chat UI (keeps the original markup/classes) ---------- */
window.renderChatList = function (filter = '') {
  const list = $('chatList'); list.innerHTML = '';
  if (!chats.length) list.innerHTML = '<div class="empty-state">No chats yet.<br>Tap ⋮ to start one.</div>';
  chats.filter(c => (c.name || '').toLowerCase().includes((filter || '').toLowerCase())).forEach(c => {
    const l = c.last, div = document.createElement('div'); div.className = 'chat-item'; div.onclick = () => openChat(c.id);
    div.innerHTML = `<div class="avatar" style="background:${colorFor(c.name)}">${initials(c.name)}</div><div class="chat-meta"><div class="chat-top"><span class="chat-name">${escapeHtml(c.name)}</span><span class="chat-time ${c.unread ? 'unread' : ''}">${l ? hhmm(l.at) : ''}</span></div><div class="chat-bottom"><span class="chat-preview">${l ? (l.mine ? 'You: ' : '') + (l.deleted ? 'This message was deleted' : escapeHtml(l.text)) : 'No messages yet'}</span>${c.unread ? `<span class="unread-badge">${c.unread}</span>` : ''}</div></div>`;
    list.appendChild(div);
  });
};
window.renderMessages = function (mode) {
  const c = cur(); if (!c) return; const area = $('messagesArea'), stick = mode === 'bottom' || nearBottom(), h0 = area.scrollHeight, t0 = area.scrollTop;
  area.innerHTML = c.hasMore ? '<div class="day-chip" id="olderChip">Scroll up for older messages</div>' : '<div class="day-chip">START OF CONVERSATION</div>';
  c.messages.forEach((m, i) => {
    const row = document.createElement('div'); row.className = 'bubble-row ' + (m.out ? 'out' : 'in'); row.dataset.i = i;
    const tag = !m.out && c.type === 'group' ? `<div class="sender-tag">${escapeHtml(m.sender)}</div>` : '';
    const body = m.deleted ? '<i>This message was deleted</i>' : escapeHtml(m.text) + (m.editedAt ? ' <small>(edited)</small>' : '');
    row.innerHTML = `${tag}<div class="bubble ${m.out ? 'out' : 'in'}">${body}<span class="btime">${hhmm(m.at)}${m.out && !m.deleted ? `<span class="tick">${tick(statusOf(m, c))}</span>` : ''}</span></div>`;
    area.appendChild(row);
  });
  if (mode === 'keep') area.scrollTop = t0 + (area.scrollHeight - h0); else if (stick) area.scrollTop = area.scrollHeight;
};
$('messagesArea').addEventListener('scroll', async () => {
  const c = cur(), a = $('messagesArea'); if (!c || !c.hasMore || c.loadingOlder || a.scrollTop > 40) return;
  c.loadingOlder = true; try { await loadHistory(c, c.oldestSeq); renderMessages('keep'); } catch {} c.loadingOlder = false;
});
$('messagesArea').addEventListener('click', async (e) => {
  const row = e.target.closest('.bubble-row.out'), c = cur(); if (!row || !c) return; const m = c.messages[+row.dataset.i]; if (!m || m.deleted) return;
  if (m.local === 'failed') { saveOB(loadOB().map(x => x.clientId === m.clientId ? { ...x, failed: false, tries: 0, next: 0, error: undefined } : x)); m.local = 'pending'; paint(c); return flush(); }
  if (m.local) return;
  const t = prompt('Edit your message. Type DELETE (capitals) to delete it for everyone.', m.text); if (t === null || t === m.text) return;
  try { const r = t === 'DELETE' ? await api('DELETE', `/api/conversations/${c.id}/messages/${m.id}`) : await api('PATCH', `/api/conversations/${c.id}/messages/${m.id}`, { text: t }); upsert(c, r.message); paint(c); } catch (err) { alert(err.message); }
});
window.openChat = async function (id) {
  currentChatId = id; const c = cur();
  $('convAvatar').style.background = colorFor(c.name); $('convAvatar').textContent = initials(c.name); $('convName').textContent = c.name; $('convStatus').textContent = c.status;
  showView('view-conversation'); renderMessages('bottom');
  try { if (!c.loaded) await loadHistory(c); else await syncChat(c); } catch (e) { alert('Could not load messages: ' + e.message); }
  renderMessages('bottom'); report(c);
};
window.goToChats = function () { currentChatId = null; showView('view-chats'); setActiveTab('chats'); renderChatList($('chatSearch').value); };
window.sendChatMessage = function () {
  const inp = $('msgInput'), text = inp.value.trim(), c = cur(); if (!text || !c) return;
  const e = { convId: c.id, clientId: rnd(), text, tries: 0, next: 0, at: Date.now() };
  saveOB([...loadOB(), e]); c.messages.push({ clientId: e.clientId, text, out: true, at: e.at, local: 'pending' });
  inp.value = ''; renderMessages('bottom'); flush();
};
let lastTyping = 0;
$('msgInput').addEventListener('input', () => { const c = cur(); if (c && Date.now() - lastTyping > 3000) { lastTyping = Date.now(); api('POST', `/api/conversations/${c.id}/typing`, {}).catch(() => {}); } });
document.addEventListener('visibilitychange', () => { const c = cur(); if (c) report(c); });
$('messagesArea').addEventListener('scroll', () => { const c = cur(); if (c && nearBottom()) report(c); });

/* ---------- new chat / group management (prompt-based, functional first) ---------- */
const norm = (p) => { const d = p.replace(/[\s-]/g, ''); return d.startsWith('+') ? d : '+91' + d; };
async function newChat() {
  const v = prompt('Phone number(s), comma separated (10-digit Indian numbers):'); if (!v) return;
  const phones = v.split(',').map(s => s.trim()).filter(Boolean).map(norm);
  const name = prompt('Group name (leave empty for a 1:1 chat):');
  if (phones.length > 1 && !name) return alert('A group needs a name.');
  try { const r = await api('POST', '/api/conversations', name ? { type: 'group', name, phones } : { type: 'direct', phones }); await loadList(); openChat(r.id); } catch (e) { alert(e.message); }
}
async function groupMenu() {
  const c = cur(); if (!c) return; const d = await api('GET', `/api/conversations/${c.id}`).catch(e => alert(e.message)); if (!d) return;
  if (d.type !== 'group') return alert('Direct chats have no settings yet.');
  const a = prompt(`Members: ${d.members.map(m => m.name + (m.role === 'admin' ? '*' : '')).join(', ')}\n\nType: add 98xxxxxxxx | remove <name> | rename <new name> | leave`); if (!a) return;
  const [cmd, ...rest] = a.trim().split(/\s+/), arg = rest.join(' ');
  try {
    if (cmd === 'add') await api('POST', `/api/conversations/${c.id}/members`, { phones: [norm(arg)] });
    else if (cmd === 'remove') { const t = d.members.find(m => m.name.toLowerCase() === arg.toLowerCase()); if (!t) return alert('No such member'); await api('DELETE', `/api/conversations/${c.id}/members/${t.id}`); }
    else if (cmd === 'rename') await api('PATCH', `/api/conversations/${c.id}`, { name: arg });
    else if (cmd === 'leave') { await api('DELETE', `/api/conversations/${c.id}/members/${me.id}`); goToChats(); }
    await loadList();
  } catch (e) { alert(e.message); }
}
document.querySelector('#view-chats .header-icons .icon-btn:last-child').onclick = newChat;
document.querySelector('#view-conversation .chat-header-icons .icon-btn:last-child').onclick = groupMenu;

/* ---------- auth ---------- */
const err = (id, m) => { $(id).textContent = m; };
window.sendOtp = async function (resend) {
  const raw = $('phoneInput').value.trim();
  if (!resend) { if (!/^[6-9]\d{9}$/.test(raw)) return err('phoneError', 'Enter a valid 10-digit mobile number'); phone = '+91' + raw; currentUser.phone = '+91 ' + raw; $('otpSubText').textContent = 'Enter the 4-digit code sent to ' + currentUser.phone; }
  try {
    const r = await api('POST', '/api/auth/request-otp', { phone, invite });
    $('otpBanner').textContent = r.devOtp ? 'Dev mode — no SMS sent. Your OTP is ' + r.devOtp : 'Code sent by SMS';
    err('phoneError', ''); err('otpError', ''); document.querySelectorAll('.otp-box').forEach(b => b.value = ''); showTop('screen-otp');
  } catch (e) {
    if (e.status === 403) { const i = prompt('Enter invite code'); if (i) { invite = i; return window.sendOtp(resend); } }
    err(resend ? 'otpError' : 'phoneError', e.message);
  }
};
window.verifyOtp = async function () {
  const code = Array.from(document.querySelectorAll('.otp-box')).map(b => b.value).join('');
  if (code.length < 4) return err('otpError', 'Enter the full 4-digit code');
  try { const r = await api('POST', '/api/auth/verify', { phone, code }); if (r.needsName) { otpCode = code; showTop('screen-profile-setup'); } else enter(r.user); } catch (e) { err('otpError', e.message); }
};
window.completeProfile = async function () {
  try { enter((await api('POST', '/api/auth/verify', { phone, code: otpCode, name: $('nameInput').value.trim() })).user); } catch (e) { alert(e.message); }
};
window.logout = async function () {
  if (!confirm('Log out of Bizaro Track?')) return;
  await api('POST', '/api/auth/logout').catch(() => {}); if (es) es.close(); me = null; chats = []; currentChatId = null; showTop('screen-phone'); $('phoneInput').value = '';
};
function enter(u) {
  me = u; currentUser.name = u.name; currentUser.phone = u.phone; currentUser.isAdmin = true; actingAs = u.name; chats = [];
  $('profileHeroName').textContent = u.name; $('profileHeroAvatar').textContent = initials(u.name); $('profilePhoneSub').textContent = u.phone;
  showTop('app-shell'); switchTab('chats'); renderChatList(); renderContacts(); connect(); loadList().catch(() => {});
}
api('GET', '/api/me').then(r => enter(r.user)).catch(() => {});   // restore session after restart / re-open
})();
