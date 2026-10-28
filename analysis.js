// analysis.js: "Company Analysis" API. Reads the same MySQL database as the dashboard (read only),
// sums the numbers, and hands them to analysis-core.js. Result is shown on /analysis.html.
//
//   GET /api/analysis          -> all numbers for the page (cached, see ANALYSIS_CACHE_MINUTES)
//   GET /api/analysis/schema   -> what the code found in the database (use this if something looks empty)
const { compute } = require('./analysis-core');

const {
  DB_NAME,
  ANALYSIS_MONTHS = 36,                 // how many months of history to load
  ANALYSIS_CACHE_MINUTES = 15,          // results are kept this long (cleared after every new backup import)
  ANALYSIS_CATEGORY_COLUMN = '',        // force the category column of m_item, e.g. main_category
  ANALYSIS_RETURN_TABLES = '',          // force return tables, e.g. t_sales_return_sum:t_sales_return_det
  ANALYSIS_GRN_TABLES = '',             // force GRN tables, e.g. t_grn_sum:t_grn_det
  ANALYSIS_OPENING_STOCK_UNTIL = '2026-06-10', // stock rows created on/before this day are the opening balance loaded into the system (age unknown)
  ANALYSIS_NEW_STOCK_DAYS = 180,        // stock received (GRN) within this many days is not shown as "no sales"
} = process.env;

const SAFE = /^[A-Za-z0-9_]+$/;          // table / column names are put into SQL text, so check them
const ident = s => { if (!SAFE.test(s)) throw new Error('Unsafe name: ' + s); return s; };
const num = v => (v === null || v === undefined ? 0 : Number(v));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); d.setDate(d.getDate() + n); return ymd(d); };

// the three sales tables (same ones the main dashboard uses)
const SALES = [
  { sum: 't_cash_sales_sum', det: 't_cash_sales_det', item: 'code' },
  { sum: 't_credit_sales_sum', det: 't_credit_sales_det', item: 'code' },
  { sum: 't_hp_sales_sum', det: 't_hp_sales_det', item: 'item_code' },
];

const cacheEntries = new Map(); // scope -> { t, promise }   (one result per cluster choice)
let schemaCache = null;  // what we found in information_schema

function clear() { cacheEntries.clear(); schemaCache = null; }

