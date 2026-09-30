(() => {
const INSTR = { NQ: { mult: 20, name: 'NQ ($20/pt)' }, MNQ: { mult: 2, name: 'MNQ ($2/pt)' }, ES: { mult: 50, name: 'ES ($50/pt)' },
  MES: { mult: 5, name: 'MES ($5/pt)' }, YM: { mult: 5, name: 'YM ($5/pt)' }, MYM: { mult: 0.5, name: 'MYM ($0.50/pt)' },
  RTY: { mult: 50, name: 'RTY ($50/pt)' }, M2K: { mult: 5, name: 'M2K ($5/pt)' }, CL: { mult: 1000, name: 'CL ($1,000/pt)' },
  MCL: { mult: 100, name: 'MCL ($100/pt)' }, GC: { mult: 100, name: 'GC ($100/pt)' }, MGC: { mult: 10, name: 'MGC ($10/pt)' } };
const MISTAKES = ['Entered before OR closed', 'No 5m/1m confluence', 'Chased entry', 'Moved stop', 'Oversized', 'Cut winner early', 'Held past stop', 'Revenge trade', 'Overtraded'];
const EMOTIONS = ['Calm', 'Focused', 'Hesitant', 'FOMO', 'Frustrated', 'Tired', 'Overconfident'];
const TIMEZONES = ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'Europe/London', 'UTC'];
const $ = id => document.getElementById(id);

let state = { user: {}, trades: [], accounts: [], connections: [], settings: { fees: {}, defaultInstr: 'NQ', theme: '', timezone: 'America/Chicago' },
  tradovate: { oauth: false }, options: { firms: [], kinds: [] } };
let editing = null, calMonth = new Date();

/* ---------- API ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'fetch', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
async function load() {
  state = await api('/api/state');
  renderAll();
}

/* ---------- helpers ---------- */
const num = v => (v === '' || v == null || isNaN(+v) ? null : +v);
const money = v => {
  const n = Math.round(Math.abs(v || 0) * 100) / 100;
  return (v < 0 && n ? '−$' : '$') + n.toLocaleString(undefined, { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
};
const fmtPts = v => (v > 0 ? '+' : '') + (Math.round(v * 100) / 100);
const cls = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const tz = () => state.settings.timezone || 'America/Chicago';
const isoInTz = d => new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const todayISO = () => isoInTz(new Date());
const dayDate = s => new Date(s + 'T12:00:00');
const acctName = id => { const a = state.accounts.find(x => x.id === id); return a ? (a.name || 'Unnamed') : 'Unassigned'; };
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function busy(btn, on, label) { if (!btn) return; if (on) { btn._t = btn.textContent; btn.textContent = label || 'Working…'; btn.disabled = true; } else { btn.textContent = btn._t || btn.textContent; btn.disabled = false; } }

/* P&L. Synced trades use real per-account fills; manual trades use entry/exit × accounts. */
function calc(t, acct) {
  const legsAll = t.legs || [];
  if (legsAll.length) {
    const legs = acct ? legsAll.filter(l => l.account_id === acct) : legsAll;
    const lead = legsAll[0];
    const pts = lead.side === 'short' ? lead.entry - lead.exit : lead.exit - lead.entry;
    const risk = t.stop != null ? Math.abs(lead.entry - t.stop) : null;
    const nets = legs.map(l => l.gross - l.fees);
    const total = nets.reduce((a, b) => a + b, 0);
    const fee = legs.length ? legs.reduce((a, l) => a + l.fees, 0) / legs.length : 0;
    return { pts, net: legs.length ? total / legs.length : 0, total, fee, r: risk ? pts / risk : null, n: legs.length };
  }
  const mult = INSTR[t.instr]?.mult || 20, qty = t.qty || 1;
  if (t.entry == null || t.exit == null) return null;
  const pts = t.side === 'short' ? t.entry - t.exit : t.exit - t.entry;
  const fee = (+(state.settings.fees?.[t.instr]) || 0) * qty, net = pts * mult * qty - fee;
  const risk = t.stop != null ? Math.abs(t.entry - t.stop) : null;
  const n = acct ? 1 : Math.max(1, (t.accts || []).length);
  return { pts, net, fee, r: risk ? pts / risk : null, total: net * n, n };
}
const tradeAccts = t => (t.legs && t.legs.length ? [...new Set(t.legs.map(l => l.account_id).filter(Boolean))] : (t.accts || []));
const needsReview = t => (t.legs && t.legs.length) && !t.reviewed;

/* ---------- form ---------- */
const form = { side: 'long', grade: '', accts: [], mistakes: [], emotion: [] };
function buildForm() {
  const opts = Object.entries(INSTR).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  $('f_instr').innerHTML = opts; $('defInstr').innerHTML = opts;
  $('tzSel').innerHTML = TIMEZONES.map(z => `<option>${z}</option>`).join('');
  $('f_mistakes').innerHTML = MISTAKES.map(m => `<button type="button" class="chip bad" data-v="${esc(m)}">${esc(m)}</button>`).join('');
  $('f_emotion').innerHTML = EMOTIONS.map(m => `<button type="button" class="chip" data-v="${esc(m)}">${esc(m)}</button>`).join('');
  seg('f_side', 'side'); seg('f_grade', 'grade', true);
  chipGroup('f_mistakes', 'mistakes'); chipGroup('f_emotion', 'emotion'); chipGroup('f_accts', 'accts');
  document.querySelectorAll('#tradeForm input,#tradeForm select').forEach(el => el.addEventListener('input', preview));
  $('tradeForm').addEventListener('submit', e => { e.preventDefault(); saveTrade(); });
  $('resetBtn').onclick = () => fillForm(null); $('deleteBtn').onclick = deleteTrade;
}
function seg(id, key, toggle) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    form[key] = toggle && form[key] === b.dataset.v ? '' : b.dataset.v; paintSeg(id, form[key]); preview();
  });
}
function paintSeg(id, v) { $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
function chipGroup(id, key) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = form[key], i = a.indexOf(b.dataset.v);
    i >= 0 ? a.splice(i, 1) : a.push(b.dataset.v); b.classList.toggle('on', i < 0); preview();
  });
}
function paintChips(id, arr) { $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', arr.includes(b.dataset.v))); }
function renderAcctChips() {
  const a = state.accounts;
  $('f_accts').innerHTML = a.map(x => `<button type="button" class="chip" data-v="${esc(x.id)}">${esc(x.name || 'Unnamed')} <span style="opacity:.65">${esc(x.kind)}</span></button>`).join('');
  $('acctHint').textContent = a.length ? 'Pick every account Tradesyncer copied this into.' : 'No accounts yet. Add them on the Accounts & Tradovate tab, or log without one.';
  form.accts = form.accts.filter(id => a.some(x => x.id === id)); paintChips('f_accts', form.accts);
}
const currentTrade = () => (editing ? state.trades.find(t => t.id === editing) : null);
function readForm() {
  return { date: $('f_date').value, time: $('f_time').value, instr: $('f_instr').value, qty: Math.max(1, parseInt($('f_qty').value) || 1),
    side: form.side, orh: num($('f_orh').value), orl: num($('f_orl').value), entry: num($('f_entry').value), stop: num($('f_stop').value),
    target: num($('f_target').value), exit: num($('f_exit').value), c15: $('f_c15').checked, c5: $('f_c5').checked, c1: $('f_c1').checked,
    plan: $('f_plan').checked, grade: form.grade, accts: [...form.accts], mistakes: [...form.mistakes], emotion: [...form.emotion],
    notes: $('f_notes').value.trim(), link: $('f_link').value.trim() };
}
function fillForm(t) {
  editing = t ? t.id : null;
  const synced = !!(t && t.legs && t.legs.length);
  $('formTitle').textContent = !t ? 'New trade' : synced ? `Review ${t.source === 'csv' ? 'imported' : 'synced'} trade` : 'Edit trade';
  $('deleteBtn').hidden = !t;
  $('f_date').value = t?.date || todayISO(); $('f_time').value = t?.time || '';
  $('f_instr').value = INSTR[t?.instr] ? t.instr : (t?.instr ? 'NQ' : state.settings.defaultInstr || 'NQ');
  $('f_qty').value = t?.qty || 1;
  ['orh', 'orl', 'entry', 'stop', 'target', 'exit'].forEach(k => ($('f_' + k).value = t?.[k] ?? ''));
  ['c15', 'c5', 'c1', 'plan'].forEach(k => ($('f_' + k).checked = !!t?.[k]));
  $('f_notes').value = t?.notes || ''; $('f_link').value = t?.link || '';
  Object.assign(form, { side: t?.side || 'long', grade: t?.grade || '', accts: [...(t?.accts || [])], mistakes: [...(t?.mistakes || [])], emotion: [...(t?.emotion || [])] });
  ['f_date', 'f_time', 'f_instr', 'f_qty', 'f_entry', 'f_exit'].forEach(id => ($(id).disabled = synced));
  $('f_side').querySelectorAll('button').forEach(b => (b.disabled = synced));
  $('acctBlock').hidden = synced; $('fillsBox').hidden = !synced;
  if (synced) {
    $('fillsBody').innerHTML = t.legs.map(l => `<tr><td>${esc(acctName(l.account_id))}</td><td>${esc(l.symbol)}</td><td class="num">${l.qty}</td>
      <td class="num">${l.entry}</td><td class="num">${l.exit}</td><td class="num">${money(l.fees)}</td><td class="num ${cls(l.gross - l.fees)}">${money(l.gross - l.fees)}</td></tr>`).join('');
  }
  paintSeg('f_side', form.side); paintSeg('f_grade', form.grade);
  renderAcctChips(); paintChips('f_mistakes', form.mistakes); paintChips('f_emotion', form.emotion); preview();
}
async function saveTrade() {
  const t = readForm();
  const synced = currentTrade()?.legs?.length;
  if (!synced && (!t.date || t.entry == null || t.exit == null)) { toast('Add a date, entry and exit to save'); return; }
  const btn = $('saveBtn'); busy(btn, true, 'Saving…');
  try {
    if (editing) await api(`/api/trades/${editing}`, { method: 'PUT', body: t });
    else await api('/api/trades', { method: 'POST', body: t });
    toast(editing ? 'Trade updated' : 'Trade saved');
    editing = null; await load(); fillForm(null);
  } catch (e) { toast(e.message); } finally { busy(btn, false); }
}
async function deleteTrade() {
  const t = currentTrade(); if (!t) return;
  const msg = t.legs?.length ? "Delete this trade? Its fills won't be imported again on the next sync." : "Delete this trade? This can't be undone.";
  if (!confirm(msg)) return;
  try { await api(`/api/trades/${t.id}`, { method: 'DELETE' }); toast('Trade deleted'); editing = null; await load(); fillForm(null); }
  catch (e) { toast(e.message); }
}

/* ticket preview */
function preview() {
  const base = currentTrade();
  const t = { ...readForm(), ...(base?.legs?.length ? { legs: base.legs, entry: base.entry, exit: base.exit, side: base.side } : {}) };
  const size = t.orh != null && t.orl != null ? Math.abs(t.orh - t.orl) : null;
  $('f_orsize').value = size != null ? size.toFixed(2) + ' pts' : '';
  const c = calc(t);
  $('r_pts').textContent = c ? fmtPts(c.pts) : '–'; $('r_pts').className = c ? cls(c.pts) : '';
  $('r_r').textContent = c && c.r != null ? (c.r > 0 ? '+' : '') + c.r.toFixed(2) + 'R' : '–'; $('r_r').className = c && c.r != null ? cls(c.r) : '';
  $('r_net').textContent = c ? money(c.net) : '–'; $('r_net').className = c ? cls(c.net) : '';
  $('r_tot').textContent = c ? money(c.total) : '–'; $('r_tot').className = c ? cls(c.total) : '';
  $('r_fee').textContent = c ? `${c.n} account${c.n > 1 ? 's' : ''} · fees ${money(c.fee)} per account${t.legs ? ' · from fills' : ''}` : 'Fill in entry and exit to see the result.';
  drawTicket(t);
}
function drawTicket(t) {
  const svg = $('ticketSvg'), H = 260, top = 18, bot = H - 18, x0 = 10, x1 = 150;
  const vals = [t.orh, t.orl, t.entry, t.stop, t.target, t.exit].filter(v => v != null);
  const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
  if (!vals.length) {
    svg.innerHTML = `<rect x="${x0}" y="${top + 60}" width="${x1 - x0}" height="90" fill="${col('--or-soft')}" stroke="${col('--or')}" stroke-dasharray="4 4"/><text x="${(x0 + x1) / 2}" y="${top + 110}" text-anchor="middle" font-size="12" fill="${col('--muted')}">Enter OR high/low</text>`;
    return;
  }
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = Math.max((hi - lo) * 0.12, 2); lo -= pad; hi += pad;
  const y = v => top + (hi - v) / (hi - lo) * (bot - top);
  const lab = (yy, name, v, c) => `<text x="${x1 + 6}" y="${yy - 2}" font-size="10" fill="${col('--muted')}">${name}</text><text x="${x1 + 6}" y="${yy + 10}" font-size="11" font-weight="700" fill="${c}">${v}</text>`;
  let s = '';
  if (t.orh != null && t.orl != null) {
    const a = y(Math.max(t.orh, t.orl)), b = y(Math.min(t.orh, t.orl));
    s += `<rect x="${x0}" y="${a}" width="${x1 - x0}" height="${Math.max(1, b - a)}" fill="${col('--or-soft')}" stroke="${col('--or')}"/>`;
    s += lab(a, 'OR high', t.orh, col('--or')) + lab(b, 'OR low', t.orl, col('--or'));
  }
  const line = (v, name, c, dash) => v == null ? '' : `<line x1="${x0}" x2="${x1}" y1="${y(v)}" y2="${y(v)}" stroke="${c}" stroke-width="2" ${dash ? 'stroke-dasharray="5 4"' : ''}/>` + lab(y(v), name, v, c);
  s += line(t.stop, 'Stop', col('--loss'), 1) + line(t.target, 'Target', col('--gain'), 1) + line(t.entry, 'Entry', col('--ink'), 0);
  if (t.entry != null && t.exit != null) {
    const good = (t.side === 'short' ? t.entry - t.exit : t.exit - t.entry) >= 0, c = good ? col('--gain') : col('--loss');
    s += `<line x1="${x1 - 24}" x2="${x1 - 24}" y1="${y(t.entry)}" y2="${y(t.exit)}" stroke="${c}" stroke-width="3"/><circle cx="${x1 - 24}" cy="${y(t.exit)}" r="5" fill="${c}"/>` + lab(y(t.exit), 'Exit', t.exit, c);
  }
  svg.innerHTML = s;
}

/* ---------- filters ---------- */
function acctOptions(sel, withAll = true) {
  const cur = $(sel).value;
  $(sel).innerHTML = (withAll ? '<option value="">All accounts</option>' : '') +
    state.accounts.map(x => `<option value="${esc(x.id)}">${esc(x.name || 'Unnamed')}${x.firm && x.firm !== 'Other' ? ` (${esc(x.firm)}${x.kind ? ' ' + esc(x.kind) : ''})` : ''}</option>`).join('');
  if ([...$(sel).options].some(o => o.value === cur)) $(sel).value = cur;
}
const sorted = ts => [...ts].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));

