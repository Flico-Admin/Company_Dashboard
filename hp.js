// hp.js: "Hire Purchase Analysis" API (page: /hp.html). Reads the same MySQL database as the dashboard (read only).
//   GET /api/hp?scope=all|cl:<id>|br:<code>&from=YYYY-MM-DD&to=YYYY-MM-DD
// Results are cached for HP_CACHE_SECONDS and cleared after every new backup import, so the page always shows the latest data.
const analysis = require('./analysis');

const { HP_CACHE_SECONDS = 120 } = process.env;

const num = v => (v === null || v === undefined ? 0 : Number(v));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const inList = codes => (codes.length ? codes : ['__none__']);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = ym => MON[+ym.slice(5, 7) - 1] + ' ' + ym.slice(2, 4);
const pct = (a, b) => (b ? (a - b) / b * 100 : null);

const cache = new Map();
function clear() { cache.clear(); }

// every sales header (cash + credit + hire purchase) in a date range, cancelled bills removed
function unionSql(from, to) {
  return {
    sql: `(SELECT bc,'cash' AS type,ddate,net_amount FROM t_cash_sales_sum WHERE is_cancel=0 AND ddate BETWEEN ? AND ?
           UNION ALL SELECT bc,'credit',ddate,net_amount FROM t_credit_sales_sum WHERE is_cancel=0 AND ddate BETWEEN ? AND ?
           UNION ALL SELECT bc,'hp',ddate,net_amount FROM t_hp_sales_sum WHERE is_cancel=0 AND ddate BETWEEN ? AND ?) s`,
    params: [from, to, from, to, from, to],
  };
}

// per branch: HP sales, HP bills and all sales, for one period
async function branchTotals(pool, from, to, codes) {
  const u = unionSql(from, to);
  const [rows] = await pool.query(
    `SELECT bc, type, COUNT(*) AS bills, SUM(net_amount) AS amt FROM ${u.sql} WHERE bc IN (?) GROUP BY bc, type`,
    [...u.params, inList(codes)]);
  const m = new Map();
  for (const r of rows) {
    const o = m.get(r.bc) || { hp: 0, hpBills: 0, all: 0 };
    o.all += num(r.amt);
    if (r.type === 'hp') { o.hp = num(r.amt); o.hpBills = num(r.bills); }
    m.set(r.bc, o);
  }
  return m;
}
const sumOf = (m, key) => { let t = 0; for (const o of m.values()) t += o[key]; return t; };