// ---------- find category column + return tables ----------
async function discover(pool) {
  if (schemaCache) return schemaCache;
  const out = { categoryColumn: null, categoryLookup: null, returnTables: [], grnTables: [], grnCandidates: [], notes: [] };

  const [cols] = await pool.query(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = ?`, [DB_NAME]);
  const byTable = new Map();
  for (const r of cols) {
    const t = r.t || r.T || r.TABLE_NAME, c = r.c || r.C || r.COLUMN_NAME;
    if (!byTable.has(t)) byTable.set(t, new Set());
    byTable.get(t).add(String(c).toLowerCase());
  }
  const has = (t, ...c) => byTable.has(t) && c.every(x => byTable.get(t).has(x));

  // category column of m_item
  const itemCols = byTable.get('m_item') ? [...byTable.get('m_item')] : [];
  if (ANALYSIS_CATEGORY_COLUMN) {
    out.categoryColumn = ANALYSIS_CATEGORY_COLUMN.toLowerCase();
    if (!itemCols.includes(out.categoryColumn)) {
      out.notes.push(`ANALYSIS_CATEGORY_COLUMN="${ANALYSIS_CATEGORY_COLUMN}" is not a column of m_item. Columns are: ${itemCols.join(', ')}`);
      out.categoryColumn = null;
    }
  } else {
    const pref = ['category', 'main_category', 'cat', 'category_code', 'main_cat', 'sub_category'];
    out.categoryColumn = pref.find(p => itemCols.includes(p)) || itemCols.find(c => c.includes('categ')) || null;
  }
  if (!out.categoryColumn) out.notes.push('No category column found in m_item. All items will show as "Uncategorized". Set ANALYSIS_CATEGORY_COLUMN in .env.');

  // lookup table that turns a category code into a name (optional)
  if (out.categoryColumn) {
    const cands = [`m_${out.categoryColumn}`, 'm_category', 'm_main_category', 'm_item_category'];
    out.categoryLookup = cands.find(t => has(t, 'code', 'description')) || null;
  }

  // sales return tables
  const wanted = [];
  if (ANALYSIS_RETURN_TABLES) {
    for (const pair of ANALYSIS_RETURN_TABLES.split(',').map(s => s.trim()).filter(Boolean)) {
      const [sum, det] = pair.split(':'); if (sum && det) wanted.push({ sum, det });
    }
  } else {
    for (const t of byTable.keys()) {
      const low = t.toLowerCase();
      if (!low.endsWith('_sum') || !low.includes('return') || !low.includes('sale') || low.includes('purchase')) continue;
      const det = t.slice(0, -4) + '_det';
      if (byTable.has(det)) wanted.push({ sum: t, det });
    }
  }
  for (const w of wanted) {
    if (!SAFE.test(w.sum) || !SAFE.test(w.det)) continue;
    const item = has(w.det, 'code') ? 'code' : has(w.det, 'item_code') ? 'item_code' : null;
    if (has(w.sum, 'bc', 'cl', 'nno', 'ddate') && has(w.det, 'bc', 'cl', 'nno', 'qty', 'amount') && item) {
      out.returnTables.push({ sum: w.sum, det: w.det, item, cancel: has(w.sum, 'is_cancel') });
    } else out.notes.push(`Skipped ${w.sum}/${w.det}: expected columns (bc, cl, nno, ddate in the sum table; bc, cl, nno, qty, amount and code/item_code in the det table) were not all found.`);
  }
  if (!out.returnTables.length) out.notes.push('No sales return tables found. Returns will show as 0. Set ANALYSIS_RETURN_TABLES in .env if the return tables have other names.');

  // GRN (goods received) tables: used to hide stock that arrived recently from the "no sales in 180 days" list
  out.grnCandidates = [...byTable.keys()].filter(t => /grn|good.?s?.?rec|purchase|_pur/i.test(t)).sort();
  const grnWanted = [];
  if (ANALYSIS_GRN_TABLES) {
    for (const pair of ANALYSIS_GRN_TABLES.split(',').map(x => x.trim()).filter(Boolean)) {
      const [sum, det] = pair.split(':'); if (sum && det) grnWanted.push({ sum, det });
    }
  } else {
    for (const t of byTable.keys()) {
      const low = t.toLowerCase();
      if (!low.endsWith('_sum') || !low.includes('grn') || low.includes('return') || low.includes('ret_')) continue;
      const det = t.slice(0, -4) + '_det';
      if (byTable.has(det)) grnWanted.push({ sum: t, det });
    }
  }
  for (const w of grnWanted) {
    if (!SAFE.test(w.sum) || !SAFE.test(w.det)) continue;
    const item = has(w.det, 'code') ? 'code' : has(w.det, 'item_code') ? 'item_code' : null;
    if (has(w.sum, 'bc', 'cl', 'nno', 'ddate') && has(w.det, 'bc', 'cl', 'nno') && item) {
      out.grnTables.push({ sum: w.sum, det: w.det, item, cancel: has(w.sum, 'is_cancel') });
    } else out.notes.push(`Skipped GRN tables ${w.sum}/${w.det}: expected bc, cl, nno, ddate in the sum table and bc, cl, nno and code/item_code in the det table.`);
  }
  if (!out.grnTables.length) out.notes.push('No GRN tables found, so recently received stock is NOT hidden from the "no sales in 180 days" list. Look at /api/analysis/schema (grnCandidates) and set ANALYSIS_GRN_TABLES in .env, e.g. t_grn_sum:t_grn_det.');

  schemaCache = out;
  return out;
}

// ---------- SQL pieces ----------
function unionSql(tables, from, to, withCancel) {
  const parts = [], params = [];
  for (const t of tables) {
    const cancel = withCancel(t) ? 's.is_cancel=0 AND ' : '';
    parts.push(`SELECT s.bc AS bc, s.ddate AS ddate, d.${ident(t.item)} AS code, d.qty AS qty, d.amount AS amount
                FROM ${ident(t.det)} d JOIN ${ident(t.sum)} s ON s.cl=d.cl AND s.bc=d.bc AND s.nno=d.nno
                WHERE ${cancel}s.ddate BETWEEN ? AND ?`);
    params.push(from, to);
  }
  return { sql: parts.join(' UNION ALL '), params };
}

async function latestSalesDate(pool, today) {
  const [r] = await pool.query(
    `SELECT GREATEST(
       IFNULL((SELECT MAX(ddate) FROM t_cash_sales_sum   WHERE is_cancel=0 AND ddate <= ?),'1970-01-01'),
       IFNULL((SELECT MAX(ddate) FROM t_credit_sales_sum WHERE is_cancel=0 AND ddate <= ?),'1970-01-01'),
       IFNULL((SELECT MAX(ddate) FROM t_hp_sales_sum     WHERE is_cancel=0 AND ddate <= ?),'1970-01-01')) AS latest`,
    [today, today, today]);
  return String(r[0].latest).slice(0, 10);
}

// ---------- category names ----------
async function loadItems(pool, found) {
  const items = new Map();
  const catCol = found.categoryColumn && SAFE.test(found.categoryColumn) ? found.categoryColumn : null;
  const [rows] = await pool.query(`SELECT code, description${catCol ? `, \`${catCol}\` AS cat` : ''} FROM m_item`);
  let names = null;
  if (catCol && found.categoryLookup) {
    const [l] = await pool.query(`SELECT code, description FROM ${ident(found.categoryLookup)}`);
    names = new Map(l.map(x => [String(x.code).trim(), String(x.description || '').trim()]));
  }
  for (const r of rows) {
    let cat = 'Uncategorized';
    if (catCol && r.cat !== null && r.cat !== undefined && String(r.cat).trim() !== '') {
      const raw = String(r.cat).trim();
      cat = (names && names.get(raw)) || raw;
    }
    items.set(String(r.code), { name: String(r.description || r.code).trim(), cat });
  }
  return items;
}

// ---------- main ----------
async function build(deps, scope) {
  const { pool, branches, scopeBranches } = deps;
  const found = await discover(pool);
  const b = await branches();
  const sc = scopeBranches ? await scopeBranches(scope) : { codes: b.all.map(x => x.bc), label: 'All clusters' };
  const codes = sc.codes;                                   // the branches of the chosen cluster (all branches except test ones for "all")
  if (!codes.length) throw new Error('No branches found for "' + sc.label + '". Open /api/clusters to see the clusters.');
  const nameOf = bc => b.names.get(bc) || bc;
  const today = ymd(new Date());

  const end = await latestSalesDate(pool, today);
  if (end < '2000-01-01') throw new Error('No sales found in the database.');
  // first day of the month, (ANALYSIS_MONTHS - 1) months before the month of "end"
  const sm = new Date(+end.slice(0, 4), +end.slice(5, 7) - 1 - (Number(ANALYSIS_MONTHS) - 1), 1);
  const from = ymd(sm);

  const e90 = addDays(end, -90), e180 = addDays(end, -180);
  const salesU = unionSql(SALES, from, end, () => true);
  const items = await loadItems(pool, found);
  const itemOf = c => items.get(String(c)) || { name: String(c), cat: 'Uncategorized' };

  // 1) sales lines, summed per month / branch / item
  const [salesRows] = await pool.query(
    `SELECT x.bc AS bc, DATE_FORMAT(x.ddate,'%Y-%m') AS ym, x.code AS code, COUNT(*) AS n,
            SUM(x.qty) AS qty, SUM(x.amount) AS amt,
            SUM(IF(x.ddate > ?, x.qty, 0)) AS s3, SUM(IF(x.ddate > ?, x.qty, 0)) AS s6,
            MIN(x.ddate) AS fd, MAX(x.ddate) AS ld
     FROM (${salesU.sql}) x WHERE x.bc IN (?) GROUP BY x.bc, ym, x.code`,
    [e90, e180, ...salesU.params, codes]);

  // 2) sales returns (if the return tables exist)
  let retRows = [];
  if (found.returnTables.length) {
    const retU = unionSql(found.returnTables, from, end, t => t.cancel);
    [retRows] = await pool.query(
      `SELECT x.bc AS bc, DATE_FORMAT(x.ddate,'%Y-%m') AS ym, x.code AS code, SUM(x.amount) AS amt,
              SUM(IF(x.ddate > ?, x.qty, 0)) AS s3, SUM(IF(x.ddate > ?, x.qty, 0)) AS s6
       FROM (${retU.sql}) x WHERE x.bc IN (?) GROUP BY x.bc, ym, x.code`,
      [e90, e180, ...retU.params, codes]);
  }

  // 3) number of bills per month / branch
  const billParts = SALES.map(t => `SELECT bc, ddate FROM ${t.sum} WHERE is_cancel=0 AND ddate BETWEEN ? AND ?`);
  const [billRows] = await pool.query(
    `SELECT x.bc AS bc, DATE_FORMAT(x.ddate,'%Y-%m') AS ym, COUNT(*) AS bills
     FROM (${billParts.join(' UNION ALL ')}) x WHERE x.bc IN (?) GROUP BY x.bc, ym`,
    [from, end, from, end, from, end, codes]);

  // 4) stock now (rows with a purchase price of Rs 1 or less are placeholders, counted in units but not in value)
  const [stockRows] = await pool.query(
    `SELECT bc, item_code AS code, SUM(qty) AS qty,
            SUM(qty * IF(purchase_price > 1, purchase_price, 0)) AS val,
            SUM(IF(purchase_price > 1, 0, qty)) AS qty_nc
     FROM m_item_batch_stock WHERE qty > 0 AND bc IN (?) GROUP BY bc, item_code`, [codes]);
  const [[neg]] = await pool.query(`SELECT COUNT(*) AS n FROM m_item_batch_stock WHERE qty < 0 AND bc IN (?)`, [codes]);

  // 5) GRN dates per item (all branches, because stock is often received at head office and moved to showrooms later)
  const grnDates = new Map(); // code -> { first, last }
  for (const g of found.grnTables) {
    const [gr] = await pool.query(
      `SELECT d.${ident(g.item)} AS code, MIN(s.ddate) AS fd, MAX(s.ddate) AS ld
       FROM ${ident(g.det)} d JOIN ${ident(g.sum)} s ON s.cl=d.cl AND s.bc=d.bc AND s.nno=d.nno
       WHERE ${g.cancel ? 's.is_cancel=0 AND ' : ''}s.ddate <= ? GROUP BY d.${ident(g.item)}`, [end]);
    for (const r of gr) {
      const code = String(r.code), fd = r.fd ? String(r.fd).slice(0, 10) : null, ld = r.ld ? String(r.ld).slice(0, 10) : null;
      const o = grnDates.get(code) || { first: fd, last: ld };
      if (fd && (!o.first || fd < o.first)) o.first = fd;
      if (ld && (!o.last || ld > o.last)) o.last = ld;
      grnDates.set(code, o);
    }
  }
  // items with no GRN record: the day the item first appeared in stock (all branches). Used only as a fallback.
  const [sfRows] = await pool.query(
    `SELECT item_code AS code, DATE_FORMAT(MIN(action_date), '%Y-%m-%d') AS fd FROM m_item_batch_stock WHERE qty > 0 GROUP BY item_code`);
  const stockFirst = new Map(sfRows.map(r => [String(r.code), r.fd]));
  const newCut = addDays(end, -Number(ANALYSIS_NEW_STOCK_DAYS));

  // ---- put it together ----
  const aggMap = new Map();
  const add = (r, field) => {
    const cat = itemOf(r.code).cat;
    const k = r.ym + '|' + r.bc + '|' + cat;
    const o = aggMap.get(k) || { ym: r.ym, bc: r.bc, cat, sales: 0, ret: 0, net: 0 };
    o[field] += num(r.amt);
    aggMap.set(k, o);
  };
  let lines = 0, first = end;
  const itemSales = new Map();
  for (const r of salesRows) {
    add(r, 'sales');
    lines += num(r.n);
    if (r.fd && String(r.fd).slice(0, 10) < first) first = String(r.fd).slice(0, 10);
    const code = String(r.code);
    const s = itemSales.get(code) || { code, s3: 0, s6: 0, last: null };
    s.s3 += num(r.s3); s.s6 += num(r.s6);
    const last = r.ld ? String(r.ld).slice(0, 10) : null;
    if (last && (!s.last || last > s.last)) s.last = last;
    itemSales.set(code, s);
  }
  for (const r of retRows) {
    add(r, 'ret');
    // returned units are taken off the units sold (selling speed uses net units, like the sales report)
    const code = String(r.code);
    const s = itemSales.get(code) || { code, s3: 0, s6: 0, last: null };
    s.s3 -= num(r.s3); s.s6 -= num(r.s6);
    itemSales.set(code, s);
  }
  const agg = [...aggMap.values()];
  for (const a of agg) a.net = a.sales - a.ret;   // net sales = sales minus returns

  const out = compute({
    agg,
    bills: billRows.map(r => ({ ym: r.ym, bc: r.bc, bills: num(r.bills) })),
    items, itemSales: [...itemSales.values()],
    stock: { rows: stockRows.map(r => ({ bc: r.bc, code: String(r.code), qty: num(r.qty), val: num(r.val), qty_nc: num(r.qty_nc) })), negRows: num(neg.n) },
    start: first, end, rows: lines, nameOf,
    returnsAvailable: found.returnTables.length > 0,
    grn: grnDates, stockFirst, openingUntil: String(ANALYSIS_OPENING_STOCK_UNTIL), grnCutoff: newCut, grnAvailable: found.grnTables.length > 0,
  });
  out.generated = new Date().toISOString();
  out.scope = scope;
  out.scope_label = sc.label;
  out.other_label = scope === 'all' ? 'Other branches' : sc.label; // name used for the non head-office part of the numbers
  return out;
}

function readScope(q) {
  const s = String(q.scope || 'all');
  return s === 'all' || s === 'showrooms' || /^(cl|br):[A-Za-z0-9_-]+$/.test(s) ? s : 'all';
}

function register(app, deps) {
  app.get('/api/analysis', async (req, res) => {
    try {
      const scope = readScope(req.query);
      const ttl = Number(ANALYSIS_CACHE_MINUTES) * 60 * 1000;
      let entry = cacheEntries.get(scope);
      if (req.query.refresh === '1' || !entry || Date.now() - entry.t > ttl) {
        const promise = build(deps, scope);
        entry = { t: Date.now(), promise };
        cacheEntries.set(scope, entry);
        promise.catch(() => { if (cacheEntries.get(scope) === entry) cacheEntries.delete(scope); });
      }
      res.json(await entry.promise);
    } catch (err) {
      console.error('/api/analysis', err.message);
      res.status(500).json({ error: 'Server error: ' + err.message });
    }
  });

  app.get('/api/analysis/schema', async (req, res) => {
    try {
      schemaCache = null;
      res.json(await discover(deps.pool));
    } catch (err) {
      res.status(500).json({ error: 'Server error: ' + err.message });
    }
  });
}

module.exports = { register, clear, discover, loadItems };