/* ---------- journal ---------- */
function renderJournal() {
  const acct = $('j_acct').value, show = $('j_show').value, from = $('j_from').value, to = $('j_to').value;
  const rows = sorted(state.trades).reverse().filter(t => (!acct || tradeAccts(t).includes(acct)) && (!from || t.date >= from) && (!to || t.date <= to) && (show !== 'review' || needsReview(t)));
  $('j_body').innerHTML = rows.length ? rows.map(t => {
    const c = calc(t, acct) || {};
    const tags = [needsReview(t) ? '<span class="badge review">Needs review</span> ' : '',
      ...(t.mistakes || []).map(m => `<span class="tag warn">${esc(m)}</span>`),
      !(t.c5 && t.c1) && !needsReview(t) ? '<span class="tag">partial confluence</span>' : ''].join('');
    return `<tr data-id="${esc(t.id)}"><td>${esc(t.date)}</td><td>${esc(t.time || '')}</td><td>${esc(t.instr)}</td><td class="${t.side === 'long' ? 'pos' : 'neg'}">${t.side === 'long' ? 'Long' : 'Short'}</td>
    <td class="num">${t.qty}</td><td class="num">${t.entry}</td><td class="num">${t.exit}</td><td class="num ${cls(c.pts)}">${c.pts != null ? fmtPts(c.pts) : ''}</td>
    <td class="num">${c.r != null ? c.r.toFixed(2) : ''}</td><td class="num ${cls(c.net)}">${c.net != null ? money(c.net) : ''}</td>
    <td class="num" title="${esc(tradeAccts(t).map(acctName).join(', '))}">${tradeAccts(t).length || '–'}</td><td>${esc(t.grade || '')}</td><td>${tags}</td></tr>`;
  }).join('') : `<tr><td colspan="13" class="empty">${state.trades.length ? 'No trades match these filters.' : 'No trades yet. Log one, connect Tradovate, or import a CSV.'}</td></tr>`;
  const n = state.trades.filter(needsReview).length;
  $('reviewCount').hidden = !n; $('reviewCount').textContent = n;
}
$('j_body').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const t = state.trades.find(x => x.id === tr.dataset.id); if (!t) return;
  fillForm(t); showTab('log'); scrollTo({ top: 0 });
});

