// hp-collection.js: "HP daily collection" API. Read only, same MySQL database as the dashboard.
//   GET /api/hp-collection?scope=all|cl:<id>|br:<code>|showrooms&from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET /api/hp-collection/schema   (shows which table / column was found, and the other candidates)
// The collection (receipt) table is found automatically. If the wrong one is picked, set in .env:
//   HP_COLLECTION_TABLE=t_hp_receipt_sum
//   HP_COLLECTION_AMOUNT=net_amount        (optional)
//   HP_COLLECTION_DATE=ddate               (optional)
//   HP_COLLECTION_WHERE=cus_type='HP'      (optional extra condition, written by you in .env, not by users)
const { HP_CACHE_SECONDS = 120 } = process.env;

const num = v => (v === null || v === undefined ? 0 : Number(v));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const inList = codes => (codes.length ? codes : ['__none__']);
const pct = (a, b) => (b ? (a - b) / b * 100 : null);
const SAFE = /^[A-Za-z0-9_]+$/;
const q = id => '`' + id + '`';
// payment-type columns of the receipt table (only the ones that exist are used)
const PAY = [['pay_cash', 'Cash'], ['pay_cheque', 'Cheque'], ['pay_ccard', 'Card'], ['pay_deposit', 'Bank deposit'], ['pay_cnote', 'Credit note'], ['pay_other', 'Other']];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const cache = new Map();
let schemaCache = null;
function clear() { cache.clear(); schemaCache = null; }

const NUMERIC = new Set(['decimal', 'numeric', 'double', 'float', 'int', 'bigint', 'mediumint', 'smallint']);
const AMOUNT_PREF = ['net_amount', 'amount', 'total_amount', 'tot_amount', 'paid_amount', 'received_amount', 'receipt_amount', 'pay_amount', 'total', 'tot'];

// look in information_schema for the table that holds hire purchase receipts
async function discover(pool) {
  if (schemaCache) return schemaCache;
  const env = process.env;
  const out = { found: false, table: null, amountColumn: null, dateColumn: 'ddate', cancelColumn: null, where: env.HP_COLLECTION_WHERE || '', candidates: [], notes: [] };

  const [cols] = await pool.query(
    'SELECT table_name AS t, column_name AS c, data_type AS d FROM information_schema.columns WHERE table_schema = ?', [env.DB_NAME]);
  const byTable = new Map();
  for (const r of cols) {
    const t = r.t || r.T || r.TABLE_NAME, c = String(r.c || r.C || r.COLUMN_NAME).toLowerCase(), d = String(r.d || r.D || r.DATA_TYPE).toLowerCase();
    if (!byTable.has(t)) byTable.set(t, new Map());
    byTable.get(t).set(c, d);
  }

  // every table that looks like a receipt / collection / instalment table (shown in /schema so you can check)
  for (const [t, c] of byTable) {
    const low = t.toLowerCase();
    if (/(receipt|rcpt|collect|install|instal|settle)/.test(low) && !low.endsWith('_det') && !low.includes('purchase'))
      out.candidates.push({ table: t, hasHpInName: low.includes('hp'), columns: [...c.keys()] });
  }

  let table = env.HP_COLLECTION_TABLE ? env.HP_COLLECTION_TABLE.trim() : null;
  if (table && !byTable.has(table)) { out.notes.push(`HP_COLLECTION_TABLE="${table}" does not exist in ${env.DB_NAME}.`); table = null; }
  if (!table) {
    const score = c => {
      const low = c.table.toLowerCase();
      let s = 0;
      if (low.includes('hp')) s += 10;
      if (low.includes('receipt')) s += 5;
      if (low.endsWith('_sum')) s += 2;
      const cl = byTable.get(c.table);
      if (!(cl.has('bc') && cl.has('ddate'))) s -= 100;
      return s;
    };
    const best = [...out.candidates].sort((a, b) => score(b) - score(a))[0];
    if (best && score(best) >= 10) table = best.table;
  }
  if (!table) {
    out.notes.push('No hire purchase collection table was found automatically. Send the /api/hp-collection/schema page to your developer, or set HP_COLLECTION_TABLE in .env.');
    return (schemaCache = out);
  }

  const cl = byTable.get(table);
  out.table = table;
  out.dateColumn = (env.HP_COLLECTION_DATE || (cl.has('ddate') ? 'ddate' : '')).toLowerCase();
  let amount = env.HP_COLLECTION_AMOUNT ? env.HP_COLLECTION_AMOUNT.toLowerCase() : null;
  if (amount && !cl.has(amount)) { out.notes.push(`HP_COLLECTION_AMOUNT="${amount}" is not a column of ${table}.`); amount = null; }
  if (!amount) amount = AMOUNT_PREF.find(a => cl.has(a) && NUMERIC.has(cl.get(a)))
    || [...cl.keys()].find(c => c.includes('amount') && NUMERIC.has(cl.get(c))) || null;
  out.amountColumn = amount;
  out.cancelColumn = cl.has('is_cancel') ? 'is_cancel' : null;
  out.hasBc = cl.has('bc');
  if (!out.dateColumn || !cl.has(out.dateColumn) || !out.hasBc || !amount || ![table, out.dateColumn, amount].every(x => SAFE.test(x))) {
    out.notes.push(`Table ${table} was found but it has no usable date / branch / amount column. Columns: ${[...cl.keys()].join(', ')}. Set HP_COLLECTION_AMOUNT / HP_COLLECTION_DATE in .env.`);
    return (schemaCache = out);
  }
  out.found = true;
  out.columns = [...cl.keys()];
  return (schemaCache = out);
}

