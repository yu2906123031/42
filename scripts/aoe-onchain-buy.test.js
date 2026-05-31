import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.NODE_ENV = "test";

const onchain = await import("./aoe-onchain-buy.js");
const runner = await import("./aoe-auto-runner.js");
const store = await import("./aoe-dashboard-store.js");
const claim = await import("./aoe-auto-claim.js");

const {
  shouldPrefetchApproval,
  applyGasPriceOverride,
  buildWeixinBuySuccessMessage,
  resolveBuyPlan,
  assertEffectivePriceWithinMax,
  canSkipApprovalCheck,
  classifySwapFailure,
} = onchain;
const { NonceManager, preflightAllowanceForBatch } = runner;
const { initializeSchema, acquireAutoBuyLock, recordExecution } = store;
const { claimableBuysQuery } = claim;

test("prefetches approval inside configured window before market start", () => {
  const startTimestamp = 1_700_000_010;
  const nowMs = 1_700_000_000_000;

  assert.equal(
    shouldPrefetchApproval({ status: "scheduled", start_timestamp: startTimestamp }, nowMs, 10_000),
    true,
  );
});

test("does not prefetch approval before configured window", () => {
  const startTimestamp = 1_700_000_011;
  const nowMs = 1_700_000_000_000;

  assert.equal(
    shouldPrefetchApproval({ status: "scheduled", start_timestamp: startTimestamp }, nowMs, 10_000),
    false,
  );
});

test("gas override multiplies current gas price", async () => {
  const request = { address: "0xrouter" };
  const publicClient = { getGasPrice: async () => 3_000_000_000n };

  const updated = await applyGasPriceOverride(publicClient, request, 15_000n);

  assert.deepEqual(updated, { address: "0xrouter", gasPrice: 4_500_000_000n });
});

test("gas override leaves request unchanged at 100% multiplier", async () => {
  const request = { address: "0xrouter" };
  const publicClient = { getGasPrice: async () => 3_000_000_000n };

  assert.equal(await applyGasPriceOverride(publicClient, request, 10_000n), request);
});

test("builds weixin success notification message", () => {
  const message = buildWeixinBuySuccessMessage({
    pair: "BNB/USDT",
    amount_usdt: 42,
    token_id: 1,
    tx_hash: "0xabc",
    duration_ms: 1234,
  });

  assert.match(message, /42 自动买入成功/);
  assert.match(message, /金额：42 USDT/);
  assert.match(message, /TX：0xabc/);
});

test("AUTO buy mode binds target token and market from opening snipe plan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoe-plan-"));
  fs.mkdirSync(path.join(dir, "runtime-state"));
  fs.writeFileSync(path.join(dir, "runtime-state", "opening_snipe_plans.json"), JSON.stringify({
    plans: [{
      pair: "BNB/USDT",
      event_day: "2026-06-01",
      market_address: "0x1111111111111111111111111111111111111111",
      selected_token_id: "42",
      outcome_name: "UP",
      buy_amount_usdt: "7",
      max_price: "0.44",
      confidence: "high",
      reason: "unit test",
    }],
  }));

  const resolved = resolveBuyPlan({ cwd: dir, env: { AOE_BUY_MODE: "AUTO", AOE_PAIR: "BNB/USDT", EVENT_DAY: "2026-06-01" } });

  assert.equal(resolved.plan.selected_token_id, "42");
  assert.equal(resolved.plan.market_address, "0x1111111111111111111111111111111111111111");
  assert.equal(resolved.plan.outcome_name, "UP");
});

test("AUTO buy mode refuses TARGET_TOKEN_ID fallback without a plan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoe-no-plan-"));

  assert.throws(
    () => resolveBuyPlan({ cwd: dir, env: { AOE_BUY_MODE: "AUTO", TARGET_TOKEN_ID: "99" } }),
    /requires opening_snipe_plans\.json/,
  );
});

test("effective price guard blocks quotes above max price", () => {
  assert.throws(
    () => assertEffectivePriceWithinMax({
      quote: { collateralFromUser: 50_000_000n, otToUser: 100_000_000_000_000_000_000n },
      maxPrice: 0.45,
      collateralDecimals: 6,
      otDecimals: 18,
    }),
    /> maxPrice/,
  );
});

test("nonce manager allocates unique consecutive nonces for concurrent pairs", () => {
  const manager = new NonceManager(12);

  assert.deepEqual([...manager.allocateForPairs(["BNB/USDT", "BTC/USDT", "SOL/USDT"]).entries()], [
    ["BNB/USDT", 12],
    ["BTC/USDT", 13],
    ["SOL/USDT", 14],
  ]);
});

test("auto-buy locks reject duplicate pair for the same event day", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeSchema(db);
    const first = acquireAutoBuyLock({ event_day: "2026-06-01", pair: "BNB/USDT", market_address: "0x111" }, db);
    const second = acquireAutoBuyLock({ event_day: "2026-06-01", pair: "BNB/USDT", market_address: "0x222" }, db);

    assert.equal(first.acquired, true);
    assert.equal(second.acquired, false);
    assert.equal(second.reason, "already_locked");
  } finally {
    db.close();
  }
});

