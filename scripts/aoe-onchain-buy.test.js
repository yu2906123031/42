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
} = onchain;
const { NonceManager } = runner;
const { initializeSchema, acquireAutoBuyLock } = store;
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