/* ---------- stats ---------- */
function statTrades() {
  const acct = $('s_acct').value, range = $('s_range').value; let from = '';
  if (range === '7' || range === '30') from = isoInTz(new Date(Date.now() - (+range - 1) * 864e5));
  if (range === 'month') from = todayISO().slice(0, 8) + '01';
  return sorted(state.trades).filter(t => (!acct || tradeAccts(t).includes(acct)) && (!from || t.date >= from));
}
function pnl(t) {
  const acct = $('s_acct').value;
  const c = calc(t, acct || undefined); if (!c) return 0;
  return acct || $('s_basis').value === 'per' ? c.net : c.total;
}
function summarize(ts) {
  const v = ts.map(pnl), w = v.filter(x => x > 0), l = v.filter(x => x < 0);
  const gw = w.reduce((a, b) => a + b, 0), gl = Math.abs(l.reduce((a, b) => a + b, 0));
  const rs = ts.map(t => calc(t)?.r).filter(r => r != null);
  return { n: v.length, net: gw - gl, wr: v.length ? w.length / v.length : null, pf: gl ? gw / gl : (gw ? Infinity : null),
    aw: w.length ? gw / w.length : 0, al: l.length ? -gl / l.length : 0, exp: v.length ? (gw - gl) / v.length : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null };
}
function daily(ts) { const m = {}; ts.forEach(t => (m[t.date] = (m[t.date] || 0) + pnl(t))); return m; }
function renderStats() {
  const ts = statTrades(), S = summarize(ts), D = daily(ts), days = Object.keys(D).sort();
  let peak = 0, cum = 0, dd = 0; days.forEach(d => { cum += D[d]; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); });
  const green = days.filter(d => D[d] > 0), best = green.length ? Math.max(...green.map(d => D[d])) : 0, totalGreen = green.reduce((a, d) => a + D[d], 0);
  const k = (label, val, sub, c = '') => `<div class="kpi"><span>${label}</span><b class="${c}">${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  $('kpis').innerHTML = S.n ? [
    k('Net P&L', money(S.net), `${S.n} trades · ${days.length} days`, cls(S.net)),
    k('Win rate', (S.wr * 100).toFixed(0) + '%', ''),
    k('Profit factor', S.pf === Infinity ? '∞' : S.pf.toFixed(2), 'gross win ÷ gross loss'),
    k('Expectancy', money(S.exp), 'per trade', cls(S.exp)),
    k('Avg win / loss', `${money(S.aw)} / ${money(S.al)}`, S.al ? `ratio ${(S.aw / Math.abs(S.al)).toFixed(2)}` : ''),
    k('Avg R', S.avgR != null ? S.avgR.toFixed(2) + 'R' : '–', 'trades with a stop logged', S.avgR != null ? cls(S.avgR) : ''),
    k('Max drawdown', money(dd), 'peak-to-trough, end of day', dd < 0 ? 'neg' : ''),
    k('Best day share', totalGreen ? ((best / totalGreen) * 100).toFixed(0) + '%' : '–', "best day ÷ all green days; compare to your firm's consistency rule"),
  ].join('') : '<div class="kpi" style="grid-column:1/-1"><span>No trades in this range yet.</span></div>';
  drawEquity(days, D); drawCal(D); drawEdge(ts); drawDow(ts); drawMistakes(ts);
}
function drawEquity(days, D) {
  const svg = $('equity'), W = 600, H = 220, p = 44, css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
  if (!days.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${col('--muted')}" font-size="14">Log trades to draw your curve</text>`; return; }
  let c = 0; const pts = [0, ...days.map(d => (c += D[d]))]; const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), rng = hi - lo || 1;
  const x = i => p + i * (W - p - 10) / Math.max(1, pts.length - 1), y = v => 10 + (hi - v) / rng * (H - 40);
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = pts[pts.length - 1], lc = last >= 0 ? col('--gain') : col('--loss');
  svg.innerHTML = `<line x1="${p}" x2="${W - 10}" y1="${y(0)}" y2="${y(0)}" stroke="${col('--line')}"/>
   <text x="${p - 4}" y="${y(hi) + 4}" text-anchor="end" font-size="11" fill="${col('--muted')}">${money(Math.round(hi))}</text>
   <text x="${p - 4}" y="${y(lo) + 4}" text-anchor="end" font-size="11" fill="${col('--muted')}">${money(Math.round(lo))}</text>
   <path d="${path}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="${last >= 0 ? col('--gain-soft') : col('--loss-soft')}"/>
   <path d="${path}" fill="none" stroke="${lc}" stroke-width="2.5" stroke-linejoin="round"/>
   <text x="${p}" y="${H - 6}" font-size="11" fill="${col('--muted')}">${days[0]}</text><text x="${W - 10}" y="${H - 6}" text-anchor="end" font-size="11" fill="${col('--muted')}">${days[days.length - 1]}</text>`;
}
function drawCal(D) {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $('calTitle').textContent = calMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const first = new Date(y, m, 1).getDay(), n = new Date(y, m + 1, 0).getDate();
  let h = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < first; i++) h += '<div class="d blank"></div>';
  for (let d = 1; d <= n; d++) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, v = D[key];
    h += `<div class="d ${v > 0 ? 'up' : v < 0 ? 'dn' : ''}"><span>${d}</span>${v != null ? `<b class="${cls(v)}">${money(Math.round(v))}</b>` : ''}</div>`;
  }
  $('cal').innerHTML = h;
}
function drawEdge(ts) {
  const rows = [['Full confluence (5m + 1m)', t => t.c5 && t.c1], ['Missing confluence', t => !(t.c5 && t.c1)], ['Followed plan', t => t.plan], ['Broke plan', t => !t.plan],
    ['Grade A', t => t.grade === 'A'], ['Grade B', t => t.grade === 'B'], ['Grade C', t => t.grade === 'C'], ['Longs', t => t.side === 'long'], ['Shorts', t => t.side === 'short']];
  const reviewed = ts.filter(t => !needsReview(t));
  const body = rows.map(([l, f]) => {
    const pool = /confluence|plan|Grade/.test(l) ? reviewed : ts;
    const s = summarize(pool.filter(f)); if (!s.n) return '';
    return `<tr><td>${l}</td><td class="num">${s.n}</td><td class="num">${(s.wr * 100).toFixed(0)}%</td><td class="num ${cls(s.exp)}">${money(s.exp)}</td><td class="num ${cls(s.net)}">${money(s.net)}</td></tr>`;
  }).join('');
  $('edge').innerHTML = body ? `<tr><th></th><th class="num">Trades</th><th class="num">Win</th><th class="num">Per trade</th><th class="num">Net</th></tr>${body}` : '<tr><td class="empty">Log trades to compare.</td></tr>';
}
function drawDow(ts) {
  const svg = $('dow'), css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], v = [0, 0, 0, 0, 0];
  ts.forEach(t => { const d = dayDate(t.date).getDay(); if (d >= 1 && d <= 5) v[d - 1] += pnl(t); });
  const mx = Math.max(1, ...v.map(Math.abs)), H = 200, mid = H / 2 - 6, bw = 70;
  svg.innerHTML = `<line x1="20" x2="580" y1="${mid}" y2="${mid}" stroke="${col('--line')}"/>` + v.map((x, i) => {
    const cx = 60 + i * 115, h = Math.abs(x) / mx * (mid - 22);
    return `<rect x="${cx - bw / 2}" y="${x >= 0 ? mid - h : mid}" width="${bw}" height="${h}" rx="3" fill="${x >= 0 ? col('--gain') : col('--loss')}"/>
    <text x="${cx}" y="${x >= 0 ? mid - h - 5 : mid + h + 13}" text-anchor="middle" font-size="12" font-weight="700" fill="${col('--ink')}">${x ? money(Math.round(x)) : ''}</text>
    <text x="${cx}" y="${H - 4}" text-anchor="middle" font-size="12" fill="${col('--muted')}">${names[i]}</text>`;
  }).join('');
}
function drawMistakes(ts) {
  const m = {}; ts.forEach(t => (t.mistakes || []).forEach(x => { m[x] = m[x] || { n: 0, p: 0 }; m[x].n++; m[x].p += pnl(t); }));
  const r = Object.entries(m).sort((a, b) => a[1].p - b[1].p);
  $('mistakeTbl').innerHTML = r.length ? '<tr><th></th><th class="num">Times</th><th class="num">Net on those trades</th></tr>' +
    r.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v.n}</td><td class="num ${cls(v.p)}">${money(v.p)}</td></tr>`).join('') : '<tr><td class="empty">No mistakes tagged in this range.</td></tr>';
}

/* ---------- header ---------- */
function renderPulse() {
  const td = todayISO(), now = dayDate(td), mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  let a = 0, w = 0, t = 0;
  state.trades.forEach(x => { const c = calc(x); if (!c) return; a += c.total; if (x.date === td) t += c.total; if (dayDate(x.date) >= mon) w += c.total; });
  [['pToday', t], ['pWeek', w], ['pAll', a]].forEach(([id, v]) => { $(id).textContent = money(v); $(id).className = cls(v); });
  $('whoEmail').textContent = state.user.email || '';
}

/* ---------- Tradovate connections ---------- */
function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ms).toLocaleDateString();
}
function renderConnections() {
  const cs = state.connections;
  const badge = c => c.status === 'ok' ? '<span class="badge ok">Connected</span>' : c.status === 'reconnect' ? '<span class="badge warn">Reconnect needed</span>' : '<span class="badge bad">Sync failed</span>';
  $('connList').innerHTML = cs.length ? cs.map(c => {
    const n = state.accounts.filter(a => a.connectionId === c.id).length;
    return `<div class="conn" data-id="${esc(c.id)}"><div><b>${esc(c.label || 'Tradovate')}</b> ${badge(c)}
      <div class="meta">${c.method === 'oauth' ? 'Tradovate sign-in' : 'API key'} · ${c.env === 'demo' ? 'prop/sim' : 'live'} · ${n} account${n === 1 ? '' : 's'} · last sync ${ago(c.lastSyncAt)}</div></div>
      <div style="display:flex;gap:8px">${c.status === 'reconnect' && c.method === 'oauth' ? `<button class="btn small" data-act="reconnect" data-env="${c.env}" type="button">Reconnect</button>` : `<button class="btn small" data-act="sync" type="button">Sync now</button>`}
      <button class="btn danger small" data-act="remove" type="button">Remove</button></div>
      ${c.lastError && c.status !== 'ok' ? `<div class="cerr">${esc(c.lastError)}</div>` : ''}</div>`;
  }).join('') : '<p class="note" style="margin-top:0">No Tradovate connection yet.</p>';
  const on = state.tradovate.oauth;
  $('oauthBtn').disabled = !on;
  $('oauthNote').textContent = on
    ? 'Use this for prop firm accounts (Tradeify, Lucid, Purdia). You sign in on Tradovate with the credentials your prop firm gave you.'
    : "Not set up on this server yet. It needs a Tradovate OAuth client ID and secret (see the README). Until then, use CSV import.";
}
$('connList').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('.conn').dataset.id;
  if (b.dataset.act === 'reconnect') { location.href = `/api/tradovate/oauth/start?env=${b.dataset.env}`; return; }
  if (b.dataset.act === 'remove') {
    if (!confirm('Remove this Tradovate connection? Your trades and accounts stay in the journal.')) return;
    try { await api(`/api/tradovate/connections/${id}`, { method: 'DELETE' }); toast('Connection removed'); await load(); } catch (err) { toast(err.message); }
    return;
  }
  busy(b, true, 'Syncing…');
  try {
    const r = await api(`/api/tradovate/connections/${id}/sync`, { method: 'POST' });
    toast(r.busy ? 'A sync is already running' : syncSummary(r.result));
    await load();
  } catch (err) { toast(err.message); await load(); } finally { busy(b, false); }
});
function syncSummary(r) {
  if (!r) return 'Synced';
  const parts = [];
  if (r.created) parts.push(`${r.created} new trade${r.created > 1 ? 's' : ''}`);
  if (r.merged) parts.push(`${r.merged} cop${r.merged > 1 ? 'ies' : 'y'} merged`);
  if (r.updated) parts.push(`${r.updated} updated`);
  return parts.length ? 'Synced: ' + parts.join(', ') : 'Synced. Nothing new.';
}
$('oauthBtn').onclick = () => {
  const env = $('oauthEnv').value, label = encodeURIComponent($('oauthLabel').value.trim());
  location.href = `/api/tradovate/oauth/start?env=${env}&label=${label}`;
};
$('akBtn').onclick = async () => {
  const b = $('akBtn'); busy(b, true, 'Connecting…');
  try {
    const r = await api('/api/tradovate/apikey', { method: 'POST', body: { env: $('ak_env').value, label: $('ak_label').value, name: $('ak_name').value,
      password: $('ak_pass').value, cid: $('ak_cid').value, sec: $('ak_sec').value } });
    ['ak_pass', 'ak_sec'].forEach(id => ($(id).value = ''));
    toast(r.warning || syncSummary(r.result)); await load();
  } catch (e) { toast(e.message); } finally { busy(b, false); }
};
$('csvBtn').onclick = async () => {
  const f = $('csvFile').files[0], acct = $('csvAcct').value;
  if (!acct) { toast('Add an account first, then pick it here'); return; }
  if (!f) { toast('Choose the CSV file first'); return; }
  const b = $('csvBtn'); busy(b, true, 'Importing…');
  try {
    const r = await api('/api/import/tradovate-csv', { method: 'POST', body: { accountId: acct, csv: await f.text() } });
    const x = r.result;
    toast(`Imported ${x.created} new trade${x.created === 1 ? '' : 's'}${x.merged ? `, merged ${x.merged} into existing` : ''}${x.skipped ? `, skipped ${x.skipped} already in the journal` : ''}${x.badRows ? `, ${x.badRows} unreadable rows` : ''}`);
    $('csvFile').value = ''; await load();
  } catch (e) { toast(e.message); } finally { busy(b, false); }
};

/* ---------- accounts & settings ---------- */
function renderAccounts() {
  const a = state.accounts, firms = state.options.firms, kinds = state.options.kinds;
  $('acctList').innerHTML = a.length ? a.map(x => `<div class="acct" data-id="${esc(x.id)}">
    <label>Name ${x.linked ? `<span class="badge">Tradovate ${x.env === 'demo' ? 'prop/sim' : 'live'}</span>` : ''}<input data-k="name" value="${esc(x.name)}" placeholder="e.g. Tradeify 25K #1" maxlength="80"></label>
    <label>Firm<select data-k="firm">${firms.map(f => `<option ${f === x.firm ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
    <label>Type<select data-k="kind">${kinds.map(f => `<option value="${esc(f)}" ${f === x.kind ? 'selected' : ''}>${f ? esc(f) : 'Not set'}</option>`).join('')}</select></label>
    <button class="btn danger small" data-del="1" type="button">Remove</button></div>`).join('') : '<p class="empty">No accounts yet.</p>';
  $('feeGrid').innerHTML = Object.keys(INSTR).slice(0, 8).map(k => `<label>${k} per contract<input type="number" step="0.01" min="0" data-fee="${k}" value="${state.settings.fees?.[k] ?? 0}"></label>`).join('');
  $('defInstr').value = state.settings.defaultInstr || 'NQ';
  if (![...$('tzSel').options].some(o => o.value === tz())) $('tzSel').insertAdjacentHTML('beforeend', `<option>${esc(tz())}</option>`);
  $('tzSel').value = tz(); $('theme').value = state.settings.theme || '';
}
$('acctList').addEventListener('change', async e => {
  const row = e.target.closest('.acct'); if (!row || !e.target.dataset.k) return;
  const body = {}; row.querySelectorAll('[data-k]').forEach(i => (body[i.dataset.k] = i.value));
  try { await api(`/api/accounts/${row.dataset.id}`, { method: 'PUT', body }); const a = state.accounts.find(x => x.id === row.dataset.id); Object.assign(a, body); toast('Account saved'); refreshAccountSelects(); }
  catch (err) { toast(err.message); }
});
$('acctList').addEventListener('click', async e => {
  if (!e.target.dataset.del) return;
  const row = e.target.closest('.acct'), a = state.accounts.find(x => x.id === row.dataset.id);
  const msg = a?.linked ? 'Remove this account? It will come back on the next Tradovate sync while the connection exists.' : 'Remove this account? Past trades keep their P&L but lose the tag.';
  if (!confirm(msg)) return;
  try { await api(`/api/accounts/${row.dataset.id}`, { method: 'DELETE' }); await load(); } catch (err) { toast(err.message); }
});
$('addAcct').onclick = async () => {
  try { await api('/api/accounts', { method: 'POST', body: { name: '', firm: 'Tradeify', kind: 'Funded' } }); await load(); showTab('accounts'); }
  catch (e) { toast(e.message); }
};
$('saveSettings').onclick = async () => {
  const fees = { ...state.settings.fees };
  document.querySelectorAll('[data-fee]').forEach(i => (fees[i.dataset.fee] = +i.value || 0));
  const body = { fees, defaultInstr: $('defInstr').value, theme: $('theme').value, timezone: $('tzSel').value };
  try { await api('/api/settings', { method: 'PUT', body }); toast('Settings saved'); await load(); } catch (e) { toast(e.message); }
};
function applyTheme() { const t = state.settings.theme; if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
function refreshAccountSelects() { acctOptions('j_acct'); acctOptions('s_acct'); acctOptions('csvAcct', false); renderAcctChips(); }

/* ---------- export ---------- */
$('exportBtn').onclick = () => {
  if (!state.trades.length) { toast('Nothing to export yet'); return; }
  const cols = ['date', 'time', 'instr', 'side', 'qty', 'orh', 'orl', 'entry', 'stop', 'target', 'exit', 'points', 'r', 'net_per_acct', 'accounts', 'net_total', 'c15', 'c5', 'c1', 'plan', 'grade', 'mistakes', 'emotion', 'notes', 'link', 'source'];
  const qv = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [cols.join(',')].concat(sorted(state.trades).map(t => {
    const c = calc(t) || {};
    return [t.date, t.time, t.instr, t.side, t.qty, t.orh, t.orl, t.entry, t.stop, t.target, t.exit, c.pts != null ? +c.pts.toFixed(4) : '', c.r != null ? c.r.toFixed(2) : '',
      c.net != null ? +c.net.toFixed(2) : '', tradeAccts(t).map(acctName).join('; '), c.total != null ? +c.total.toFixed(2) : '', t.c15, t.c5, t.c1, t.plan, t.grade,
      (t.mistakes || []).join('; '), (t.emotion || []).join('; '), t.notes, t.link, t.source].map(qv).join(',');
  }));
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = `orb-journal-${todayISO()}.csv`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/* ---------- tabs & boot ---------- */
function showTab(name) {
  document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
  if (name === 'stats') renderStats(); if (name === 'journal') renderJournal(); if (name === 'accounts') { renderAccounts(); renderConnections(); }
}
document.querySelector('nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
['j_acct', 'j_show', 'j_from', 'j_to'].forEach(id => $(id).addEventListener('input', renderJournal));
['s_acct', 's_range', 's_basis'].forEach(id => $(id).addEventListener('input', renderStats));
$('calPrev').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderStats(); };
$('calNext').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderStats(); };
$('logoutBtn').onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.href = '/login'; } };
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { preview(); renderStats(); });