async function build(deps, scope, from, to) {
  const { pool, branches, scopeBranches } = deps;
  const sc = await scopeBranches(scope);
  const codes = sc.codes;
  const b = await branches();
  const nameOf = bc => b.names.get(bc) || bc;

  // the same number of days right before the chosen period
  const len = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(len - 1));

  const [cur, prev] = await Promise.all([branchTotals(pool, from, to, codes), branchTotals(pool, prevFrom, prevTo, codes)]);
  const hp = sumOf(cur, 'hp'), bills = sumOf(cur, 'hpBills'), all = sumOf(cur, 'all');
  const hpP = sumOf(prev, 'hp'), billsP = sumOf(prev, 'hpBills'), allP = sumOf(prev, 'all');
  const avg = bills ? hp / bills : 0, avgP = billsP ? hpP / billsP : 0;
  const share = all ? hp / all * 100 : 0, shareP = allP ? hpP / allP * 100 : 0;

  // 24 months ending with the month of "to": HP sales and HP share of all sales
  const mStart = ymd(new Date(+to.slice(0, 4), +to.slice(5, 7) - 1 - 23, 1));
  const u = unionSql(mStart, to);
  const [mrows] = await pool.query(
    `SELECT DATE_FORMAT(ddate,'%Y-%m') AS ym, type, SUM(net_amount) AS amt FROM ${u.sql} WHERE bc IN (?) GROUP BY ym, type`,
    [...u.params, inList(codes)]);
  const months = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(+mStart.slice(0, 4), +mStart.slice(5, 7) - 1 + i, 1);
    months.push({ ym: d.getFullYear() + '-' + pad(d.getMonth() + 1), hp: 0, all: 0 });
  }
  const mIdx = new Map(months.map((m, i) => [m.ym, i]));
  for (const r of mrows) {
    const i = mIdx.get(r.ym);
    if (i === undefined) continue;
    months[i].all += num(r.amt);
    if (r.type === 'hp') months[i].hp = num(r.amt);
  }
  const monthly = months.map(m => ({ ym: m.ym, label: monthLabel(m.ym), hp: m.hp, share: m.all ? m.hp / m.all * 100 : 0 }));
  let best = monthly[0];
  for (const m of monthly) if (m.hp > best.hp) best = m;

  // year against the year before (month by month, up to the month of "to")
  const Y = +to.slice(0, 4), toMonth = +to.slice(5, 7);
  const yearOf = y => Array.from({ length: 12 }, (_, i) => {
    const k = mIdx.get(y + '-' + pad(i + 1));
    return k === undefined || (y === Y && i + 1 > toMonth) ? null : months[k].hp;
  });
  const years = { year: Y, prevYear: Y - 1, current: yearOf(Y), previous: yearOf(Y - 1) };

  // branch table
  const branchRows = [...cur.entries()].filter(([, o]) => o.hp > 0 || o.hpBills > 0).map(([bc, o]) => {
    const p = prev.get(bc);
    return {
      bc, name: nameOf(bc), hp: o.hp, share: hp ? o.hp / hp * 100 : 0, ofBranch: o.all ? o.hp / o.all * 100 : 0,
      bills: o.hpBills, avg: o.hpBills ? o.hp / o.hpBills : 0, change: pct(o.hp, p ? p.hp : 0),
    };
  }).sort((x, y) => y.hp - x.hp);
  const top = branchRows[0] || null;

  // categories and items (from the hire purchase bill lines)
  const found = await analysis.discover(pool);
  const items = await analysis.loadItems(pool, found);
  const [irows] = await pool.query(
    `SELECT d.item_code AS code, SUM(d.qty) AS qty, SUM(d.amount) AS amount
       FROM t_hp_sales_det d JOIN t_hp_sales_sum s ON s.cl=d.cl AND s.bc=d.bc AND s.nno=d.nno
      WHERE s.is_cancel=0 AND s.ddate BETWEEN ? AND ? AND s.bc IN (?) GROUP BY d.item_code`,
    [from, to, inList(codes)]);
  const cats = new Map();
  const itemRows = irows.map(r => {
    const it = items.get(String(r.code)) || { name: String(r.code), cat: 'Uncategorized' };
    const amount = num(r.amount);
    cats.set(it.cat, (cats.get(it.cat) || 0) + amount);
    return { code: String(r.code), name: it.name, cat: it.cat, qty: num(r.qty), amount };
  }).sort((x, y) => y.amount - x.amount);
  const categories = [...cats.entries()].map(([name, amount]) => ({ name, amount })).sort((x, y) => y.amount - x.amount).slice(0, 10);

  return {
    scopeLabel: sc.label, range: { from, to }, previous: { from: prevFrom, to: prevTo }, updated: new Date().toISOString(),
    kpi: {
      hp, hpChange: pct(hp, hpP), bills, billsChange: pct(bills, billsP), avg, avgChange: pct(avg, avgP),
      share, sharePts: share - shareP,
      topBranch: top ? { name: top.name, hp: top.hp } : null,
      bestMonth: { label: best.label, hp: best.hp },
    },
    monthly, years, branches: branchRows, categories, items: itemRows.slice(0, 15),
  };
}

function readRange(q) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const t = ymd(new Date());
  let to = re.test(q.to || '') ? q.to : t;
  if (to > t) to = t;
  let from = re.test(q.from || '') ? q.from : addDays(to, -364);
  if (from > to) from = to;
  if (daysBetween(from, to) > 800) from = addDays(to, -800);
  return { from, to };
}
const readScope = q => { const s = String(q.scope || ''); return s === 'all' || /^(cl|br):[A-Za-z0-9_-]+$/.test(s) ? s : 'all'; };

function register(app, deps) {
  app.get('/api/hp', async (req, res) => {
    try {
      const scope = readScope(req.query), { from, to } = readRange(req.query);
      const key = scope + '|' + from + '|' + to;
      let hit = cache.get(key);
      if (req.query.refresh === '1' || !hit || Date.now() - hit.t > Number(HP_CACHE_SECONDS) * 1000) {
        const promise = build(deps, scope, from, to);
        hit = { t: Date.now(), promise };
        cache.set(key, hit);
        promise.catch(() => { if (cache.get(key) === hit) cache.delete(key); });
      }
      res.json(await hit.promise);
    } catch (err) {
      console.error('/api/hp', err.message);
      res.status(500).json({ error: 'Server error: ' + err.message });
    }
  });
}

module.exports = { register, clear };
