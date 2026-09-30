const { q, tx } = require('./db');
const { newId, partsInTz, wallToUtc } = require('./security');

// Dollar value of a 1.00 price move. Used when Tradovate doesn't return product info, and for CSV imports.
const VALUE_PER_POINT = {
  NQ: 20, MNQ: 2, ES: 50, MES: 5, YM: 5, MYM: 0.5, RTY: 50, M2K: 5,
  CL: 1000, MCL: 100, GC: 100, MGC: 10, SI: 5000, SIL: 1000, NG: 10000,
  ZB: 1000, ZN: 1000, '6E': 125000,
};

// "MNQZ6" -> "MNQ", "NQZ26" -> "NQ", "M2KH7" -> "M2K"
function rootOf(symbol) {
  const s = String(symbol || '').toUpperCase().trim();
  const m = s.match(/^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/);
  return m ? m[1] : s;
}

const MERGE_COPY_MS = 90 * 1000;     // copies across accounts (Tradesyncer) land within this window
const MERGE_MANUAL_MS = 5 * 60 * 1000; // a manually logged trade matches fills within 5 minutes
const DUP_MS = 2000;
const r4 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);
const r2 = v => (v == null || !isFinite(v) ? 0 : Math.round(v * 100) / 100);

function blankTradeData() {
  return { orh: null, orl: null, stop: null, target: null, c15: false, c5: false, c1: false, plan: false,
    grade: '', mistakes: [], emotion: [], notes: '', link: '', reviewed: false };
}

/**
 * legs: [{externalId, source, accountId, symbol, root, side, qty, entry, exit, gross, fees, entryTs, exitTs}]
 * Each leg is one account's round trip. Legs from different accounts that open within 90s on the same
 * instrument and side merge into one journal trade, so a trade copied to 5 accounts journals once.
 */
function upsertLegs(userId, legs, tz) {
  const out = { created: 0, merged: 0, updated: 0, skipped: 0 };
  const touched = new Set();
  const sortedLegs = [...legs].sort((a, b) => a.entryTs - b.entryTs);

  tx(() => {
    for (const L of sortedLegs) {
      if (!L.externalId || !isFinite(L.entryTs) || !(L.qty > 0)) { out.skipped++; continue; }
      if (q.isIgnored.get(userId, L.externalId)) { out.skipped++; continue; }

      const existing = q.legByExt.get(userId, L.externalId);
      if (existing) {
        const changed = existing.qty !== L.qty || existing.entry !== r4(L.entry) || existing.exit !== r4(L.exit) ||
          existing.gross !== r2(L.gross) || existing.fees !== r2(L.fees) || existing.account_id !== (L.accountId || null);
        if (changed) {
          q.updateLeg.run(L.accountId || null, L.qty, r4(L.entry), r4(L.exit), r2(L.gross), r2(L.fees), L.entryTs, L.exitTs, existing.id);
          touched.add(existing.trade_id); out.updated++;
        }
        continue;
      }

      // Same fill already imported another way (e.g. CSV then API sync)
      const dup = q.dupLegs.all(userId, L.accountId || null, L.side, L.entryTs - DUP_MS, L.entryTs + DUP_MS)
        .find(x => x.root === L.root && Math.abs(x.qty - L.qty) < 1e-9);
      if (dup) { out.skipped++; continue; }

      // Find a trade to merge into
      let target = null, best = Infinity;
      for (const t of q.tradesNear.all(userId, L.root, L.side, L.entryTs - MERGE_MANUAL_MS, L.entryTs + MERGE_MANUAL_MS)) {
        const tl = q.legsForTrade.all(t.id);
        const diff = Math.abs(t.entry_ts - L.entryTs);
        const ok = tl.length
          ? diff <= MERGE_COPY_MS && !tl.some(x => x.account_id && x.account_id === L.accountId)
          : diff <= MERGE_MANUAL_MS;
        if (ok && diff < best) { best = diff; target = t; }
      }

      let tradeId;
      if (target) { tradeId = target.id; out.merged++; }
      else {
        tradeId = newId('t_');
        const p = partsInTz(L.entryTs, tz);
        const data = { ...blankTradeData(), date: p.date, time: p.time, instr: L.root, side: L.side, qty: L.qty,
          entry: r4(L.entry), exit: r4(L.exit), accts: [] };
        q.insertTrade.run(tradeId, userId, p.date, L.entryTs, L.root, L.side, L.source, JSON.stringify(data), Date.now());
        out.created++;
      }
      q.insertLeg.run(newId('l_'), userId, tradeId, L.accountId || null, L.externalId, L.source, L.symbol, L.root, L.side,
        L.qty, r4(L.entry), r4(L.exit), r2(L.gross), r2(L.fees), L.entryTs, L.exitTs);
      touched.add(tradeId);
    }
    for (const id of touched) refreshTrade(userId, id, tz);
  });
  return out;
}