function renderAll() {
  applyTheme(); refreshAccountSelects(); renderPulse(); renderJournal(); renderConnections();
  if ($('tab-stats').classList.contains('on')) renderStats();
  if ($('tab-accounts').classList.contains('on')) renderAccounts();
  if (editing) { const t = currentTrade(); if (!t) fillForm(null); }
  preview();
}

function showBanner() {
  const p = new URLSearchParams(location.search), s = p.get('tv');
  const msgs = { connected: ['Tradovate connected. Your first sync is running; refresh in a moment to see trades.', ''],
    denied: ['Tradovate sign-in was cancelled.', 'bad'], 'bad-state': ['That sign-in link expired. Start the connection again.', 'bad'],
    'not-configured': ['Tradovate sign-in isn\'t set up on this server yet. Use CSV import for now.', 'bad'],
    error: [`Tradovate connection failed: ${p.get('msg') || 'unknown error'}`, 'bad'] };
  if (!s || !msgs[s]) return;
  $('banner').textContent = msgs[s][0]; $('banner').className = 'banner ' + msgs[s][1]; $('banner').hidden = false;
  history.replaceState(null, '', '/app' + location.hash);
}

buildForm();
load().then(() => {
  fillForm(null); showBanner();
  if (location.hash === '#accounts') showTab('accounts');
  if (new URLSearchParams(location.search).get('tv') === 'connected' || $('banner').textContent.startsWith('Tradovate connected')) setTimeout(load, 8000);
}).catch(e => toast(e.message));
})();
