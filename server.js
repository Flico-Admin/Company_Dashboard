// FLICO dashboard backend: reads MySQL (read-only user) and serves JSON + the HTML page.
require('dotenv').config();
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const importer = require('./importer');
const hpCol = require('./hp-collection'); // HP daily collection
const hp = require('./hp'); // Hire Purchase page (/hp.html)
const analysis = require('./analysis'); // Company Analysis page (/analysis.html)

const {
  DB_HOST = '127.0.0.1', DB_PORT = 3306, DB_USER, DB_PASSWORD, DB_NAME,
  HOST = '127.0.0.1', PORT = 3000, CACHE_SECONDS = 60, EXCLUDE_BRANCHES = 'B1,B2,BX',
  CLUSTER_NAMES = '', // e.g. C1:Head Office,C3:Showrooms,C4:Dealers  (cluster code : name, in the order you want them listed)
} = process.env;

const EXCLUDED = EXCLUDE_BRANCHES.split(',').map(s => s.trim()).filter(Boolean);
const WAREHOUSE = 'HOF'; // head office warehouse branch code

const pool = mysql.createPool({
  host: DB_HOST, port: Number(DB_PORT), user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
  connectionLimit: 5, dateStrings: true, // dates come back as 'YYYY-MM-DD' text
});

// ---------- small helpers ----------
const num = v => (v === null || v === undefined ? 0 : Number(v));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const today = () => ymd(new Date());

// simple in-memory cache so many viewers do not hit the database each time
const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < Number(CACHE_SECONDS) * 1000) return hit.data;
  const data = await fn();
  cache.set(key, { t: Date.now(), data });
  return data;
}

// ---------- branches and clusters ----------
// m_branch.cl is the cluster code of a branch (C3 = showrooms). Names for the codes come from CLUSTER_NAMES in .env.
const SHOWROOM_CL = 'C3';
const clusterNames = new Map(CLUSTER_NAMES.split(',').map(p => p.split(':')).filter(p => p.length >= 2 && p[0].trim())
  .map(p => [p[0].trim(), p.slice(1).join(':').trim()]));
if (!clusterNames.has(SHOWROOM_CL)) clusterNames.set(SHOWROOM_CL, 'Showrooms');
const clusterName = id => clusterNames.get(id) || ('Cluster ' + id);

let branchCache = { t: 0, all: [], showrooms: [], names: new Map() };
async function branches() {
  if (Date.now() - branchCache.t < 10 * 60 * 1000 && branchCache.all.length) return branchCache;
  const [rows] = await pool.query('SELECT cl, bc, name FROM m_branch');
  const all = rows
    .map(r => ({ cl: String(r.cl == null ? '' : r.cl).trim(), bc: r.bc, name: String(r.name || r.bc).trim() }))
    .filter(r => !EXCLUDED.includes(r.bc));
  const showrooms = all.filter(r => r.cl === SHOWROOM_CL);
  const names = new Map(all.map(r => [r.bc, r.name]));
  branchCache = { t: Date.now(), all, showrooms, names };
  return branchCache;
}

// the clusters that really exist in m_branch, in the order of CLUSTER_NAMES first, then the rest by code
async function clusterList() {
  const b = await branches();
  const count = new Map();
  for (const r of b.all) count.set(r.cl, (count.get(r.cl) || 0) + 1);
  const order = [...clusterNames.keys()];
  const ids = [...count.keys()].sort((x, y) => {
    const ix = order.indexOf(x), iy = order.indexOf(y);
    if (ix >= 0 && iy >= 0) return ix - iy;
    if (ix >= 0) return -1;
    if (iy >= 0) return 1;
    return x.localeCompare(y, undefined, { numeric: true });
  });
  return ids.map(id => ({ id, name: clusterName(id), count: count.get(id) }));
}

// scope = 'all' | 'cl:<cluster code>' | 'br:<branch code>' (one showroom/branch) | 'showrooms' (kept so old links still work)
async function scopeBranches(scope) {
  const b = await branches();
  let list, label;
  if (scope === 'all') { list = b.all; label = 'All clusters'; }
  else if (/^cl:/.test(scope)) { const id = scope.slice(3); list = b.all.filter(r => r.cl === id); label = clusterName(id); }
  else if (/^br:/.test(scope)) { const id = scope.slice(3); list = b.all.filter(r => r.bc === id); label = list.length ? list[0].name : id; }
  else { list = b.showrooms; label = clusterName(SHOWROOM_CL); }
  return { list, codes: list.map(x => x.bc), names: b.names, label };
}
// "IN (?)" with an empty list is a SQL error, so an empty cluster gets a code that matches nothing
const inList = codes => (codes.length ? codes : ['__none__']);