// Imported fills are the source of truth for price, size and side. Journal fields stay as the user wrote them.
function refreshTrade(userId, tradeId, tz) {
  const t = q.tradeById.get(tradeId, userId);
  if (!t) return;
  const legs = q.legsForTrade.all(tradeId);
  if (!legs.length) return;
  const lead = legs[0];
  const d = JSON.parse(t.data);
  const p = partsInTz(lead.entry_ts, tz);
  Object.assign(d, { date: p.date, time: p.time, instr: lead.root, side: lead.side, qty: lead.qty,
    entry: lead.entry, exit: lead.exit, accts: [...new Set(legs.map(l => l.account_id).filter(Boolean))] });
  const source = t.source === 'manual' ? lead.source : t.source;
  q.updateTrade.run(p.date, lead.entry_ts, lead.root, lead.side, source, JSON.stringify(d), Date.now(), tradeId);
}

// ---------- CSV ----------
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

function parseMoney(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s.replace(/\$/g, '')) || s.includes('$(') || s.startsWith('-');
  s = s.replace(/[$,()\s-]/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? (neg ? -n : n) : null;
}

function parseTs(v, tz) {
  const s = String(v || '').trim();
  if (!s) return NaN;
  if (/(Z|[+-]\d\d:?\d\d)$/.test(s)) return Date.parse(s);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(AM|PM)?$/i);
  if (m) {
    let [, mo, d, y, h, mi, sec, ap] = m;
    y = +y < 100 ? 2000 + +y : +y; h = +h;
    if (ap) { if (/pm/i.test(ap) && h < 12) h += 12; if (/am/i.test(ap) && h === 12) h = 0; }
    return wallToUtc(y, +mo, +d, h, +mi, +(sec || 0), tz);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return wallToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
  return NaN;
}

class ImportError extends Error {}

/**
 * Tradovate "Performance" report CSV: one row per round turn with
 * symbol, qty, buyPrice, sellPrice, pnl, boughtTimestamp, soldTimestamp (plus other columns we ignore).
 */
function legsFromPerformanceCsv(text, { accountId, tz, feePerContract }) {
  const rows = parseCsv(String(text).replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new ImportError('The file has no trade rows.');
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s_]/g, ''));
  const col = name => header.indexOf(name);
  const need = ['symbol', 'qty', 'buyprice', 'sellprice', 'boughttimestamp', 'soldtimestamp'];
  const missing = need.filter(n => col(n) < 0);
  if (missing.length) {
    throw new ImportError(`This isn't a Tradovate Performance export. Missing columns: ${missing.join(', ')}. ` +
      'In Tradovate go to Reports, then Performance, pick the date range, and download CSV.');
  }
  const pnlCol = col('pnl');
  const fills = [];
  let bad = 0;
  for (const r of rows.slice(1)) {
    const symbol = (r[col('symbol')] || '').trim();
    const qty = parseFloat(r[col('qty')]);
    const bp = parseFloat(String(r[col('buyprice')]).replace(/,/g, ''));
    const sp = parseFloat(String(r[col('sellprice')]).replace(/,/g, ''));
    const bt = parseTs(r[col('boughttimestamp')], tz);
    const st = parseTs(r[col('soldtimestamp')], tz);
    if (!symbol || !(qty > 0) || !isFinite(bp) || !isFinite(sp) || !isFinite(bt) || !isFinite(st)) { bad++; continue; }
    const long = bt <= st;
    const root = rootOf(symbol);
    const entry = long ? bp : sp, exit = long ? sp : bp;
    const pnl = pnlCol >= 0 ? parseMoney(r[pnlCol]) : null;
    const vpp = VALUE_PER_POINT[root];
    const gross = pnl != null ? pnl : vpp != null ? (long ? exit - entry : entry - exit) * qty * vpp : null;
    if (gross == null) { bad++; continue; }
    fills.push({ symbol, root, side: long ? 'long' : 'short', qty, entry, exit, gross,
      entryTs: long ? bt : st, exitTs: long ? st : bt });
  }
  if (!fills.length) throw new ImportError('No rows could be read. Check that the file is a Tradovate Performance CSV.');

  // Scale-outs and partial fills of one entry arrive as several rows: group rows that opened within 2s
  fills.sort((a, b) => a.entryTs - b.entryTs);
  const groups = [];
  for (const f of fills) {
    const g = groups.find(x => x.symbol === f.symbol && x.side === f.side && f.entryTs - x.entryTs <= 2000 && !x.closed);
    if (g) {
      g.enSum += f.entry * f.qty; g.exSum += f.exit * f.qty; g.qty += f.qty; g.gross += f.gross;
      g.exitTs = Math.max(g.exitTs, f.exitTs);
    } else {
      groups.forEach(x => { if (f.entryTs - x.entryTs > 2000) x.closed = true; });
      groups.push({ ...f, enSum: f.entry * f.qty, exSum: f.exit * f.qty });
    }
  }
  const legs = groups.map(g => ({
    externalId: `csv:${accountId}:${g.symbol}:${g.side}:${g.entryTs}`,
    source: 'csv', accountId, symbol: g.symbol, root: g.root, side: g.side, qty: g.qty,
    entry: g.enSum / g.qty, exit: g.exSum / g.qty, gross: g.gross,
    fees: (feePerContract(g.root) || 0) * g.qty, entryTs: g.entryTs, exitTs: g.exitTs,
  }));
  return { legs, badRows: bad };
}

module.exports = { upsertLegs, legsFromPerformanceCsv, rootOf, VALUE_PER_POINT, ImportError, blankTradeData };
