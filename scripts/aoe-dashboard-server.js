import http from "node:http";
import { getDb, recordExecution, rebuildDailyStats } from "./aoe-dashboard-store.js";

const port = Number(process.env.AOE_DASHBOARD_PORT || 8787);
const db = getDb();
rebuildDailyStats(db);

let config = {
  pairs: ["BNB/USDT", "BTC/USDT", "SOL/USDT", "ETH/USDT"],
  buyAmount: 100,
  gasMultiplier: 1.25,
  maxGas: 0.25,
  maxRetries: 3,
  dailyMaxBuys: 12,
  dryRun: true,
  running: false,
  headlessAutoBuy: ["1", "true", "yes", "on"].includes(String(process.env.AUTO_BUY_ENABLED || "0").toLowerCase()),
};

const logs = [
  logItem("INFO", "Dashboard API ready, SQLite initialized at runtime-state/trades.db"),
  logItem("BUY", "BNB/USDT priority enabled for AOE scheduler"),
  logItem("INFO", "Loaded 7d / 30d / 90d startup statistics"),
];

function logItem(level, message) {
  return { id: crypto.randomUUID(), ts: new Date().toISOString(), level, message };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

function dateStart(days) {
  return new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
}

function rowsForPeriod(days) {
  return db
    .prepare(
      `SELECT day, turnover_usdt, trade_count, gas_usdt, net_invested_usdt
       FROM daily_stats
       WHERE day >= ?
       ORDER BY day ASC`,
    )
    .all(dateStart(days));
}

function kpi() {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const todayStats = db
    .prepare(
      `SELECT COUNT(*) AS buys, COALESCE(SUM(amount_usdt),0) AS turnover,
              COALESCE(SUM(gas_usdt),0) AS gas
       FROM executions WHERE substr(ts,1,10)=? AND side='BUY'`,
    )
    .get(today);
  const monthStats = db
    .prepare(
      `SELECT COUNT(*) AS trades, COALESCE(SUM(amount_usdt),0) AS turnover,
              COALESCE(SUM(gas_usdt),0) AS gas
       FROM executions WHERE substr(ts,1,7)=?`,
    )
    .get(month);
  return {
    todayBuys: todayStats.buys,
    todayTurnover: todayStats.turnover,
    todayTrades: todayStats.buys,
    todayGas: todayStats.gas,
    monthTurnover: monthStats.turnover,
    monthTrades: monthStats.trades,
    monthGas: monthStats.gas,
    walletBalance: 3.4821,
    usdtBalance: 18429.56,
    refreshedAt: new Date().toISOString(),
  };
}

function runtime() {
  const last = db.prepare("SELECT * FROM executions ORDER BY ts DESC LIMIT 1").get();
  const statusCycle = ["等待扫描", "扫描中", "等待提交", "提交中", "成功"];
  const status = statusCycle[Math.floor(Date.now() / 7000) % statusCycle.length];
  const target = new Date(Math.ceil(Date.now() / 60000) * 60000 + 90000);
  return {
    countdownSeconds: Math.max(0, Math.floor((target.getTime() - Date.now()) / 1000)),
    status,
    targetTime: target.toISOString(),
    scanStartTime: new Date(target.getTime() - 15000).toISOString(),
    estimatedGas: 0.14 + (Date.now() % 5) * 0.011,
    networkStatus: Date.now() % 4 === 0 ? "busy" : "normal",
    lastTrade: last || null,
  };
}

function markets(url) {
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = clampPageSize(url.searchParams.get("pageSize"), [20, 50, 100], 20);
  const search = `%${url.searchParams.get("search") || ""}%`;
  const sort = safeSort(url.searchParams.get("sort"), [
    "pair",
    "price",
    "change_5m",
    "change_15m",
    "change_1h",
    "change_24h",
    "volume_24h",
    "bid_volume",
    "ask_volume",
    "spread",
    "status",
  ]);
  const dir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";
  const offset = (page - 1) * pageSize;
  const where = "WHERE m1.pair LIKE ?";
  const total = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM market_snapshots m1
       WHERE m1.id IN (SELECT MAX(id) FROM market_snapshots GROUP BY pair)
         AND m1.pair LIKE ?`,
    )
    .get(search).total;
  const items = db
    .prepare(
      `SELECT * FROM market_snapshots m1
       WHERE m1.id IN (SELECT MAX(id) FROM market_snapshots GROUP BY pair)
         AND m1.pair LIKE ?
       ORDER BY ${sort} ${dir}
       LIMIT ? OFFSET ?`,
    )
    .all(search, pageSize, offset);
  return { page, pageSize, total, items };
}

function trades(url) {
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = clampPageSize(url.searchParams.get("pageSize"), [50, 100, 200, 500], 50);
  const q = `%${url.searchParams.get("search") || ""}%`;
  const from = url.searchParams.get("from") || "1970-01-01";
  const to = url.searchParams.get("to") || "2999-12-31";
  const sort = safeSort(url.searchParams.get("sort"), [
    "ts",
    "pair",
    "side",
    "amount_usdt",
    "price",
    "gas_usdt",
    "status",
    "duration_ms",
    "source",
  ]);
  const dir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";
  const params = [from, `${to}T23:59:59.999Z`, q, q, q];
  const total = db
    .prepare(
      `SELECT COUNT(*) AS total FROM executions
       WHERE ts BETWEEN ? AND ? AND (pair LIKE ? OR tx_hash LIKE ? OR status LIKE ?)`,
    )
    .get(...params).total;
  const items = db
    .prepare(
      `SELECT * FROM executions
       WHERE ts BETWEEN ? AND ? AND (pair LIKE ? OR tx_hash LIKE ? OR status LIKE ?)
       ORDER BY ${sort} ${dir}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return { page, pageSize, total, items };
}

function analytics(url) {
  const days = clampPageSize(url.searchParams.get("days"), [7, 30, 90], 30);
  const rows = rowsForPeriod(days);
  return { days, rows };
}

function strategy() {
  const rows = db
    .prepare(
      `SELECT pair,
              COUNT(*) AS trades,
              COALESCE(SUM(amount_usdt),0) AS turnover,
              COALESCE(AVG(amount_usdt),0) AS avg_amount,
              COALESCE(SUM(gas_usdt),0) AS gas,
              AVG(CASE WHEN status IN ('success','confirmed') THEN 1 ELSE 0 END) * 100 AS success_rate,
              AVG(CASE WHEN status NOT IN ('success','confirmed') THEN 1 ELSE 0 END) * 100 AS failure_rate,
              COALESCE(AVG(duration_ms),0) AS avg_delay_ms,
              COALESCE(MIN(duration_ms),0) AS fastest_ms,
              COALESCE(MAX(duration_ms),0) AS slowest_ms
       FROM executions
       WHERE ts >= ?
       GROUP BY pair
       ORDER BY CASE pair WHEN 'BNB/USDT' THEN 0 WHEN 'SOL/USDT' THEN 1 ELSE 2 END`,
    )
    .all(new Date(Date.now() - 30 * 86400000).toISOString());
  return { rows, trend: rowsForPeriod(30) };
}

function exportTrades(format) {
  const rows = db.prepare("SELECT * FROM executions ORDER BY ts DESC LIMIT 5000").all();
  const header = ["time", "pair", "side", "amount_usdt", "price", "gas_usdt", "status", "tx_hash", "duration_ms", "source"];
  const csv = [
    header.join(","),
    ...rows.map((row) =>
      header
        .map((key) => JSON.stringify(row[key === "time" ? "ts" : key] ?? ""))
        .join(","),
    ),
  ].join("\n");
  return { body: csv, type: format === "excel" ? "application/vnd.ms-excel" : "text/csv; charset=utf-8" };
}

function safeSort(value, allowed) {
  return allowed.includes(value) ? value : allowed[0];
}

function clampPageSize(value, allowed, fallback) {
  const size = Number(value || fallback);
  return allowed.includes(size) ? size : fallback;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/kpi") return json(res, 200, kpi());
    if (req.method === "GET" && url.pathname === "/api/config") return json(res, 200, config);
    if (req.method === "POST" && url.pathname === "/api/config") {
      config = { ...config, ...(await readBody(req)) };
      logs.unshift(logItem("INFO", `Config updated: ${config.pairs.join(", ")}`));
      return json(res, 200, config);
    }
    if (req.method === "GET" && url.pathname === "/api/runtime") return json(res, 200, runtime());
    if (req.method === "GET" && url.pathname === "/api/logs") {
      return json(res, 200, { items: logs.slice(0, 200) });
    }
    if (req.method === "GET" && url.pathname === "/api/markets") return json(res, 200, markets(url));
    if (req.method === "GET" && url.pathname === "/api/analytics") return json(res, 200, analytics(url));
    if (req.method === "GET" && url.pathname === "/api/trades") return json(res, 200, trades(url));
    if (req.method === "GET" && url.pathname === "/api/strategy") return json(res, 200, strategy());
    if (req.method === "GET" && url.pathname === "/api/export.csv") {
      const out = exportTrades("csv");
      return text(res, 200, out.body, out.type);
    }
    if (req.method === "GET" && url.pathname === "/api/export.xls") {
      const out = exportTrades("excel");
      return text(res, 200, out.body, out.type);
    }
    if (req.method === "POST" && url.pathname === "/api/executions") {
      const item = recordExecution(await readBody(req));
      logs.unshift(logItem(item.status === "success" ? "BUY" : "ERROR", `${item.pair} ${item.status} ${item.tx_hash || item.error || ""}`));
      return json(res, 201, item);
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    logs.unshift(logItem("ERROR", error.message));
    return json(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`AOE Dashboard API listening on http://localhost:${port}`);
  console.log(`SQLite: runtime-state/trades.db`);
});
