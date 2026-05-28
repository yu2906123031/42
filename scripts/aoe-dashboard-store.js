import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const runtimeDir = path.resolve("runtime-state");
export const dbPath = path.join(runtimeDir, "trades.db");

let db;

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
}

export function recordExecution(input) {
  const database = getDb();
  const payload = {
    ts: input.ts || new Date().toISOString(),
    pair: input.pair || "BNB/USDT",
    side: input.side || "BUY",
    amount_usdt: Number(input.amount_usdt || 0),
    price: Number(input.price || 0),
    gas_usdt: Number(input.gas_usdt || 0),
    status: input.status || "pending",
    tx_hash: input.tx_hash || null,
    duration_ms: Number(input.duration_ms || 0),
    source: input.source || "aoe-onchain-buy",
    error: input.error || null,
  };

  database
    .prepare(
      `INSERT INTO executions
       (ts, pair, side, amount_usdt, price, gas_usdt, status, tx_hash, duration_ms, source, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      payload.ts,
      payload.pair,
      payload.side,
      payload.amount_usdt,
      payload.price,
      payload.gas_usdt,
      payload.status,
      payload.tx_hash,
      payload.duration_ms,
      payload.source,
      payload.error,
    );

  rebuildDailyStats(database);
  return payload;
}

export function rebuildDailyStats(database = getDb()) {
  database.exec(`
    DELETE FROM daily_stats;
    INSERT INTO daily_stats(day, turnover_usdt, trade_count, gas_usdt, net_invested_usdt)
    SELECT
      substr(ts, 1, 10) AS day,
      COALESCE(SUM(amount_usdt), 0),
      COUNT(*),
      COALESCE(SUM(gas_usdt), 0),
      COALESCE(SUM(CASE WHEN side = 'BUY' THEN amount_usdt ELSE -amount_usdt END), 0)
    FROM executions
    WHERE status IN ('success', 'confirmed')
    GROUP BY substr(ts, 1, 10);
  `);
}

function seedIfEmpty(database) {
  const count = database.prepare("SELECT COUNT(*) AS count FROM executions").get().count;
  if (count > 0) {
    rebuildDailyStats(database);
    return;
  }

  const pairs = ["BNB/USDT", "SOL/USDT", "ETH/USDT"];
  const insertExecution = database.prepare(
    `INSERT INTO executions
     (ts, pair, side, amount_usdt, price, gas_usdt, status, tx_hash, duration_ms, source, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertGas = database.prepare(
    `INSERT INTO gas_stats(ts, gas_price_gwei, gas_used, gas_usdt, network_status)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertMarket = database.prepare(
    `INSERT INTO market_snapshots
     (ts, pair, price, change_5m, change_15m, change_1h, change_24h, volume_24h, bid_volume, ask_volume, spread, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = Date.now();
  const basePrice = { "BNB/USDT": 682, "SOL/USDT": 168, "ETH/USDT": 3840 };
  for (let day = 89; day >= 0; day -= 1) {
    for (let i = 0; i < 3; i += 1) {
      const pair = pairs[(day + i) % pairs.length];
      const ts = new Date(now - day * 86400000 - i * 11100000).toISOString();
      const amount = pair === "BNB/USDT" ? 180 + ((day + i) % 9) * 23 : 70 + ((day + i) % 6) * 18;
      const gas = 0.08 + ((day + i) % 7) * 0.026;
      const ok = (day + i) % 11 !== 0;
      insertExecution.run(
        ts,
        pair,
        "BUY",
        amount,
        basePrice[pair] * (1 + Math.sin((day + i) / 8) * 0.025),
        gas,
        ok ? "success" : "failed",
        ok ? `0x${String(day).padStart(2, "0")}${String(i).repeat(58)}` : null,
        420 + ((day + i) % 13) * 95,
        i % 2 === 0 ? "aoe-scheduler" : "manual",
        ok ? null : "Gas cap reached before submission",
      );
      insertGas.run(ts, 2.2 + ((day + i) % 8) * 0.34, 140000 + i * 18000, gas, gas > 0.18 ? "congested" : "normal");
    }
  }

  for (const pair of pairs) {
    for (let i = 0; i < 180; i += 1) {
      const ts = new Date(now - i * 60000).toISOString();
      const drift = Math.sin(i / 9) * 0.012 + (pair === "BNB/USDT" ? 0.004 : 0);
      insertMarket.run(
        ts,
        pair,
        basePrice[pair] * (1 + drift),
        drift * 100,
        Math.sin(i / 13) * 2,
        Math.cos(i / 17) * 3,
        Math.sin(i / 23) * 5,
        12000000 + i * 9250,
        820000 + i * 1600,
        790000 + i * 1420,
        0.012 + (i % 9) * 0.002,
        i % 17 === 0 ? "degraded" : "online",
      );
    }
  }

  rebuildDailyStats(database);
}
