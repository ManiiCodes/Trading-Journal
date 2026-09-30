const crypto = require('crypto');
const { q } = require('./db');
const { newId, encrypt, decrypt } = require('./security');
const { upsertLegs, rootOf, VALUE_PER_POINT } = require('./importer');

const BASES = {
  demo: process.env.TRADOVATE_DEMO_URL || 'https://demo.tradovateapi.com/v1',
  live: process.env.TRADOVATE_LIVE_URL || 'https://live.tradovateapi.com/v1',
};
const AUTH_URL = process.env.TRADOVATE_AUTH_URL || 'https://trader.tradovate.com/oauth';
const TOKEN_URL = process.env.TRADOVATE_OAUTH_TOKEN_URL || 'https://live.tradovateapi.com/auth/oauthtoken';
const CLIENT_ID = process.env.TRADOVATE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TRADOVATE_CLIENT_SECRET || '';
const oauthConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

const sleep = ms => new Promise(r => setTimeout(r, ms));

class TvError extends Error {
  constructor(message, { status, auth } = {}) { super(message); this.status = status; this.auth = !!auth; }
}

async function request(url, { token, method = 'GET', body } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      if (attempt === 2) throw new TvError(`Couldn't reach Tradovate (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
      await sleep(1000 * (attempt + 1)); continue;
    }
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (res.status === 401) throw new TvError('Tradovate rejected the access token', { status: 401, auth: true });
    if (!res.ok) throw new TvError(`Tradovate request failed (${res.status})${data?.errorText ? `: ${data.errorText}` : ''}`, { status: res.status });
    return data;
  }
  throw new TvError('Tradovate is rate limiting requests. Try again in a minute.', { status: 429 });
}
const api = (env, path, token) => request(BASES[env] + path, { token });

async function items(env, path, ids, token) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await api(env, `${path}?ids=${chunk.join(',')}`, token);
    if (Array.isArray(res)) out.push(...res);
    if (i + 100 < ids.length) await sleep(150);
  }
  return out;
}

// ---------- auth ----------
function oauthStartUrl(state, redirectUri) {
  const u = new URL(AUTH_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

async function oauthExchange(code, redirectUri) {
  const data = await request(TOKEN_URL, { method: 'POST', body: {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
  const token = data?.access_token || data?.accessToken;
  if (!token) throw new TvError(`Tradovate didn't return an access token${data?.error ? ` (${data.error})` : ''}`);
  const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000
    : data.expirationTime ? Date.parse(data.expirationTime) : Date.now() + 80 * 60 * 1000;
  return { token, expiresAt };
}

async function apiKeyLogin(env, creds) {
  const body = { name: creds.name, password: creds.password, appId: 'ORB Journal', appVersion: '1.0',
    cid: Number(creds.cid), sec: creds.sec, deviceId: creds.deviceId };
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await request(BASES[env] + '/auth/accessTokenRequest', { method: 'POST', body });
    if (data?.['p-ticket']) {
      if (data['p-captcha']) throw new TvError('Tradovate wants a captcha for this login. Sign in to Tradovate in a browser once, then try again.');
      await sleep((data['p-time'] || 5) * 1000);
      body['p-ticket'] = data['p-ticket'];
      continue;
    }
    if (data?.errorText) throw new TvError(`Tradovate login failed: ${data.errorText}`);
    if (!data?.accessToken) throw new TvError('Tradovate login failed: no access token returned');
    return { token: data.accessToken, expiresAt: Date.parse(data.expirationTime) || Date.now() + 80 * 60 * 1000 };
  }
  throw new TvError('Tradovate is throttling logins. Wait a minute and try again.');
}

async function renew(env, token) {
  const data = await api(env, '/auth/renewAccessToken', token);
  if (!data?.accessToken) throw new TvError('Token renewal failed', { auth: true });
  return { token: data.accessToken, expiresAt: Date.parse(data.expirationTime) || Date.now() + 80 * 60 * 1000 };
}

function storeToken(conn, t) {
  const enc = encrypt({ token: t.token });
  q.saveToken.run(enc, t.expiresAt, conn.id);
  conn.enc_token = enc; conn.token_expires = t.expiresAt;
  return t.token;
}

class ReconnectNeeded extends Error {}

async function ensureToken(conn, { force = false } = {}) {
  const current = decrypt(conn.enc_token);
  const left = (conn.token_expires || 0) - Date.now();
  if (current && !force && left > 30 * 60 * 1000) return current.token;
  if (current && !force && left > 15 * 1000) {
    try { return storeToken(conn, await renew(conn.env, current.token)); }
    catch (e) { if (!e.auth) throw e; }
  }
  if (conn.method === 'apikey') return storeToken(conn, await apiKeyLogin(conn.env, decrypt(conn.enc_creds)));
  throw new ReconnectNeeded('Tradovate session expired. Reconnect this account.');
}

// ---------- sync ----------
function feeTotal(f) {
  return ['commission', 'clearingFee', 'exchangeFee', 'nfaFee', 'brokerageFee', 'ipFee', 'orderRoutingFee']
    .reduce((s, k) => s + (Number(f?.[k]) || 0), 0);
}

async function contractInfo(env, ids, token) {
  const out = new Map();
  if (!ids.length) return out;
  const contracts = await items(env, '/contract/items', ids, token);
  let vppByMaturity = new Map();
  try {
    const mats = await items(env, '/contractMaturity/items', [...new Set(contracts.map(c => c.contractMaturityId).filter(Boolean))], token);
    const products = await items(env, '/product/items', [...new Set(mats.map(m => m.productId).filter(Boolean))], token);
    const vppByProduct = new Map(products.map(p => [p.id, Number(p.valuePerPoint) || null]));
    vppByMaturity = new Map(mats.map(m => [m.id, vppByProduct.get(m.productId) ?? null]));
  } catch (e) { if (e.auth) throw e; /* fall back to the built-in table */ }
  for (const c of contracts) {
    out.set(c.id, { name: c.name, vpp: vppByMaturity.get(c.contractMaturityId) ?? VALUE_PER_POINT[rootOf(c.name)] ?? null });
  }
  return out;
}

