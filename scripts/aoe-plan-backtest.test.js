import assert from "node:assert/strict";
import test from "node:test";
import { summarizeBacktest } from "./aoe-plan-backtest.js";

test("backtest summary includes regime and pair-regime dimensions", () => {
  const summary = summarizeBacktest([
    { pair: "BNB/USDT", answer_index: 5, prediction: { regime: "SPIKE", selected_index: 5, conservative_predicted_volume: 1_000 }, actual_volume: 900 },
    { pair: "BTC/USDT", answer_index: 2, prediction: { regime: "NORMAL", selected_index: 3, conservative_predicted_volume: 800 }, actual_volume: 1_000 },
  ]);

  assert.equal(summary.rows, 2);
  assert.equal(summary.hit_rate_by_regime.SPIKE, 1);
  assert.equal(summary.hit_rate_by_regime.NORMAL, 0);
  assert.equal(summary.selected_minus_answer_avg_by_regime.NORMAL, 1);
  assert.ok(summary.overestimate_by_regime.SPIKE > 0);
  assert.ok(summary.by_pair_regime["BNB/USDT:SPIKE"]);
});
