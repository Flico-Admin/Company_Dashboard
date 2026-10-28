// analysis-core.js
// Pure calculation code for the "Company Analysis" page. No database code here, so it can be tested on its own.
// Input = already summed numbers (read from MySQL by analysis.js). Output = one JSON object the page draws.

const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MFULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const title = s => String(s == null ? '' : s).toLowerCase().replace(/[a-z]+/g, w => w[0].toUpperCase() + w.slice(1));
const niceDate = s => `${+s.slice(8, 10)} ${MN[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
const isLastDay = s => +s.slice(8, 10) === new Date(+s.slice(0, 4), +s.slice(5, 7), 0).getDate();
const chanOf = bc => (String(bc).toUpperCase().startsWith('HOF') ? 'HOF' : 'Showrooms');
const sumBy = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const median = a => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const round = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k; };
const M = 1e6;
const daysBetween = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 864e5);

function buildStock(inp, itemSales, itemOf) {
  const st = inp.stock;
  if (!st || !st.rows || !st.rows.length) return null;
  const rows = st.rows; // {bc, code, qty, val, qty_nc} - only rows with qty > 0

  // per item
  const it = new Map();
  for (const r of rows) {
    const o = it.get(r.code) || { qty: 0, val: 0, qty_nc: 0 };
    o.qty += r.qty; o.val += r.val; o.qty_nc += r.qty_nc;
    it.set(r.code, o);
  }
  const sales = new Map(itemSales.map(x => [x.code, x]));
  for (const [code, o] of it) {
    const s = sales.get(code);
    o.s3 = s ? Math.max(s.s3, 0) : 0;
    o.s6 = s ? Math.max(s.s6, 0) : 0;
    o.last = s ? s.last : null;
    const meta = itemOf(code);
    o.name = meta.name; o.cat = meta.cat;
  }

  const units = sumBy(rows, r => r.qty);
  const nc = sumBy(rows, r => r.qty_nc);
  // no sales in 180 days, but only for stock that was received (GRN) before the cut-off date.
  // Items whose latest GRN is inside the last 180 days are new stock, so they are left out.
  // Items with no GRN record at all are kept (old opening stock).
  const grn = inp.grn || new Map();
  const sf = inp.stockFirst || new Map();
  // date used for the age of an item: last GRN if there is one, otherwise the day it first appeared in stock
  // (but not when that day is inside the opening-balance load: then the real age is unknown and the item is kept)
  const ageOf = code => {
    const g = grn.get(code);
    if (g && g.last) return { date: g.last, src: 'grn' };
    const f = sf.get(code);
    if (!f) return null;
    return f <= (inp.openingUntil || '') ? { date: f, src: 'opening' } : { date: f, src: 'stock' };
  };
  const isNew = code => { const a = ageOf(code); return !!(a && a.src !== 'opening' && inp.grnCutoff && a.date > inp.grnCutoff); };
  const noSales = [...it.entries()].filter(([, o]) => o.s6 <= 0);
  const dead = noSales.filter(([code]) => !isNew(code));
  const hofUnits = sumBy(rows.filter(r => chanOf(r.bc) === 'HOF'), r => r.qty);
  const d = {
    units, value: sumBy(rows, r => r.val) / M, items: it.size,
    locations: new Set(rows.map(r => r.bc)).size,
    nocost_units: nc, nocost_share: units ? nc / units * 100 : 0,
    neg_rows: st.negRows || 0,
    dead_items: dead.length, dead_units: sumBy(dead, ([, o]) => o.qty), dead_value: sumBy(dead, ([, o]) => o.val) / M,
    hof_share: units ? hofUnits / units * 100 : 0,
    grn_available: !!inp.grnAvailable,
    dead_hidden_new: noSales.length - dead.length,   // recent GRN items left out of the list
  };

  // category: stock vs selling speed (last 90 days)
  const cg = new Map();
  for (const o of it.values()) {
    const c = cg.get(o.cat) || { units: 0, val: 0 };
    c.units += o.qty; c.val += o.val; cg.set(o.cat, c);
  }
  const catS3 = new Map();
  for (const s of itemSales) {
    const c = itemOf(s.code).cat;
    catS3.set(c, (catS3.get(c) || 0) + Math.max(s.s3, 0));
  }
  d.cats = [...cg.entries()].sort((a, b) => b[1].val - a[1].val).slice(0, 12).map(([name, c]) => {
    const s3 = catS3.get(name) || 0;
    return { name: title(name), units: c.units, val: c.val / M, rate: s3 / 3, cover: s3 > 0 ? c.units / (s3 / 3) : null };
  });

  // locations
  const lg = new Map();
  for (const r of rows) {
    const l = lg.get(r.bc) || { units: 0, val: 0 };
    l.units += r.qty; l.val += r.val; lg.set(r.bc, l);
  }
  d.locs = [...lg.entries()].sort((a, b) => b[1].val - a[1].val).slice(0, 12)
    .map(([bc, l]) => ({ name: inp.nameOf(bc), units: l.units, val: l.val / M }));

  // stock with no sales in the last 180 days (biggest value first)
  d.dead = dead.sort((a, b) => (b[1].val - a[1].val) || (b[1].qty - a[1].qty)).slice(0, 15).map(([code, o]) => ({
    name: String(o.name || code), cat: String(o.cat || ''), units: o.qty,
    val: o.val > 0 ? o.val / M : null,
    last: o.last ? `${MN[+o.last.slice(5, 7) - 1]} ${o.last.slice(0, 4)}` : null,
    grn: (() => { const a = ageOf(code); return !a ? null : a.src === 'grn' ? niceDate(a.date) : a.src === 'opening' ? 'Opening stock' : 'Stock ' + niceDate(a.date); })(),
    grn_days: (() => { const a = ageOf(code); return a ? daysBetween(a.date, inp.end) : null; })(),
    grn_open: (() => { const a = ageOf(code); return !!(a && a.src === 'opening'); })(),
  }));

  // selling fast but under 1 month of stock
  const fast = [];
  for (const s of itemSales) {
    const s3 = Math.max(s.s3, 0);
    if (s3 <= 0) continue;
    const units3 = it.has(s.code) ? it.get(s.code).qty : 0;
    const cover = units3 / (s3 / 3);
    if (cover < 1 && s3 >= 20) fast.push({ code: s.code, s3, units: units3, cover });
  }
  d.low = fast.sort((a, b) => b.s3 - a.s3).slice(0, 10).map(f => {
    const m = itemOf(f.code);
    return { name: String(m.name || f.code), cat: title(m.cat), sold: f.s3, units: f.units, cover: f.cover };
  });
  return d;
}

function compute(inp) {
  const { agg, bills, items, itemSales, end, start } = inp;
  const itemOf = code => items.get(code) || { name: code, cat: 'Uncategorized' };

  const endY = +end.slice(0, 4), endM = +end.slice(5, 7);
  const monthDone = isLastDay(end);
  let yB = endY, lastMo = monthDone ? endM : endM - 1;
  if (lastMo < 1) { yB -= 1; lastMo = 12; }
  const yA = yB - 1;
  const partial = monthDone ? '' : end.slice(0, 7);

  // ---- monthly ----
  const mon = new Map();
  for (const r of agg) {
    const o = mon.get(r.ym) || { net: 0, sales: 0, ret: 0, hof: 0, shw: 0, inv: 0 };
    o.net += r.net; o.sales += r.sales; o.ret += r.ret;
    if (chanOf(r.bc) === 'HOF') o.hof += r.net; else o.shw += r.net;
    mon.set(r.ym, o);
  }
  for (const b of bills) { const o = mon.get(b.ym); if (o) o.inv += b.bills; }
  const months = [...mon.keys()].sort();

  const ymOf = r => ({ y: +r.ym.slice(0, 4), m: +r.ym.slice(5, 7) });
  const sel = (rows, y, lo = 1, hi = lastMo) => rows.filter(r => { const t = ymOf(r); return t.y === y && t.m >= lo && t.m <= hi; });

  const block = (y, lo = 1) => {
    const s = sel(agg, y, lo), bl = sel(bills, y, lo);
    const net = sumBy(s, r => r.net), sales = sumBy(s, r => r.sales), ret = sumBy(s, r => r.ret);
    const inv = sumBy(bl, r => r.bills);
    return {
      net: net / M,
      hof: sumBy(s.filter(r => chanOf(r.bc) === 'HOF'), r => r.net) / M,
      shw: sumBy(s.filter(r => chanOf(r.bc) !== 'HOF'), r => r.net) / M,
      inv, avg: net / Math.max(inv, 1) / 1e3,
      ret: sales ? ret / sales * 100 : 0, retv: ret / M,
    };
  };

  const d = {
    start_label: niceDate(start), end_label: niceDate(end),
    rows: inp.rows || 0, total: sumBy(agg, r => r.net) / M,
    yA, yB, lastMo,
    period: lastMo > 1 ? 'Jan to ' + MN[lastMo - 1] : 'Jan',
    partial, months,
    net: months.map(m => round(mon.get(m).net / M, 2)),
    hof: months.map(m => round(mon.get(m).hof / M, 2)),
    shw: months.map(m => round(mon.get(m).shw / M, 2)),
    inv: months.map(m => mon.get(m).inv),
    ret_pct: months.map(m => { const o = mon.get(m); return o.sales ? round(o.ret / o.sales * 100, 2) : 0; }),
    ret_m: months.map(m => round(mon.get(m).ret / M, 2)),
    a: block(yA), b: block(yB), q: null, qlabel: '',
    returns_available: inp.returnsAvailable !== false,
  };
  if (lastMo >= 3) {
    const f = y => sumBy(sel(agg, y, lastMo - 2), r => r.net) / M;
    d.q = { a: f(yA), b: f(yB) };
    d.qlabel = MN[lastMo - 3] + ' to ' + MN[lastMo - 1];
  }

  const A = sel(agg, yA), B = sel(agg, yB);
  const groupSum = (rows, key, val) => {
    const m = new Map();
    for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + val(r));
    return m;
  };
  const chg = (a, b) => (a > 0 ? (b / a - 1) * 100 : null);

  // ---- categories (top 10 by earlier year) ----
  const ca = groupSum(A, r => r.cat, r => r.net), cb = groupSum(B, r => r.cat, r => r.net);
  d.cats = [...new Set([...ca.keys(), ...cb.keys()])].map(k => ({ k, a: ca.get(k) || 0, b: cb.get(k) || 0 }))
    .sort((x, y) => y.a - x.a).slice(0, 10)
    .map(r => ({ name: title(r.k), a: r.a / M, b: r.b / M, chg: chg(r.a, r.b) }));

  // ---- showrooms ----
  const sa = groupSum(A.filter(r => chanOf(r.bc) !== 'HOF'), r => r.bc, r => r.net);
  const sb = groupSum(B.filter(r => chanOf(r.bc) !== 'HOF'), r => r.bc, r => r.net);
  d.locs = [...new Set([...sa.keys(), ...sb.keys()])].map(k => ({ k, a: sa.get(k) || 0, b: sb.get(k) || 0 }))
    .filter(r => r.a > 1e6 || r.b > 1e6).sort((x, y) => y.b - x.b).slice(0, 12)
    .map(r => ({ name: inp.nameOf(r.k), a: r.a / M, b: r.b / M, chg: chg(r.a, r.b) }));

  // ---- returns by category (top 8) ----
  const ra = groupSum(A, r => r.cat, r => r.ret), rb = groupSum(B, r => r.cat, r => r.ret);
  const xa = groupSum(A, r => r.cat, r => r.sales), xb = groupSum(B, r => r.cat, r => r.sales);
  d.rcats = [...new Set([...ra.keys(), ...rb.keys(), ...xa.keys(), ...xb.keys()])]
    .map(k => ({ k, ra: ra.get(k) || 0, rb: rb.get(k) || 0, sa: xa.get(k) || 0, sb: xb.get(k) || 0 }))
    .sort((x, y) => (y.ra + y.rb) - (x.ra + x.rb)).slice(0, 8)
    .map(r => ({ name: title(r.k), a: r.ra / M, b: r.rb / M, ra: r.sa > 0 ? r.ra / r.sa * 100 : 0, rb: r.sb > 0 ? r.rb / r.sb * 100 : 0 }));

  // ---- unusually big months in the earlier year ----
  const mv = groupSum(A, r => ymOf(r).m, r => r.net);
  d.spikes = [];
  if (mv.size >= 4) {
    const med = median([...mv.values()]);
    d.spikes = [...mv.entries()].filter(([, v]) => v > 2 * med).sort((x, y) => y[1] - x[1]).slice(0, 2)
      .map(([m, v]) => ({ name: `${MFULL[m - 1]} ${yA}`, v: v / M }))
      .sort((x, y) => MFULL.indexOf(x.name.split(' ')[0]) - MFULL.indexOf(y.name.split(' ')[0]));
  }

  d.stock = inp.stock ? buildStock(inp, itemSales, itemOf) : null;
  return d;
}

module.exports = { compute, chanOf, title };
