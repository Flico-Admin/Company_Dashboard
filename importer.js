// importer.js: every few minutes looks for a newer backup zip, imports its .sql into a
// staging database, then swaps the tables into the live database (dashboard never sees half-loaded data).
require('dotenv').config({ path: require('path').join(__dirname, '.env') }); // always read .env next to this file
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const unzipper = require('unzipper');
const mysql = require('mysql2/promise');

const {
  DB_HOST = '127.0.0.1', DB_PORT = 3306, DB_NAME,
  BACKUP_DIR = 'D:\\SMTK\\Backup 30032026',
  SOURCE_DIR, IMPORT_USER, IMPORT_PASSWORD,
  MYSQL_BIN = 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe',
  IMPORT_CHECK_MINUTES = 10, IMPORT_ON_START = 'true',
} = process.env;

const STAGE = `${DB_NAME}_stage`, OLD = `${DB_NAME}_old`;
const WORK_DIR = path.join(__dirname, '_work');
const STATE_FILE = path.join(__dirname, 'import-state.json');
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}.*\.zip$/i; // e.g. "2026-10-17 09-00-03_eleacc_flico_New.zip"

let state = { status: 'idle', lastFile: null, importedAt: null, error: null };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (_) {}
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {} };

function latestZip() {
  if (!fs.existsSync(BACKUP_DIR)) throw new Error('Backup folder not found: ' + BACKUP_DIR);
  const names = fs.readdirSync(BACKUP_DIR).filter(f => BACKUP_NAME.test(f)).sort(); // name starts with date+time
  for (let i = names.length - 1; i >= 0; i--) {
    const full = path.join(BACKUP_DIR, names[i]);
    if (Date.now() - fs.statSync(full).mtimeMs > 120000) return { name: names[i], full }; // skip a zip still being written
  }
  return null;
}

async function extractSql(zipPath, outFile) {
  const dir = await unzipper.Open.file(zipPath);
  const entry = dir.files.find(f => f.type === 'File' && /\.sql$/i.test(f.path));
  if (!entry) throw new Error('No .sql file inside ' + path.basename(zipPath));
  await pipeline(entry.stream(), fs.createWriteStream(outFile));
}

// One line of the dump -> the line to run, or null to skip it.
// A statement that names the live database (DROP TABLE `eleacc_flico`.`x`) is pointed at the staging database instead,
// so an import can never touch the live tables before the swap.
const QUALIFIED = DB_NAME && /^[\w$]+$/.test(DB_NAME)
  ? new RegExp('^(\\s*(?:DROP\\s+(?:TABLE|VIEW)(?:\\s+IF\\s+EXISTS)?|CREATE\\s+(?:TABLE|VIEW)(?:\\s+IF\\s+NOT\\s+EXISTS)?|ALTER\\s+TABLE|LOCK\\s+TABLES|INSERT\\s+(?:IGNORE\\s+)?INTO|REPLACE\\s+INTO)\\s+)`?' + DB_NAME + '`?\\s*\\.', 'i')
  : null;
function prepareLine(line) {
  if (/^\s*(USE\s+`?\w+`?\s*;|CREATE\s+DATABASE\b|DROP\s+DATABASE\b)/i.test(line)) return null; // always load into the staging DB
  if (/^\s*(\/\*!\d+\s+)?SET\s+.*(@@GLOBAL|\bGLOBAL\b|SQL_LOG_BIN|GTID_PURGED)/i.test(line)) return null; // skip server-wide settings (needs SUPER)
  let out = line.replace(/DEFINER\s*=\s*(`[^`]*`|'[^']*')@(`[^`]*`|'[^']*')/gi, '');
  if (QUALIFIED) out = out.replace(QUALIFIED, '$1`' + STAGE + '`.');
  return out;
}

async function importSql(sqlFile) {
  const child = spawn(MYSQL_BIN, ['-h', DB_HOST, '-P', String(DB_PORT), '-u', IMPORT_USER, '--default-character-set=utf8mb4', STAGE],
    { env: { ...process.env, MYSQL_PWD: IMPORT_PASSWORD }, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', d => { err = (err + d).slice(-2000); });
  child.stdin.on('error', () => {});
  const closed = new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', c => (c === 0 ? res() : rej(new Error(`mysql exited with ${c}: ${err.trim()}`))));
  });
  closed.catch(() => {});
  // Tables of the dump are created in the staging database, and some dumps drop/create them in an order that breaks
  // foreign keys ("Cannot drop table ... referenced by a foreign key constraint"). Switching the checks off for this
  // one import session fixes that; the data itself is still loaded completely.
  child.stdin.write('SET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\n', 'latin1');
  // latin1 = bytes pass through unchanged, so the dump's own charset settings still apply
  const rl = readline.createInterface({ input: fs.createReadStream(sqlFile, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const out = prepareLine(line);
    if (out === null) continue;
    if (!child.stdin.write(out + '\n', 'latin1')) await Promise.race([once(child.stdin, 'drain'), closed]);
  }
  child.stdin.end();
  await closed;
}

async function baseTables(conn, db) {
  const [rows] = await conn.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [db]);
  return rows.map(r => r.t);
}

// runs one step of the import; if it fails, the error message says which step it was
async function step(name, fn) {
  try { return await fn(); } catch (e) { e.message = name + ': ' + e.message; throw e; }
}

async function swapIn(conn) {
  const staged = await baseTables(conn, STAGE);
  if (!staged.length) throw new Error('Import produced no tables');
  await step('create live db', () => conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``));
  await step('clear old db', () => conn.query(`DROP DATABASE IF EXISTS \`${OLD}\``));
  await step('create old db', () => conn.query(`CREATE DATABASE \`${OLD}\``));
  const live = new Set(await baseTables(conn, DB_NAME));
  const parts = [];
  for (const t of staged) {
    if (live.has(t)) parts.push(`\`${DB_NAME}\`.\`${t}\` TO \`${OLD}\`.\`${t}\``);
    parts.push(`\`${STAGE}\`.\`${t}\` TO \`${DB_NAME}\`.\`${t}\``);
  }
  await step('swap tables', () => conn.query('RENAME TABLE ' + parts.join(', '))); // one atomic statement
  await step('drop old db', () => conn.query(`DROP DATABASE \`${OLD}\``));
  await step('drop stage db', () => conn.query(`DROP DATABASE \`${STAGE}\``));
}

async function runImport(zip) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const sqlFile = path.join(WORK_DIR, 'backup.sql');
  const conn = await mysql.createConnection({ host: DB_HOST, port: Number(DB_PORT), user: IMPORT_USER, password: IMPORT_PASSWORD });
  try {
    // foreign keys must not block dropping or swapping whole databases ("Cannot drop table ... referenced by a foreign key")
    await conn.query('SET FOREIGN_KEY_CHECKS=0');
    await step('unzip', () => extractSql(zip.full, sqlFile));
    await step('clear stage db', () => conn.query(`DROP DATABASE IF EXISTS \`${STAGE}\``));
    await step('create stage db', () => conn.query(`CREATE DATABASE \`${STAGE}\` CHARACTER SET utf8mb4`));
    await step('load dump', () => importSql(sqlFile));
    await swapIn(conn);
  } finally {
    await conn.end().catch(() => {});
    fs.rmSync(sqlFile, { force: true });
  }
}

