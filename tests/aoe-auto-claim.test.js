import test from "node:test";
import assert from "node:assert/strict";

import {
  claimableBuysQuery,
  isMarketFinalised,
  isWinningOutcome,
  shouldClaimBuy,
} from "../scripts/aoe-auto-claim.js";

test("claimableBuysQuery skips already claimed buys", () => {
  const query = claimableBuysQuery();
  assert.match(query, /side = 'BUY'/);
  assert.match(query, /status IN \('success', 'confirmed'\)/);
  assert.match(query, /NOT EXISTS/);
  assert.match(query, /side = 'CLAIM'/);
});

test("shouldClaimBuy requires finalised market and winning target outcome", () => {
  const buy = { id: 271, pair: "BNB/USDT", target_token_id: 4 };
  const market = {
    status: "finalised",
    outcomes: [
      { token_id: 4, payout_hmr: 1.25 },
      { token_id: 8, payout_hmr: 0 },
    ],
  };
  assert.equal(isMarketFinalised(market), true);
  assert.equal(isWinningOutcome(market, 4), true);
  assert.equal(shouldClaimBuy(buy, market), true);
});

test("shouldClaimBuy skips live markets and losing outcomes", () => {
  assert.equal(shouldClaimBuy({ target_token_id: 4 }, { status: "live", outcomes: [{ token_id: 4, payout_hmr: 1 }] }), false);
  assert.equal(shouldClaimBuy({ target_token_id: 4 }, { status: "finalized", outcomes: [{ token_id: 4, payout_hmr: 0 }] }), false);
});
