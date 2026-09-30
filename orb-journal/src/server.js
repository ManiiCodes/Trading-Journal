const path = require('path');
const express = require('express');
const { q, tx } = require('./db');
const sec = require('./security');
const tv = require('./tradovate');
const { upsertLegs, legsFromPerformanceCsv, ImportError, blankTradeData } = require('./importer');

const PORT = Number(process.env.PORT) || 3000;
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE_COOKIE = APP_URL.startsWith('https://');
const ALLOW_SIGNUPS = process.env.ALLOW_SIGNUPS !== 'false';
const SYNC_MINUTES = Math.max(5, Number(process.env.SYNC_MINUTES) || 15);
const REDIRECT_URI = `${APP_URL}/api/tradovate/oauth/callback`;
const SESSION_DAYS = 30;

const DEFAULT_SETTINGS = { fees: { NQ: 0, MNQ: 0, ES: 0, MES: 0 }, defaultInstr: 'NQ', theme: '', timezone: 'America/Chicago' };
const FIRMS = ['Tradeify', 'Lucid Trading', 'Purdia Capital', 'Tradovate (personal)', 'Other'];
const KINDS = ['', 'Eval', 'Funded', 'Live'];

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(express.json({ limit: '10mb' }));

// ---------- sessions ----------
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(res, value, maxAge) {
  res.append('Set-Cookie', `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`);
}
function startSession(res, userId) {
  const id = sec.newId();
  q.insertSession.run(id, userId, Date.now() + SESSION_DAYS * 864e5);
  setSessionCookie(res, id, SESSION_DAYS * 86400);
}
app.use((req, res, next) => {
  const sid = readCookie(req, 'sid');
  if (sid) {
    const s = q.getSession.get(sid, Date.now());
    if (s) { req.user = { id: s.user_id, email: s.email }; req.sid = sid; }
  }
  next();
});
// CSRF: state-changing API calls must carry a header a cross-site form can't send
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Request blocked' });
  next();
});
const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in first' }));

// ---------- helpers ----------
const clip = (s, n) => String(s ?? '').slice(0, n);
const numOrNull = v => (v === '' || v == null || !isFinite(+v) ? null : +v);
const strList = (a, n = 20) => (Array.isArray(a) ? a.slice(0, n).map(x => clip(x, 60)) : []);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function getSettings(userId) {
  const row = q.getSettings.get(userId);
  const s = row ? JSON.parse(row.data) : {};
  return { ...DEFAULT_SETTINGS, ...s, fees: { ...DEFAULT_SETTINGS.fees, ...(s.fees || {}) } };
}
function publicConnection(c) {
  return { id: c.id, method: c.method, env: c.env, label: c.label, status: c.status,
    lastSyncAt: c.last_sync_at, lastError: c.last_error, createdAt: c.created_at };
}
function publicTrade(t, legsByTrade) {
  const d = JSON.parse(t.data);
  return { ...d, id: t.id, source: t.source,
    legs: (legsByTrade.get(t.id) || []).map(l => ({ id: l.id, account_id: l.account_id, symbol: l.symbol, side: l.side,
      qty: l.qty, entry: l.entry, exit: l.exit, gross: l.gross, fees: l.fees, entry_ts: l.entry_ts, exit_ts: l.exit_ts, source: l.source })) };
}
function entryTsFor(date, time, tz) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || ''), tm = /^(\d{2}):(\d{2})$/.exec(time || '');
  if (!dm) return null;
  return sec.wallToUtc(+dm[1], +dm[2], +dm[3], tm ? +tm[1] : 12, tm ? +tm[2] : 0, 0, tz);
}

// ---------- pages ----------
const pub = path.join(__dirname, '..', 'public');
app.use('/assets', express.static(pub, { index: false, maxAge: '1h' }));
app.get('/', (req, res) => res.redirect(req.user ? '/app' : '/login'));
app.get('/login', (req, res) => (req.user ? res.redirect('/app') : res.sendFile(path.join(pub, 'login.html'))));
app.get('/app', (req, res) => (req.user ? res.sendFile(path.join(pub, 'app.html')) : res.redirect('/login')));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- auth ----------
app.get('/api/auth/config', (req, res) => res.json({ signups: ALLOW_SIGNUPS }));

