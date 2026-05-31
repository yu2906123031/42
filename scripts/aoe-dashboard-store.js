import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const runtimeDir = path.resolve(process.env.AOE_RUNTIME_DIR || "runtime-state");
export const dbPath = path.join(runtimeDir, "trades.db");

let db;

export function resetDbForTests() {
  if (db) db.close();
  db = undefined;
}

export function getDb() {
  if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
  if (!db) {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    initializeSchema(db);
    seedIfEmpty(db);
  }
  return db;
}

function ensureColumn(database, table, name, ddl) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function initializeSchema(database = getDb()) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      pair TEXT NOT NULL DEFAULT 'BNB/USDT',
      side TEXT NOT NULL DEFAULT 'BUY',
      amount_usdt REAL NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      gas_usdt REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'aoe',
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS auto_buy_locks (
      event_day TEXT NOT NULL,
      pair TEXT NOT NULL,
      market_address TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(event_day, pair)
    );
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      pair TEXT NOT NULL,
      price REAL NOT NULL,
      change_5m REAL NOT NULL,
      change_15m REAL NOT NULL,
      change_1h REAL NOT NULL,
      change_24h REAL NOT NULL,
      volume_24h REAL NOT NULL,
      bid_volume REAL NOT NULL,
      ask_volume REAL NOT NULL,
      spread REAL NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      day TEXT PRIMARY KEY,
      turnover_usdt REAL NOT NULL DEFAULT 0,
      trade_count INTEGER NOT NULL DEFAULT 0,
      gas_usdt REAL NOT NULL DEFAULT 0,
      net_invested_usdt REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS gas_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      gas_price_gwei REAL NOT NULL,
      gas_used INTEGER NOT NULL,
      gas_usdt REAL NOT NULL,
      network_status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_executions_ts ON executions(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_executions_pair ON executions(pair);
    CREATE INDEX IF NOT EXISTS idx_market_pair_ts ON market_snapshots(pair, ts DESC);
  `);
  for (const [name, ddl] of [
    ["market_address", "market_address TEXT"],
    ["token_id", "token_id TEXT"],
    ["outcome_name", "outcome_name TEXT"],
    ["event_day", "event_day TEXT"],
    ["nonce", "nonce INTEGER"],
    ["gas_price_gwei", "gas_price_gwei REAL"],
    ["effective_price", "effective_price REAL"],
    ["graph_price", "graph_price REAL"],
    ["max_price", "max_price REAL"],
    ["ot_out", "ot_out TEXT"],
    ["quote_out", "quote_out TEXT"],
    ["min_out", "min_out TEXT"],
    ["slippage_bps", "slippage_bps INTEGER"],
    ["buy_id", "buy_id INTEGER"],
    ["plan_id", "plan_id TEXT"],
  ]) ensureColumn(database, "executions", name, ddl);
}

export function acquireAutoBuyLock({ event_day, pair, market_address, status = "acquired", force = false }, database = getDb()) {
  const now = new Date().toISOString();
  if (force) {
    console.warn(`WARNING: AUTO_BUY_FORCE=1 overriding auto-buy lock event_day=${event_day} pair=${pair}`);
    database.prepare(`INSERT INTO auto_buy_locks(event_day,pair,market_address,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(event_day,pair) DO UPDATE SET market_address=excluded.market_address,status=excluded.status,updated_at=excluded.updated_at`).run(event_day, pair, market_address || null, status, now, now);
    return { acquired: true, lockId: { event_day, pair }, forced: true };
  }
  const result = database.prepare(`INSERT OR IGNORE INTO auto_buy_locks(event_day,pair,market_address,status,created_at,updated_at) VALUES(?,?,?,?,?,?)`).run(event_day, pair, market_address || null, status, now, now);
  return result.changes === 1
    ? { acquired: true, lockId: { event_day, pair } }
    : { acquired: false, lockId: { event_day, pair }, reason: "already_locked" };
}

export function updateAutoBuyLock(lockOrArgs, updates = {}, database = getDb()) {
  const lock = lockOrArgs?.event_day ? lockOrArgs : lockOrArgs?.lockId;
  if (!lock?.event_day || !lock?.pair) return;
  database.prepare(`UPDATE auto_buy_locks SET status=COALESCE(?,status), market_address=COALESCE(?,market_address), updated_at=? WHERE event_day=? AND pair=?`).run(updates.status || null, updates.market_address || null, new Date().toISOString(), lock.event_day, lock.pair);
}

export function recordExecution(input) {
  const database = getDb();
  const payload = {
    ts: input.ts || new Date().toISOString(), pair: input.pair || "BNB/USDT", side: input.side || "BUY",
    amount_usdt: Number(input.amount_usdt || 0), price: Number(input.price || input.effective_price || 0), gas_usdt: Number(input.gas_usdt || 0),
    status: input.status || "pending", tx_hash: input.tx_hash || null, duration_ms: Number(input.duration_ms || 0), source: input.source || "aoe-onchain-buy", error: input.error || null,
    market_address: input.market_address || null, token_id: input.token_id == null ? null : String(input.token_id), outcome_name: input.outcome_name || null, event_day: input.event_day || null,
    nonce: input.nonce == null ? null : Number(input.nonce), gas_price_gwei: input.gas_price_gwei == null ? null : Number(input.gas_price_gwei), effective_price: input.effective_price == null ? null : Number(input.effective_price),
    graph_price: input.graph_price == null ? null : Number(input.graph_price), max_price: input.max_price == null ? null : Number(input.max_price), ot_out: input.ot_out == null ? null : String(input.ot_out), quote_out: input.quote_out == null ? (input.ot_out == null ? null : String(input.ot_out)) : String(input.quote_out), min_out: input.min_out == null ? null : String(input.min_out), slippage_bps: input.slippage_bps == null ? null : Number(input.slippage_bps), buy_id: input.buy_id == null ? null : Number(input.buy_id), plan_id: input.plan_id == null ? null : String(input.plan_id),
  };
  if (["success", "confirmed"].includes(payload.status) && !payload.tx_hash) throw new Error("success execution requires tx_hash");
  const result = database.prepare(`INSERT INTO executions
    (ts,pair,side,amount_usdt,price,gas_usdt,status,tx_hash,duration_ms,source,error,market_address,token_id,outcome_name,event_day,nonce,gas_price_gwei,effective_price,graph_price,max_price,ot_out,quote_out,min_out,slippage_bps,buy_id,plan_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(payload.ts,payload.pair,payload.side,payload.amount_usdt,payload.price,payload.gas_usdt,payload.status,payload.tx_hash,payload.duration_ms,payload.source,payload.error,payload.market_address,payload.token_id,payload.outcome_name,payload.event_day,payload.nonce,payload.gas_price_gwei,payload.effective_price,payload.graph_price,payload.max_price,payload.ot_out,payload.quote_out,payload.min_out,payload.slippage_bps,payload.buy_id,payload.plan_id);
  rebuildDailyStats(database);
  return { id: Number(result.lastInsertRowid), ...payload };
}

export function rebuildDailyStats(database = getDb()) {
  database.exec(`DELETE FROM daily_stats; INSERT INTO daily_stats(day, turnover_usdt, trade_count, gas_usdt, net_invested_usdt)
    SELECT substr(ts, 1, 10), COALESCE(SUM(amount_usdt),0), COUNT(*), COALESCE(SUM(gas_usdt),0), COALESCE(SUM(CASE WHEN side='BUY' THEN amount_usdt ELSE -amount_usdt END),0)
    FROM executions WHERE status IN ('success','confirmed') AND source IN ('aoe-onchain-buy','aoe-auto-claim') GROUP BY substr(ts, 1, 10);`);
}

export function seedIfEmpty(database) {
  if (process.env.DASHBOARD_SEED_DEMO_DATA !== "1") { rebuildDailyStats(database); return; }
  const count = database.prepare("SELECT COUNT(*) AS count FROM executions").get().count;
  if (count > 0) { rebuildDailyStats(database); return; }
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO executions (ts,pair,side,amount_usdt,price,gas_usdt,status,tx_hash,duration_ms,source,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(now, "BNB/USDT", "BUY", 10, 0.001, 0.1, "success", "0xdemo", 100, "demo-seed", null);
  rebuildDailyStats(database);
}