// ---------- request parsing ----------
function readRange(q) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const t = today();
  let to = re.test(q.to || '') ? q.to : t;
  if (to > t) to = t; // ignore future-dated rows
  let from = re.test(q.from || '') ? q.from : to.slice(0, 8) + '01';
  if (from > to) from = to;
  if (daysBetween(from, to) > 800) from = addDays(to, -800); // about 2 years
  return { from, to };
}
const readScope = q => { const s = String(q.scope || ''); return s === 'all' || /^(cl|br):[A-Za-z0-9_-]+$/.test(s) ? s : 'showrooms'; };

// ---------- SQL pieces ----------
// One list of all sales headers (cash + credit + hire purchase), cancelled bills removed.
function salesSub(from, to) {
  return {
    sql: `(SELECT bc,'cash' AS type,ddate,net_amount FROM t_cash_sales_sum WHERE is_cancel=0 AND ddate BETWEEN ? AND ?
           UNION ALL SELECT bc,'credit',ddate,net_amount FROM t_credit_sales_sum WHERE is_cancel=0 AND ddate BETWEEN ? AND ?
           UNION ALL SELECT bc,'hp',ddate,net_amount FROM t_hp_sales_sum WHERE is_cancel=0 AND ddate BETWEEN ? AND ?) s`,
    params: [from, to, from, to, from, to],
  };
}
const emptyTypes = () => ({ cash: 0, credit: 0, hp: 0 });

async function periodTotals(from, to, codes) {
  const sub = salesSub(from, to);
  const [rows] = await pool.query(
    `SELECT type, COUNT(*) AS bills, SUM(net_amount) AS amt FROM ${sub.sql} WHERE bc IN (?) GROUP BY type`,
    [...sub.params, inList(codes)]);
  const out = { total: 0, bills: 0, byType: emptyTypes(), billsByType: emptyTypes() };
  for (const r of rows) {
    out.byType[r.type] = num(r.amt);
    out.billsByType[r.type] = num(r.bills);
    out.total += num(r.amt);
    out.bills += num(r.bills);
  }
  return out;
}

async function stockRows(codes) {
  const [rows] = await pool.query(
    `SELECT bc, COUNT(DISTINCT item_code) AS items, SUM(qty) AS qty, SUM(qty*purchase_price) AS value
     FROM m_item_batch_stock WHERE qty > 0 AND bc IN (?) GROUP BY bc`, [inList(codes)]);
  return rows.map(r => ({ bc: r.bc, items: num(r.items), qty: num(r.qty), value: num(r.value) }));
}

// ---------- API ----------
const app = express();
app.disable('x-powered-by');

const api = (handler) => async (req, res) => {
  try {
    const key = req.path + '?' + new URLSearchParams(req.query).toString();
    res.json(await cached(key, () => handler(req)));
  } catch (err) {
    console.error(req.path, err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
};

app.get('/api/meta', api(async () => {
  const t = today();
  const [r] = await pool.query(
    `SELECT GREATEST(
       IFNULL((SELECT MAX(ddate) FROM t_cash_sales_sum   WHERE is_cancel=0 AND ddate <= ?),'1970-01-01'),
       IFNULL((SELECT MAX(ddate) FROM t_credit_sales_sum WHERE is_cancel=0 AND ddate <= ?),'1970-01-01'),
       IFNULL((SELECT MAX(ddate) FROM t_hp_sales_sum     WHERE is_cancel=0 AND ddate <= ?),'1970-01-01')) AS latest`, [t, t, t]);
  const b = await branches();
  return { today: t, latestSalesDate: r[0].latest, showrooms: b.showrooms.map(x => ({ bc: x.bc, name: x.name })), branches: b.all.map(x => ({ bc: x.bc, name: x.name, cl: x.cl })), clusters: await clusterList(), backup: importer.getState() };
}));

// which branches are in which cluster (open /api/clusters in the browser to check the grouping)
app.get('/api/clusters', api(async () => {
  const b = await branches();
  const list = await clusterList();
  return { note: 'Set CLUSTER_NAMES in .env as code:name pairs, e.g. C1:Head Office,C3:Showrooms', clusters: list.map(c => ({ ...c, branches: b.all.filter(r => r.cl === c.id).map(r => r.bc + ' - ' + r.name) })) };
}));

app.get('/api/summary', api(async (req) => {
  const { from, to } = readRange(req.query);
  const { codes, label } = await scopeBranches(readScope(req.query));
  const len = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(len - 1));
  const [current, previous] = await Promise.all([periodTotals(from, to, codes), periodTotals(prevFrom, prevTo, codes)]);
  const [scopeStock, whStock] = await Promise.all([stockRows(codes), stockRows([WAREHOUSE])]);
  const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
  return {
    range: { from, to }, previousRange: { from: prevFrom, to: prevTo },
    current, previous,
    stock: {
      scopeLabel: label, scopeValue: sum(scopeStock, 'value'), scopeQty: sum(scopeStock, 'qty'),
      warehouseValue: sum(whStock, 'value'), warehouseQty: sum(whStock, 'qty'),
    },
  };
}));

app.get('/api/by-branch', api(async (req) => {
  const { from, to } = readRange(req.query);
  const { list, codes } = await scopeBranches(readScope(req.query));
  const sub = salesSub(from, to);
  const [rows] = await pool.query(
    `SELECT bc, type, COUNT(*) AS bills, SUM(net_amount) AS amt FROM ${sub.sql} WHERE bc IN (?) GROUP BY bc, type`,
    [...sub.params, inList(codes)]);
  const map = new Map(list.map(b => [b.bc, { bc: b.bc, name: b.name, cash: 0, credit: 0, hp: 0, total: 0, bills: 0 }]));
  for (const r of rows) {
    const o = map.get(r.bc); if (!o) continue;
    o[r.type] = num(r.amt); o.total += num(r.amt); o.bills += num(r.bills);
  }
  return { range: { from, to }, branches: [...map.values()].sort((a, b) => b.total - a.total) };
}));

app.get('/api/trend', api(async (req) => {
  const { from, to } = readRange(req.query);
  const { codes } = await scopeBranches(readScope(req.query));
  const sub = salesSub(from, to);
  const [rows] = await pool.query(
    `SELECT ddate, type, SUM(net_amount) AS amt FROM ${sub.sql} WHERE bc IN (?) GROUP BY ddate, type`,
    [...sub.params, inList(codes)]);
  const days = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) days.set(d, { date: d, ...emptyTypes() });
  for (const r of rows) { const o = days.get(r.ddate); if (o) o[r.type] = num(r.amt); }
  return { range: { from, to }, days: [...days.values()] };
}));

