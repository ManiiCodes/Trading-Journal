const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

// ---------- ids ----------
const newId = (prefix = '') => prefix + crypto.randomBytes(12).toString('base64url');

// ---------- passwords (scrypt, no native deps) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `s1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [v, s, h] = String(stored).split('$');
  if (v !== 's1' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(s, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- encryption at rest for broker tokens/credentials ----------
function loadKey() {
  if (process.env.APP_SECRET) {
    if (process.env.APP_SECRET.length < 32) throw new Error('APP_SECRET must be at least 32 characters');
    return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  }
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}
const KEY = loadKey();
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
function decrypt(str) {
  if (!str) return null;
  const [v, iv, tag, ct] = str.split('.');
  if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
}

// ---------- simple in-memory rate limiter ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 10000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  return b.count <= max;
}

// ---------- timezone helpers ----------
function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function partsInTz(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second,
    date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function tzOffset(ms, tz) {
  const p = partsInTz(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
// Wall-clock time in `tz` -> epoch ms
function wallToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  const off1 = tzOffset(guess, tz);
  let ms = guess - off1;
  const off2 = tzOffset(ms, tz);
  if (off2 !== off1) ms = guess - off2;
  return ms;
}

module.exports = { newId, hashPassword, verifyPassword, encrypt, decrypt, rateLimit, validTz, partsInTz, wallToUtc };