async function pullLegs(conn, token, settings) {
  const env = conn.env, userId = conn.user_id;

  // Accounts: create or relink a journal account for each Tradovate account
  const tvAccounts = (await api(env, '/account/list', token)) || [];
  const acctMap = new Map();
  for (const a of tvAccounts) {
    let row = q.accountByTv.get(userId, env, a.id);
    if (!row) {
      const id = newId('a_');
      q.insertAccount.run(id, userId, a.name || `Tradovate ${a.id}`, 'Other', '', conn.id, env, a.id, Date.now());
      row = { id };
    } else if (row.connection_id !== conn.id) q.relinkAccount.run(conn.id, row.id);
    acctMap.set(a.id, row.id);
  }

  const pairs = (await api(env, '/fillPair/list', token)) || [];
  if (!pairs.length) return { accounts: tvAccounts.length, legs: [] };

  const positions = new Map(((await api(env, '/position/list', token)) || []).map(p => [p.id, p]));
  const missingPos = [...new Set(pairs.map(p => p.positionId))].filter(id => id != null && !positions.has(id));
  if (missingPos.length) (await items(env, '/position/items', missingPos, token)).forEach(p => positions.set(p.id, p));

  const fillIds = [...new Set(pairs.flatMap(p => [p.buyFillId, p.sellFillId]))].filter(Boolean);
  const fills = new Map((await items(env, '/fill/items', fillIds, token)).map(f => [f.id, f]));
  const fees = new Map();
  try { (await items(env, '/fillFee/items', fillIds, token)).forEach(f => fees.set(f.id, feeTotal(f))); }
  catch (e) { if (e.auth) throw e; }

  const contracts = await contractInfo(env, [...new Set([...fills.values()].map(f => f.contractId))], token);

  // One leg per account + contract + entry order (partial fills and scale-outs roll up)
  const groups = new Map();
  for (const p of pairs) {
    const b = fills.get(p.buyFillId), s = fills.get(p.sellFillId);
    const pos = positions.get(p.positionId);
    if (!b || !s || !pos || !(p.qty > 0)) continue;
    const bT = Date.parse(b.timestamp), sT = Date.parse(s.timestamp);
    const long = bT <= sT;
    const en = long ? b : s;
    const enPx = long ? p.buyPrice : p.sellPrice, exPx = long ? p.sellPrice : p.buyPrice;
    const c = contracts.get(en.contractId) || { name: String(en.contractId), vpp: null };
    const root = rootOf(c.name);
    const vpp = c.vpp ?? VALUE_PER_POINT[root] ?? 0;
    const key = `${pos.accountId}:${en.contractId}:${en.orderId}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, tvAccountId: pos.accountId, symbol: c.name, root, side: long ? 'long' : 'short',
        qty: 0, enSum: 0, exSum: 0, gross: 0, fees: 0, feesMissing: false, entryTs: Infinity, exitTs: 0 };
      groups.set(key, g);
    }
    g.qty += p.qty; g.enSum += enPx * p.qty; g.exSum += exPx * p.qty;
    g.gross += (long ? exPx - enPx : enPx - exPx) * p.qty * vpp;
    const fb = fees.get(b.id), fs = fees.get(s.id);
    if (fb != null && fs != null && b.qty > 0 && s.qty > 0) g.fees += (fb / b.qty + fs / s.qty) * p.qty;
    else g.feesMissing = true;
    g.entryTs = Math.min(g.entryTs, long ? bT : sT);
    g.exitTs = Math.max(g.exitTs, long ? sT : bT);
  }

  const legs = [...groups.values()].map(g => ({
    externalId: `tv:${env}:${g.key}`, source: 'tradovate', accountId: acctMap.get(g.tvAccountId) || null,
    symbol: g.symbol, root: g.root, side: g.side, qty: g.qty,
    entry: g.enSum / g.qty, exit: g.exSum / g.qty, gross: g.gross,
    fees: g.feesMissing ? (Number(settings.fees?.[g.root]) || 0) * g.qty : g.fees,
    entryTs: g.entryTs, exitTs: g.exitTs,
  }));
  return { accounts: tvAccounts.length, legs };
}

const running = new Set();
async function syncConnection(conn, settings) {
  if (running.has(conn.id)) return { busy: true };
  running.add(conn.id);
  try {
    let token = await ensureToken(conn);
    let pulled;
    try { pulled = await pullLegs(conn, token, settings); }
    catch (e) {
      if (!e.auth) throw e;
      token = await ensureToken(conn, { force: true }); // API-key logins re-authenticate; OAuth asks to reconnect
      pulled = await pullLegs(conn, token, settings);
    }
    const result = upsertLegs(conn.user_id, pulled.legs, settings.timezone);
    q.markSynced.run(Date.now(), conn.id);
    return { accounts: pulled.accounts, fills: pulled.legs.length, ...result };
  } catch (e) {
    const reconnect = e instanceof ReconnectNeeded;
    q.setConnStatus.run(reconnect ? 'reconnect' : 'error', e.message, conn.id);
    throw e;
  } finally {
    running.delete(conn.id);
  }
}

function newDeviceId() { return crypto.randomUUID(); }

module.exports = { oauthConfigured, oauthStartUrl, oauthExchange, apiKeyLogin, storeToken, syncConnection,
  newDeviceId, TvError, ReconnectNeeded };