// Optional: newest zip lives on a network share -> copy it to BACKUP_DIR (local) first, then import from local.
// The backup tool writes the zip for ~15 minutes and Windows does not update the modified time while it is
// still writing, so we only copy a file after its size has stayed the same between two checks.
const seenSize = new Map(); // zip name -> size seen at the previous check
const MIN_BYTES = Number(process.env.MIN_BACKUP_MB || 1) * 1048576; // smaller zips are treated as empty/bad backups
function syncFromSource() {
  if (!SOURCE_DIR) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const names = fs.readdirSync(SOURCE_DIR).filter(f => BACKUP_NAME.test(f)).sort();
    for (let i = names.length - 1; i >= 0; i--) {
      const src = path.join(SOURCE_DIR, names[i]);
      const st = fs.statSync(src);
      if (Date.now() - st.mtimeMs <= 120000) continue; // changed very recently, still being written
      if (st.size < MIN_BYTES) continue; // empty / failed backup, ignore it
      const dest = path.join(BACKUP_DIR, names[i]);
      if (fs.existsSync(dest) && fs.statSync(dest).size === st.size) return; // newest is already local and complete
      const prev = seenSize.get(names[i]);
      seenSize.set(names[i], st.size);
      if (prev !== st.size) { console.log('[import] waiting for backup to finish writing:', names[i]); return; }
      console.log('[import] copying', names[i], 'from', SOURCE_DIR);
      fs.copyFileSync(src, dest + '.part');
      fs.renameSync(dest + '.part', dest);
      fs.utimesSync(dest, st.atime, st.mtime);
      if (state.failedFile === names[i]) { state.failedFile = null; state.failedAt = 0; }
      return;
    }
  } catch (e) { console.error('[import] copy failed:', e.message); }
}

let busy = false;
async function check(onImported) {
  if (busy) return;
  busy = true;
  try {
    syncFromSource();
    const zip = latestZip();
    if (!zip || zip.name === state.lastFile) return;
    if (state.failedFile === zip.name && Date.now() - state.failedAt < 3600e3) return; // retry a bad file once an hour
    try { await unzipper.Open.file(zip.full); } catch (_) { console.log('[import] zip not complete yet, will retry:', zip.name); return; }
    const t0 = Date.now();
    state = { ...state, status: 'importing', current: zip.name, error: null }; save();
    console.log('[import] start', zip.name);
    await runImport(zip);
    state = { status: 'ok', lastFile: zip.name, importedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), error: null };
    console.log(`[import] done ${zip.name} in ${state.seconds}s`);
    onImported && onImported();
  } catch (e) {
    console.error('[import] failed:', e.message);
    state = { ...state, status: 'error', error: String(e.message).slice(0, 300), failedFile: state.current, failedAt: Date.now() };
  } finally { busy = false; save(); }
}

function start({ onImported } = {}) {
  if (!/^[\w$]+$/.test(DB_NAME || '') || !IMPORT_USER) { console.log('[import] auto-import is OFF (set IMPORT_USER / IMPORT_PASSWORD in .env to turn it on)'); return; }
  state.failedFile = null; state.failedAt = 0; // after a restart, try the latest backup again straight away
  console.log(`[import] watching "${BACKUP_DIR}" every ${IMPORT_CHECK_MINUTES} min`);
  setInterval(() => check(onImported), Number(IMPORT_CHECK_MINUTES) * 60000);
  if (IMPORT_ON_START === 'true') setTimeout(() => check(onImported), 5000);
}

const getState = () => ({ status: state.status, lastFile: state.lastFile, importedAt: state.importedAt, error: state.error });
module.exports = { start, getState, _prepareLine: prepareLine };