app.post('/api/auth/signup', (req, res) => {
  if (!ALLOW_SIGNUPS) return res.status(403).json({ error: 'New sign-ups are turned off on this site.' });
  if (!sec.rateLimit(`signup:${req.ip}`, 10, 60 * 60e3)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const email = clip(req.body?.email, 200).trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (password.length < 10) return res.status(400).json({ error: 'Use a password of at least 10 characters.' });
  if (q.userByEmail.get(email)) return res.status(409).json({ error: 'That email already has an account. Sign in instead.' });
  const id = sec.newId('u_');
  q.insertUser.run(id, email, sec.hashPassword(password), Date.now());
  q.putSettings.run(id, JSON.stringify(DEFAULT_SETTINGS));
  startSession(res, id);
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const email = clip(req.body?.email, 200).trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!sec.rateLimit(`login:${req.ip}:${email}`, 8, 15 * 60e3)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and try again.' });
  const u = q.userByEmail.get(email);
  if (!u || !sec.verifyPassword(password, u.pass_hash)) return res.status(401).json({ error: 'Email or password is wrong.' });
  startSession(res, u.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.sid) q.deleteSession.run(req.sid);
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

// ---------- state ----------
app.get('/api/state', requireUser, (req, res) => {
  const uid = req.user.id;
  const legsByTrade = new Map();
  for (const l of q.legsForUser.all(uid)) {
    if (!legsByTrade.has(l.trade_id)) legsByTrade.set(l.trade_id, []);
    legsByTrade.get(l.trade_id).push(l);
  }
  res.json({
    user: { email: req.user.email },
    settings: getSettings(uid),
    accounts: q.accountsForUser.all(uid).map(a => ({ id: a.id, name: a.name, firm: a.firm, kind: a.kind,
      linked: a.tv_account_id != null, env: a.tv_env, connectionId: a.connection_id })),
    connections: q.connectionsForUser.all(uid).map(publicConnection),
    trades: q.tradesForUser.all(uid).map(t => publicTrade(t, legsByTrade)),
    tradovate: { oauth: tv.oauthConfigured(), redirectUri: REDIRECT_URI },
    options: { firms: FIRMS, kinds: KINDS },
  });
});

// ---------- trades ----------
const JOURNAL_FIELDS = t => ({
  orh: numOrNull(t.orh), orl: numOrNull(t.orl), stop: numOrNull(t.stop), target: numOrNull(t.target),
  c15: !!t.c15, c5: !!t.c5, c1: !!t.c1, plan: !!t.plan, grade: ['A', 'B', 'C'].includes(t.grade) ? t.grade : '',
  mistakes: strList(t.mistakes), emotion: strList(t.emotion), notes: clip(t.notes, 5000), link: clip(t.link, 500),
});
const EXEC_FIELDS = t => ({
  date: /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : null, time: /^\d{2}:\d{2}$/.test(t.time || '') ? t.time : '',
  instr: clip(t.instr, 10).toUpperCase() || 'NQ', side: t.side === 'short' ? 'short' : 'long',
  qty: Math.max(1, Math.round(+t.qty || 1)), entry: numOrNull(t.entry), exit: numOrNull(t.exit), accts: strList(t.accts, 50),
});

app.post('/api/trades', requireUser, (req, res) => {
  const uid = req.user.id, s = getSettings(uid);
  const exec = EXEC_FIELDS(req.body || {});
  if (!exec.date || exec.entry == null || exec.exit == null) return res.status(400).json({ error: 'Add a date, entry and exit.' });
  const data = { ...blankTradeData(), ...exec, ...JOURNAL_FIELDS(req.body), reviewed: true };
  const id = sec.newId('t_');
  q.insertTrade.run(id, uid, exec.date, entryTsFor(exec.date, exec.time, s.timezone), exec.instr, exec.side, 'manual', JSON.stringify(data), Date.now());
  res.json({ id });
});

app.put('/api/trades/:id', requireUser, (req, res) => {
  const uid = req.user.id, s = getSettings(uid);
  const t = q.tradeById.get(req.params.id, uid);
  if (!t) return res.status(404).json({ error: 'Trade not found.' });
  const hasLegs = q.legsForTrade.all(t.id).length > 0;
  const old = JSON.parse(t.data);
  let data = { ...old, ...JOURNAL_FIELDS(req.body || {}), reviewed: true };
  let date = t.date, ts = t.entry_ts, root = t.root, side = t.side;
  if (!hasLegs) {
    const exec = EXEC_FIELDS(req.body || {});
    if (!exec.date || exec.entry == null || exec.exit == null) return res.status(400).json({ error: 'Add a date, entry and exit.' });
    data = { ...data, ...exec };
    date = exec.date; ts = entryTsFor(exec.date, exec.time, s.timezone); root = exec.instr; side = exec.side;
  }
  q.updateTrade.run(date, ts, root, side, t.source, JSON.stringify(data), Date.now(), t.id);
  res.json({ ok: true });
});

app.delete('/api/trades/:id', requireUser, (req, res) => {
  const uid = req.user.id;
  const t = q.tradeById.get(req.params.id, uid);
  if (!t) return res.status(404).json({ error: 'Trade not found.' });
  tx(() => {
    for (const l of q.legsForTrade.all(t.id)) q.ignoreLeg.run(uid, l.external_id); // don't re-import on next sync
    q.deleteTrade.run(t.id, uid);
  });
  res.json({ ok: true });
});

// ---------- accounts ----------
const cleanAccount = b => ({ name: clip(b?.name, 80).trim(), firm: FIRMS.includes(b?.firm) ? b.firm : 'Other', kind: KINDS.includes(b?.kind) ? b.kind : '' });
app.post('/api/accounts', requireUser, (req, res) => {
  const a = cleanAccount(req.body);
  const id = sec.newId('a_');
  q.insertAccount.run(id, req.user.id, a.name, a.firm, a.kind, null, null, null, Date.now());
  res.json({ id });
});
app.put('/api/accounts/:id', requireUser, (req, res) => {
  if (!q.accountById.get(req.params.id, req.user.id)) return res.status(404).json({ error: 'Account not found.' });
  const a = cleanAccount(req.body);
  q.updateAccount.run(a.name, a.firm, a.kind, req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/accounts/:id', requireUser, (req, res) => {
  q.deleteAccount.run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- settings ----------
app.put('/api/settings', requireUser, (req, res) => {
  const b = req.body || {}, cur = getSettings(req.user.id);
  const fees = {};
  for (const [k, v] of Object.entries(b.fees || cur.fees)) if (/^[A-Z0-9]{1,6}$/.test(k)) fees[k] = Math.max(0, +v || 0);
  const next = {
    fees, defaultInstr: clip(b.defaultInstr || cur.defaultInstr, 10),
    theme: ['', 'light', 'dark'].includes(b.theme) ? b.theme : cur.theme,
    timezone: sec.validTz(b.timezone) ? b.timezone : cur.timezone,
  };
  q.putSettings.run(req.user.id, JSON.stringify(next));
  res.json({ ok: true });
});

// ---------- Tradovate ----------
app.get('/api/tradovate/oauth/start', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (!tv.oauthConfigured()) return res.redirect('/app?tv=not-configured#accounts');
  const env = req.query.env === 'live' ? 'live' : 'demo';
  const state = sec.newId();
  q.purgeStates.run(Date.now());
  q.insertState.run(state, req.user.id, env, clip(req.query.label, 60), Date.now() + 10 * 60e3);
  res.redirect(tv.oauthStartUrl(state, REDIRECT_URI));
});

app.get('/api/tradovate/oauth/callback', wrap(async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const st = req.query.state ? q.takeState.get(String(req.query.state)) : null;
  if (!st || st.user_id !== req.user.id || st.expires_at < Date.now()) return res.redirect('/app?tv=bad-state#accounts');
  if (!req.query.code) return res.redirect(`/app?tv=denied#accounts`);
  try {
    const tok = await tv.oauthExchange(String(req.query.code), REDIRECT_URI);
    const id = sec.newId('c_');
    q.insertConnection.run(id, req.user.id, 'oauth', st.env, st.label || (st.env === 'demo' ? 'Prop firm accounts' : 'Live account'),
      null, sec.encrypt({ token: tok.token }), tok.expiresAt, 'ok', Date.now());
    const conn = q.connectionById.get(id, req.user.id);
    tv.syncConnection(conn, getSettings(req.user.id)).catch(e => console.error('initial sync failed:', e.message));
    res.redirect('/app?tv=connected#accounts');
  } catch (e) {
    console.error('oauth exchange failed:', e.message);
    res.redirect(`/app?tv=error&msg=${encodeURIComponent(e.message)}#accounts`);
  }
}));

app.post('/api/tradovate/apikey', requireUser, wrap(async (req, res) => {
  if (!sec.rateLimit(`apikey:${req.user.id}`, 6, 15 * 60e3)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  const b = req.body || {};
  const env = b.env === 'demo' ? 'demo' : 'live';
  const creds = { name: clip(b.name, 100), password: String(b.password || '').slice(0, 200), cid: clip(b.cid, 20), sec: clip(b.sec, 200), deviceId: tv.newDeviceId() };
  if (!creds.name || !creds.password || !creds.cid || !creds.sec) return res.status(400).json({ error: 'Fill in username, password, CID and secret.' });
  let tok;
  try { tok = await tv.apiKeyLogin(env, creds); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const id = sec.newId('c_');
  q.insertConnection.run(id, req.user.id, 'apikey', env, clip(b.label, 60) || 'Tradovate API key', sec.encrypt(creds),
    sec.encrypt({ token: tok.token }), tok.expiresAt, 'ok', Date.now());
  const conn = q.connectionById.get(id, req.user.id);
  try { res.json({ ok: true, result: await tv.syncConnection(conn, getSettings(req.user.id)) }); }
  catch (e) { res.json({ ok: true, warning: `Connected, but the first sync failed: ${e.message}` }); }
}));

app.post('/api/tradovate/connections/:id/sync', requireUser, wrap(async (req, res) => {
  const conn = q.connectionById.get(req.params.id, req.user.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found.' });
  try {
    const r = await tv.syncConnection(conn, getSettings(req.user.id));
    if (r.busy) return res.json({ ok: true, busy: true });
    res.json({ ok: true, result: r });
  } catch (e) { res.status(e instanceof tv.ReconnectNeeded ? 409 : 502).json({ error: e.message }); }
}));

app.delete('/api/tradovate/connections/:id', requireUser, (req, res) => {
  tx(() => {
    q.unlinkConnectionAccounts.run(req.params.id);
    q.deleteConnection.run(req.params.id, req.user.id);
  });
  res.json({ ok: true });
});

// ---------- CSV import ----------
app.post('/api/import/tradovate-csv', requireUser, (req, res) => {
  const uid = req.user.id, s = getSettings(uid);
  const accountId = req.body?.accountId || null;
  if (accountId && !q.accountById.get(accountId, uid)) return res.status(400).json({ error: 'Pick one of your accounts.' });
  if (!accountId) return res.status(400).json({ error: 'Pick which account this export came from.' });
  try {
    const { legs, badRows } = legsFromPerformanceCsv(String(req.body?.csv || ''), {
      accountId, tz: s.timezone, feePerContract: root => Number(s.fees?.[root]) || 0 });
    const r = upsertLegs(uid, legs, s.timezone);
    res.json({ ok: true, result: { ...r, rows: legs.length, badRows } });
  } catch (e) {
    if (e instanceof ImportError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File is too large (10 MB max).' });
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ---------- background sync ----------
async function syncAll() {
  q.purgeSessions.run(Date.now());
  for (const conn of q.activeConnections.all()) {
    try { await tv.syncConnection(conn, getSettings(conn.user_id)); }
    catch (e) { console.warn(`sync ${conn.id}: ${e.message}`); }
  }
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ORB Journal running at ${APP_URL}`);
    if (!tv.oauthConfigured()) console.log('Tradovate OAuth is off (set TRADOVATE_CLIENT_ID and TRADOVATE_CLIENT_SECRET to enable).');
  });
  setTimeout(syncAll, 30e3);
  setInterval(syncAll, SYNC_MINUTES * 60e3);
}

module.exports = app;