test("claim query binds claims to buy_id and token_id from execution records", () => {
  const sql = claimableBuysQuery();

  assert.match(sql, /token_id/);
  assert.match(sql, /market_address IS NOT NULL/);
  assert.match(sql, /c\.buy_id = b\.id/);
});


test("batch allowance approves once when allowance is below total amount", async () => {
  const calls = [];
  const publicClient = {
    readContract: async () => 1n,
    waitForTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash }),
  };
  const walletClient = { writeContract: async (request) => { calls.push(request); return "0xapprove"; } };
  const result = await preflightAllowanceForBatch({
    publicClient,
    walletClient,
    account: { address: "0xabc" },
    pairs: ["BNB/USDT", "BTC/USDT"],
    amounts: { "BNB/USDT": "5", "BTC/USDT": "2" },
    dryRun: false,
    logFn: () => {},
  });

  assert.equal(result.approved, true);
  assert.equal(result.approvalSent, true);
  assert.equal(calls.length, 1);
});

test("batch allowance blocks buys when approval receipt is not successful", async () => {
  const publicClient = {
    readContract: async () => 0n,
    waitForTransactionReceipt: async () => ({ status: "reverted" }),
  };
  const walletClient = { writeContract: async () => "0xapprove" };
  const result = await preflightAllowanceForBatch({
    publicClient,
    walletClient,
    account: { address: "0xabc" },
    pairs: ["BNB/USDT"],
    amounts: { "BNB/USDT": "5" },
    dryRun: false,
    logFn: () => {},
  });

  assert.equal(result.approved, false);
});

test("SKIP_APPROVAL_CHECK is only honored after runner batch approval", () => {
  assert.equal(canSkipApprovalCheck({ SKIP_APPROVAL_CHECK: "1" }), false);
  assert.equal(canSkipApprovalCheck({ SKIP_APPROVAL_CHECK: "1", BATCH_APPROVAL_DONE: "1" }), true);
});

test("executions migration keeps old rows and adds context columns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE executions (
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
    );`);
    db.prepare("INSERT INTO executions(ts,pair,side,amount_usdt,price,gas_usdt,status,tx_hash,duration_ms,source,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("2026-05-31T00:00:00Z", "BNB/USDT", "BUY", 1, 0.1, 0, "failed", null, 1, "aoe-onchain-buy", "old");
    initializeSchema(db);
    const columns = db.prepare("PRAGMA table_info(executions)").all().map((row) => row.name);
    assert.ok(columns.includes("quote_out"));
    assert.ok(columns.includes("plan_id"));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM executions").get().count, 1);
  } finally { db.close(); }
});

test("success execution without tx_hash is rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aoe-db-"));
  const old = process.env.AOE_RUNTIME_DIR;
  process.env.AOE_RUNTIME_DIR = dir;
  store.resetDbForTests();
  try {
    assert.throws(() => recordExecution({ status: "success", pair: "BNB/USDT" }), /requires tx_hash/);
  } finally {
    store.resetDbForTests();
    if (old === undefined) delete process.env.AOE_RUNTIME_DIR; else process.env.AOE_RUNTIME_DIR = old;
  }
});

test("nonce manager allocates four unique consecutive nonces", () => {
  const manager = new NonceManager(40);
  assert.deepEqual([...manager.allocateForPairs(["BNB/USDT", "BTC/USDT", "SOL/USDT", "ETH/USDT"]).values()], [40, 41, 42, 43]);
});

test("swap diagnostics classify quote and funding reverts", () => {
  assert.equal(classifySwapFailure({ retryQuote: { otToUser: 10n }, minOut: 11n }), "quote_or_slippage_revert");
  assert.equal(classifySwapFailure({ allowance: 1n, amountWei: 2n }), "funding_revert");
});


test("real stats exclude demo and scheduler sources", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeSchema(db);
    db.prepare("INSERT INTO executions(ts,pair,side,amount_usdt,price,gas_usdt,status,tx_hash,duration_ms,source,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("2026-05-31T00:00:00Z", "BNB/USDT", "BUY", 5, 0.1, 0.01, "success", "0xreal", 1, "aoe-onchain-buy", null);
    db.prepare("INSERT INTO executions(ts,pair,side,amount_usdt,price,gas_usdt,status,tx_hash,duration_ms,source,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("2026-05-31T00:01:00Z", "BNB/USDT", "BUY", 100, 0.1, 0.01, "success", "0xdemo", 1, "manual", null);
    store.rebuildDailyStats(db);
    const row = db.prepare("SELECT trade_count, turnover_usdt FROM daily_stats WHERE day='2026-05-31'").get();
    assert.equal(row.trade_count, 1);
    assert.equal(row.turnover_usdt, 5);
  } finally { db.close(); }
});
