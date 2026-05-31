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
const generator = await import("./aoe-opening-plan-generator.js");

const {
  shouldPrefetchApproval,
  applyGasPriceOverride,
  buildWeixinBuySuccessMessage,
  resolveBuyPlan,
  assertEffectivePriceWithinMax,
  canSkipApprovalCheck,
  classifySwapFailure,
  shouldPreSignOpeningTx,
  shouldUsePreSign,
} = onchain;
const { NonceManager, preflightAllowanceForBatch } = runner;
const { initializeSchema, acquireAutoBuyLock, updateAutoBuyLock, recordExecution } = store;
const { claimableBuysQuery } = claim;
const {
  parseOutcomeRange,
  estimateDailyVolume,
  detectVolumeRegime,
  estimateDailyVolumeByRegime,
  selectOutcome,
  generateOpeningSnipePlans,
  amountForPair,
} = generator;

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

test("HYBRID opening mode does not pre-sign unless explicitly enabled", () => {
  assert.equal(shouldPreSignOpeningTx(undefined), false);
  assert.equal(shouldUsePreSign({ openingExecutionMode: "FAST_PRESIGN" }), true);
  assert.equal(shouldUsePreSign({ openingExecutionMode: "SAFE_SIMULATE", preSignOpeningTxEnv: "1" }), false);
  assert.equal(shouldUsePreSign({ openingExecutionMode: "HYBRID", preSignOpeningTxEnv: undefined }), false);
  assert.equal(shouldUsePreSign({ openingExecutionMode: "HYBRID", preSignOpeningTxEnv: "1" }), false);
  assert.equal(shouldUsePreSign({ openingExecutionMode: "HYBRID", hybridPresignAfterQuoteEnv: "1" }), true);
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

test("auto-claim flow uses exact market address and skips pair date discovery", async () => {
  const calls = [];
  await claim.runAutoClaim({
    env: { AUTO_CLAIM_ENABLED: "1", PRIVATE_KEY: "0x" + "1".repeat(64), AUTO_CLAIM_DRY_RUN: "1" },
    claimableBuysFn: () => [{ id: 7, pair: "BNB/USDT", ts: "2026-06-01T00:00:00Z", market_address: "0xabc", token_id: "2", outcome_name: "UP", event_day: "2026-06-01" }],
    clientsFn: async () => ({ publicClient: {}, walletClient: {} }),
    getMarketByAddressFn: async (address) => { calls.push(["exact", address]); return { market_address: address, status: "finalised", outcomes: [{ token_id: "2", payout_hmr: "1", name: "UP" }] }; },
    discoverMarketFn: async () => { throw new Error("legacy discovery should not be called"); },
    claimOneFn: async ({ buy, market }) => { calls.push(["claim", buy.market_address, buy.token_id, market.market_address]); },
    logFn: () => {},
  });
  assert.deepEqual(calls, [["exact", "0xabc"], ["claim", "0xabc", "2", "0xabc"]]);
});

test("auto-claim skips legacy buy rows without market binding", async () => {
  const calls = [];
  await claim.runAutoClaim({
    env: { AUTO_CLAIM_ENABLED: "1", PRIVATE_KEY: "0x" + "1".repeat(64), AUTO_CLAIM_DRY_RUN: "1" },
    claimableBuysFn: () => [{ id: 8, pair: "BNB/USDT", ts: "2026-06-01T00:00:00Z", market_address: null, token_id: null }],
    clientsFn: async () => ({ publicClient: {}, walletClient: {} }),
    getMarketByAddressFn: async () => { calls.push("exact"); },
    discoverMarketFn: async () => { calls.push("discover"); },
    claimOneFn: async () => { calls.push("claim"); },
    logFn: (msg) => { if (msg.includes("legacy_skip")) calls.push("legacy_skip"); },
  });
  assert.deepEqual(calls, ["legacy_skip"]);
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

test("SKIP_APPROVAL_CHECK is only honored for matching owner and covered amount", () => {
  assert.equal(canSkipApprovalCheck({ SKIP_APPROVAL_CHECK: "1" }, { account: { address: "0xabc" }, amountWei: 2n }), false);
  assert.equal(canSkipApprovalCheck({ SKIP_APPROVAL_CHECK: "1", BATCH_APPROVAL_DONE: "1", BATCH_APPROVAL_OWNER: "0xdef", BATCH_APPROVAL_TOTAL_WEI: "10" }, { account: { address: "0xabc" }, amountWei: 2n }), false);
  assert.equal(canSkipApprovalCheck({ SKIP_APPROVAL_CHECK: "1", BATCH_APPROVAL_DONE: "1", BATCH_APPROVAL_OWNER: "0xabc", BATCH_APPROVAL_TOTAL_WEI: "1" }, { account: { address: "0xabc" }, amountWei: 2n }), false);
  assert.equal(canSkipApprovalCheck({ SKIP_APPROVAL_CHECK: "1", BATCH_APPROVAL_DONE: "1", BATCH_APPROVAL_OWNER: "0xAbC", BATCH_APPROVAL_TOTAL_WEI: "10" }, { account: { address: "0xabc" }, amountWei: 2n }), true);
});

test("auto-buy lock stores nonce error and tx hash updates", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeSchema(db);
    const lock = acquireAutoBuyLock({ event_day: "2026-06-02", pair: "BNB/USDT", market_address: "0x111" }, db);
    updateAutoBuyLock(lock.lockId, { status: "failed", nonce: 42, error: "boom", tx_hash: "0xtx" }, db);
    const row = db.prepare("SELECT nonce,error,tx_hash,status FROM auto_buy_locks WHERE event_day=? AND pair=?").get("2026-06-02", "BNB/USDT");
    assert.deepEqual({ ...row }, { nonce: 42, error: "boom", tx_hash: "0xtx", status: "failed" });
  } finally { db.close(); }
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


test("parseOutcomeRange supports compact and open volume ranges", () => {
  assert.deepEqual(parseOutcomeRange({ token_id: "1", name: "$100B - $200B", price_hmr: "0.3" }), {
    token_id: "1", outcome_name: "$100B - $200B", lower: 100_000_000_000, upper: 200_000_000_000, price_hmr: 0.3,
  });
  assert.equal(parseOutcomeRange({ token_id: "2", name: "Below 100M", price_hmr: "0.2" }).upper, 100_000_000);
  assert.equal(parseOutcomeRange({ token_id: "3", name: ">300K", price_hmr: "0.2" }).lower, 300_000);
  assert.equal(parseOutcomeRange({ token_id: "4", name: "100,000,000,000 - 200,000,000,000", price_hmr: "0.2" }).upper, 200_000_000_000);
});

test("estimateDailyVolume combines mocked Binance volume inputs", async () => {
  const fetchFn = async (url) => ({
    ok: true,
    json: async () => {
      if (url.includes("ticker/24hr")) return { quoteVolume: "1000" };
      if (url.includes("interval=1d")) return Array.from({ length: 8 }, (_, i) => [0, 0, 0, 0, 0, 0, 0, String(i === 7 ? 600 : 700)]);
      if (url.includes("interval=1h")) return Array.from({ length: 24 }, (_, i) => [0, 0, 0, 0, 0, 0, 0, String(i === 23 ? 20 : 10)]);
      throw new Error(url);
    },
  });
  const estimate = await estimateDailyVolume("BNB/USDT", { fetchFn, now: new Date("2026-06-01T12:00:00Z") });
  assert.equal(estimate.recent7d_avg, 700);
  assert.equal(estimate.current_24h_volume, 1000);
  assert.equal(estimate.regime, "NORMAL");
  assert.equal(estimate.raw_predicted_volume, 848);
  assert.ok(estimate.predicted_volume > 670 && estimate.predicted_volume < 690);
});

test("BNB spike regime requires volume and volatility confirmation and selects highest bucket with half size", () => {
  const regime = detectVolumeRegime({
    pair: "BNB/USDT",
    recent7dAvg: 300_000_000,
    previousDayVolume: 261_000_000,
    current24hVolume: 1_500_000_000,
    currentUtcDayVolume: 800_000_000,
    projectedFromToday: 1_600_000_000,
    last1hVolume: 90_000_000,
    recent1hAvg: 25_000_000,
    last3hVolume: 270_000_000,
    recent3hAvg: 75_000_000,
    realizedVol1hRatio: 2.4,
    realizedVol3hRatio: 2.1,
    elapsedDayRatio: 0.5,
  });
  assert.equal(regime.regime, "SPIKE");
  assert.ok(regime.reasons.includes("volatility_confirmed"));
  const prediction = estimateDailyVolumeByRegime({
    pair: "BNB/USDT",
    recent7dAvg: 300_000_000,
    previousDayVolume: 261_000_000,
    current24hVolume: 1_500_000_000,
    currentUtcDayVolume: 800_000_000,
    projectedFromToday: 1_600_000_000,
    lastHoursMomentumProjected: 1_900_000_000,
    elapsedDayRatio: 0.5,
    regime,
  });
  const outcomes = [
    { token_id: "low", outcome_name: "Below $500M", lower: 0, upper: 500_000_000, price_hmr: 0.2 },
    { token_id: "mid", outcome_name: "$500M - $850M", lower: 500_000_000, upper: 850_000_000, price_hmr: 0.25 },
    { token_id: "top", outcome_name: "> $850M", lower: 850_000_000, upper: Infinity, price_hmr: 0.3 },
  ];
  const selected = selectOutcome(outcomes, prediction, { pair: "BNB/USDT", maxPrice: 0.45, minConfidence: 0, baseBuyAmount: "2" });
  assert.equal(selected.token_id, "top");
  assert.equal(selected.downgrade_reasons.includes("opening_high_bucket_downgrade"), false);
  assert.equal(selected.amount_factor, 0.5);
});

test("BNB post-spike cooldown ignores rolling 24h residue", () => {
  const regime = detectVolumeRegime({
    pair: "BNB/USDT",
    recent7dAvg: 300_000_000,
    previousDayVolume: 1_593_000_000,
    current24hVolume: 1_300_000_000,
    currentUtcDayVolume: 180_000_000,
    projectedFromToday: 450_000_000,
    last1hVolume: 10_000_000,
    recent1hAvg: 20_000_000,
    last3hVolume: 30_000_000,
    recent3hAvg: 60_000_000,
    realizedVol1hRatio: 0.8,
    realizedVol3hRatio: 0.7,
    elapsedDayRatio: 0.4,
  });
  assert.equal(regime.regime, "POST_SPIKE_COOLDOWN");
  assert.ok(regime.reasons.includes("rolling_24h_residue_ignored"));
  const prediction = estimateDailyVolumeByRegime({
    pair: "BNB/USDT",
    recent7dAvg: 300_000_000,
    previousDayVolume: 1_593_000_000,
    current24hVolume: 1_300_000_000,
    currentUtcDayVolume: 180_000_000,
    projectedFromToday: 450_000_000,
    lastHoursMomentumProjected: 240_000_000,
    elapsedDayRatio: 0.4,
    regime,
  });
  assert.equal(prediction.regime, "POST_SPIKE_COOLDOWN");
  assert.ok(prediction.regime_reasons.includes("rolling_24h_residue_ignored"));
  assert.ok(prediction.conservative_predicted_volume < 500_000_000);
});

test("normal regime applies conservative and early-session discounts with lower-half downgrade", () => {
  const regime = detectVolumeRegime({
    pair: "BTC/USDT",
    recent7dAvg: 10_000_000_000,
    previousDayVolume: 9_000_000_000,
    current24hVolume: 9_500_000_000,
    currentUtcDayVolume: 2_000_000_000,
    projectedFromToday: 9_000_000_000,
    last1hVolume: 300_000_000,
    recent1hAvg: 350_000_000,
    last3hVolume: 900_000_000,
    recent3hAvg: 1_050_000_000,
    realizedVol1hRatio: 1.0,
    realizedVol3hRatio: 1.0,
    elapsedDayRatio: 0.25,
  });
  const prediction = estimateDailyVolumeByRegime({
    pair: "BTC/USDT",
    recent7dAvg: 10_000_000_000,
    previousDayVolume: 9_000_000_000,
    current24hVolume: 9_500_000_000,
    currentUtcDayVolume: 2_000_000_000,
    projectedFromToday: 9_000_000_000,
    lastHoursMomentumProjected: 8_000_000_000,
    elapsedDayRatio: 0.25,
    regime,
  });
  assert.equal(prediction.regime, "NORMAL");
  assert.ok(prediction.conservative_predicted_volume < prediction.raw_predicted_volume * 0.73);
  const outcomes = [
    { token_id: "low", outcome_name: "Below $5B", lower: 0, upper: 5_000_000_000, price_hmr: 0.2 },
    { token_id: "mid", outcome_name: "$5B - $10B", lower: 5_000_000_000, upper: 10_000_000_000, price_hmr: 0.25 },
    { token_id: "high", outcome_name: "> $10B", lower: 10_000_000_000, upper: Infinity, price_hmr: 0.3 },
  ];
  const selected = selectOutcome(outcomes, { ...prediction, conservative_predicted_volume: 5_600_000_000 }, { pair: "BTC/USDT", maxPrice: 0.45, minConfidence: 0 });
  assert.equal(selected.token_id, "low");
  assert.ok(selected.downgrade_reasons.includes("normal_lower_half_downgrade"));
});

test("allowSpikeMode false downgrades detected BTC spike to transition and blocks highest bucket chase", () => {
  const regime = detectVolumeRegime({
    pair: "BTC/USDT",
    recent7dAvg: 10_000_000_000,
    previousDayVolume: 9_000_000_000,
    current24hVolume: 30_000_000_000,
    currentUtcDayVolume: 15_000_000_000,
    projectedFromToday: 32_000_000_000,
    last1hVolume: 2_000_000_000,
    recent1hAvg: 500_000_000,
    last3hVolume: 6_000_000_000,
    recent3hAvg: 1_500_000_000,
    realizedVol1hRatio: 3,
    realizedVol3hRatio: 2.5,
    elapsedDayRatio: 0.5,
  });
  assert.equal(regime.regime, "TRANSITION");
  assert.ok(regime.reasons.includes("pair_spike_disabled"));
  const outcomes = [
    { token_id: "mid", outcome_name: "$10B - $25B", lower: 10_000_000_000, upper: 25_000_000_000, price_hmr: 0.2 },
    { token_id: "top", outcome_name: "> $25B", lower: 25_000_000_000, upper: Infinity, price_hmr: 0.2 },
  ];
  const selected = selectOutcome(outcomes, { regime: "TRANSITION", conservative_predicted_volume: 27_000_000_000, predicted_volume: 27_000_000_000, data_complete: true }, { pair: "BTC/USDT", maxPrice: 0.45, minConfidence: 0, maxOpeningBucketIndex: 0 });
  assert.equal(selected.token_id, "mid");
});

test("amountForPair defaults BNB opening buys to 2 USDT", () => {
  assert.equal(amountForPair("BNB/USDT", {}), "2");
});

test("selectOutcome chooses containing range and respects price/confidence gates", () => {
  const outcomes = [
    { token_id: "1", outcome_name: "0-100", lower: 0, upper: 100, price_hmr: 0.2 },
    { token_id: "2", outcome_name: "100-200", lower: 100, upper: 200, price_hmr: 0.3 },
  ];
  assert.equal(selectOutcome(outcomes, { predicted_volume: 150, data_complete: true }, { maxPrice: 0.45 }).token_id, "2");
  assert.equal(selectOutcome(outcomes, { predicted_volume: 150, data_complete: true }, { maxPrice: 0.25, minConfidence: 0 })?.token_id, "1");
  assert.equal(selectOutcome(outcomes, { predicted_volume: 150, data_complete: true }, { maxPrice: 0.1 }), null);
  assert.equal(selectOutcome(outcomes, { predicted_volume: 99, data_complete: false }, { maxPrice: 0.45, minConfidence: 95 }), null);
});

test("generator outputs plans array from mocked GraphQL and Binance data", async () => {
  const fetchFn = async (url, options) => ({
    ok: true,
    json: async () => {
      if (options?.method === "POST") return { data: { home_market_list: [{ title: "BNB/USDT Futures Daily Volume, June 1st", status: "live", market_address: "0xabc", outcomes: [
        { token_id: "1", name: "Below 1000", price_hmr: "0.2" },
        { token_id: "2", name: "1000 - 2000", price_hmr: "0.3" },
      ] }] } };
      if (url.includes("ticker/24hr")) return { quoteVolume: "1200" };
      if (url.includes("interval=1d")) return Array.from({ length: 8 }, (_, i) => [0, 0, 0, 0, 0, 0, 0, String(i === 7 ? 600 : 1000)]);
      if (url.includes("interval=1h")) return Array.from({ length: 24 }, () => [0, 0, 0, 0, 0, 0, 0, "10"]);
      throw new Error(url);
    },
  });
  const payload = await generateOpeningSnipePlans({
    env: { AUTO_BUY_PAIRS: "BNB/USDT", EVENT_DAY: "2026-06-01", PLAN_DRY_RUN: "1" },
    fetchFn,
    now: new Date("2026-06-01T12:00:00Z"),
    logFn: () => {},
  });
  assert.equal(payload.plans[0].selected_token_id, "1");
  assert.equal(payload.plans[0].prediction.regime, "NORMAL");
  assert.ok(Number.isFinite(payload.plans[0].prediction.volume_spike_ratio));
  assert.ok(Array.isArray(payload.plans[0].prediction.regime_reasons));
  assert.ok(Array.isArray(payload.plans[0].prediction.all_outcome_intervals));
  assert.ok("raw_predicted_volume" in payload.plans[0].prediction);
  assert.ok("conservative_predicted_volume" in payload.plans[0].prediction);
});

test("runner invokes opening plan generator before buys", async () => {
  const calls = [];
  await runner.runCycle({
    eventDate: new Date("2026-06-01T00:00:00Z"),
    generatePlansFn: async () => { calls.push("generate"); return { plans: [{ pair: "BNB/USDT" }] }; },
    runBuysConcurrentlyFn: async () => { calls.push("buy"); return []; },
    logFn: () => {},
  });
  assert.deepEqual(calls, ["generate", "buy"]);
});

test("runner uses generated plan amounts and max prices for buy orchestration", async () => {
  let received;
  await runner.runCycle({
    eventDate: new Date("2026-06-01T00:00:00Z"),
    generatePlansFn: async () => ({ plans: [{ pair: "BNB/USDT", buy_amount_usdt: "11", max_price: 0.22 }] }),
    runBuysConcurrentlyFn: async (args) => { received = args; return []; },
    logFn: () => {},
  });
  assert.equal(received.amounts["BNB/USDT"], "11");
  assert.equal(received.maxPrices["BNB/USDT"], "0.22");
});

test("runBuy passes per-plan amount and max price to onchain child", async () => {
  let childEnv;
  const spawnFn = (_execPath, _args, options) => {
    childEnv = options.env;
    return { on: (_event, cb) => cb(0, null) };
  };
  const code = await runner.runBuy("BNB/USDT", { market_address: "0xabc", event_day: "2026-06-01" }, {
    amounts: { "BNB/USDT": "11" },
    maxPrices: { "BNB/USDT": "0.22" },
    spawnFn,
    logFn: () => {},
  });
  assert.equal(code, 0);
  assert.equal(childEnv.BUY_AMOUNT_USDT, "11");
  assert.equal(childEnv.MAX_PRICE, "0.22");
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