app.get('/api/stock', api(async (req) => {
  const { list, codes } = await scopeBranches(readScope(req.query));
  const rows = await stockRows(codes);
  const byBc = new Map(rows.map(r => [r.bc, r]));
  const branchesOut = list.map(b => ({ bc: b.bc, name: b.name, ...(byBc.get(b.bc) || { items: 0, qty: 0, value: 0 }) }))
    .sort((a, b) => b.value - a.value);
  return { branches: branchesOut };
}));

app.get('/api/top-items', api(async (req) => {
  const { from, to } = readRange(req.query);
  const { codes } = await scopeBranches(readScope(req.query));
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const [rows] = await pool.query(
    `SELECT x.code, MAX(m.description) AS description, SUM(x.qty) AS qty, SUM(x.amount) AS amount
     FROM (
       SELECT s.bc, d.code AS code, d.qty AS qty, d.amount AS amount FROM t_cash_sales_det d
         JOIN t_cash_sales_sum s ON s.cl=d.cl AND s.bc=d.bc AND s.nno=d.nno WHERE s.is_cancel=0 AND s.ddate BETWEEN ? AND ?
       UNION ALL
       SELECT s.bc, d.code, d.qty, d.amount FROM t_credit_sales_det d
         JOIN t_credit_sales_sum s ON s.cl=d.cl AND s.bc=d.bc AND s.nno=d.nno WHERE s.is_cancel=0 AND s.ddate BETWEEN ? AND ?
       UNION ALL
       SELECT s.bc, d.item_code, d.qty, d.amount FROM t_hp_sales_det d
         JOIN t_hp_sales_sum s ON s.cl=d.cl AND s.bc=d.bc AND s.nno=d.nno WHERE s.is_cancel=0 AND s.ddate BETWEEN ? AND ?
     ) x LEFT JOIN m_item m ON m.code = x.code
     WHERE x.bc IN (?) GROUP BY x.code ORDER BY amount DESC LIMIT ?`,
    [from, to, from, to, from, to, inList(codes), limit]);
  return { range: { from, to }, items: rows.map(r => ({ code: r.code, description: r.description || r.code, qty: num(r.qty), amount: num(r.amount) })) };
}));

// Company Analysis: adds /api/analysis and /api/analysis/schema
analysis.register(app, { pool, branches, scopeBranches });
hp.register(app, { pool, branches, scopeBranches });
hpCol.register(app, { pool, branches, scopeBranches });

// ---------- static files ----------
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(Number(PORT), HOST, () => {
  console.log(`Dashboard running:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  // after each new backup is loaded, drop cached results so the page shows the new data
  importer.start({ onImported: () => { cache.clear(); branchCache.t = 0; analysis.clear(); hp.clear(); hpCol.clear(); } });
});