function weekStart(s) { const d = parse(s); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return ymd(d); }

async function build(deps, scope, from, to) {
  const { pool, branches, scopeBranches } = deps;
  const sc = await scopeBranches(scope);
  const b = await branches();
  const nameOf = bc => b.names.get(bc) || bc;
  const found = await discover(pool);
  const base = { found: found.found, notes: found.notes, scopeLabel: sc.label, range: { from, to }, updated: new Date().toISOString(), table: found.table, amountColumn: found.amountColumn };
  if (!found.found) return base;

  const dcol = q(found.dateColumn);
  const where = `${found.cancelColumn ? q(found.cancelColumn) + '=0 AND ' : ''}DATE(${dcol}) BETWEEN ? AND ? AND bc IN (?)${found.where ? ' AND (' + found.where + ')' : ''}`;
  const payCols = PAY.filter(([c]) => found.columns.includes(c) && c !== found.amountColumn);
  const paySql = payCols.map(([c]) => `, SUM(${q(c)}) AS p_${c}`).join('');
  const run = (f, t) => pool.query(
    `SELECT bc, DATE_FORMAT(${dcol},'%Y-%m-%d') AS d, COUNT(*) AS n, SUM(${q(found.amountColumn)}) AS amt${paySql} FROM ${q(found.table)} WHERE ${where} GROUP BY bc, d`,
    [f, t, inList(sc.codes)]).then(r => r[0]);

  const len = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(len - 1));
  const [rows, prevRows] = await Promise.all([run(from, to), run(prevFrom, prevTo)]);

  // HP sales in the same period, to compare collection with sales
  const [[hs]] = await pool.query(
    'SELECT SUM(net_amount) AS amt FROM t_hp_sales_sum WHERE is_cancel=0 AND ddate BETWEEN ? AND ? AND bc IN (?)', [from, to, inList(sc.codes)]);

  const days = new Map();
  const zeroPay = () => Object.fromEntries(payCols.map(([c]) => [c, 0]));
  for (let d = from; d <= to; d = addDays(d, 1)) days.set(d, { date: d, amount: 0, receipts: 0, pay: zeroPay() });
  const payTotal = zeroPay();
  const byBranch = new Map(), prevBranch = new Map();
  let total = 0, receipts = 0, prevTotal = 0;
  for (const r of rows) {
    const o = days.get(r.d); if (o) { o.amount += num(r.amt); o.receipts += num(r.n); for (const [c] of payCols) o.pay[c] += num(r['p_' + c]); }
    total += num(r.amt); receipts += num(r.n);
    const x = byBranch.get(r.bc) || { bc: r.bc, name: nameOf(r.bc), amount: 0, receipts: 0, cash: 0 };
    x.amount += num(r.amt); x.receipts += num(r.n); x.cash += num(r.p_pay_cash); byBranch.set(r.bc, x);
    for (const [c] of payCols) payTotal[c] += num(r['p_' + c]);
  }
  for (const r of prevRows) { prevTotal += num(r.amt); prevBranch.set(r.bc, (prevBranch.get(r.bc) || 0) + num(r.amt)); }

  const dayList = [...days.values()];
  let best = null, latest = null;
  for (const d of dayList) { if (d.amount > 0) { latest = d; if (!best || d.amount > best.amount) best = d; } }

  // long periods are grouped: up to 62 days daily, up to 200 days weekly, longer monthly
  const group = len <= 62 ? 'day' : len <= 200 ? 'week' : 'month';
  const buckets = new Map();
  for (const d of dayList) {
    const key = group === 'day' ? d.date : group === 'week' ? weekStart(d.date) : d.date.slice(0, 7);
    const label = group === 'day' ? d.date.slice(5) : group === 'week' ? 'Wk ' + weekStart(d.date).slice(5) : MON[+d.date.slice(5, 7) - 1] + ' ' + d.date.slice(2, 4);
    const o = buckets.get(key) || { key, label, amount: 0, receipts: 0, pay: zeroPay() };
    o.amount += d.amount; o.receipts += d.receipts; for (const [c] of payCols) o.pay[c] += d.pay[c]; buckets.set(key, o);
  }

  const branchRows = [...byBranch.values()].map(x => ({ ...x, share: total ? x.amount / total * 100 : 0, cashPct: x.amount ? x.cash / x.amount * 100 : null, change: pct(x.amount, prevBranch.get(x.bc) || 0) }))
    .sort((x, y) => y.amount - x.amount);
  const hpSales = num(hs && hs.amt);

  return {
    ...base, previous: { from: prevFrom, to: prevTo }, group,
    kpi: {
      collected: total, change: pct(total, prevTotal), receipts, avgPerDay: len ? total / len : 0,
      latest: latest ? { date: latest.date, amount: latest.amount } : null,
      best: best ? { date: best.date, amount: best.amount } : null,
      hpSales, ratio: hpSales ? total / hpSales * 100 : null,
    },
    payTypes: payCols.map(([c, label]) => ({ key: c, label, amount: payTotal[c], share: total ? payTotal[c] / total * 100 : 0 })).filter(x => x.amount !== 0),
    daily: [...buckets.values()], branches: branchRows,
  };
}

function readRange(q2) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const t = ymd(new Date());
  let to = re.test(q2.to || '') ? q2.to : t;
  if (to > t) to = t;
  let from = re.test(q2.from || '') ? q2.from : to.slice(0, 8) + '01';
  if (from > to) from = to;
  if (daysBetween(from, to) > 800) from = addDays(to, -800);
  return { from, to };
}
const readScope = s0 => { const s = String(s0.scope || ''); return s === 'all' || /^(cl|br):[A-Za-z0-9_-]+$/.test(s) ? s : 'showrooms'; };

function register(app, deps) {
  app.get('/api/hp-collection/schema', async (req, res) => {
    try { res.json(await discover(deps.pool)); }
    catch (err) { res.status(500).json({ error: 'Server error: ' + err.message }); }
  });
  app.get('/api/hp-collection', async (req, res) => {
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
      console.error('/api/hp-collection', err.message);
      res.status(500).json({ error: 'Server error: ' + err.message });
    }
  });
}

module.exports = { register, clear, discover };
