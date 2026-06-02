import test from "node:test";
import assert from "node:assert/strict";

import { outcomeProbability, pairFromTitle, topOutcome } from "./aoe-tail-market-scan.js";

test("tail scan extracts supported futures pair from daily volume title", () => {
  assert.equal(pairFromTitle("BNB/USDT Futures Daily Volume, June 2nd?"), "BNB/USDT");
  assert.equal(pairFromTitle("DOGE/USDT Futures Daily Volume, June 2nd?"), null);
});

test("tail scan ranks top outcome by market-cap probability", () => {
  const market = {
    outcomes: JSON.stringify([
      { token_id: "1", outcome_name: "$0 – $100M", market_cap_hmr: "10", price_hmr: "0.10" },
      { token_id: "2", outcome_name: "$100M – $200M", market_cap_hmr: "30", price_hmr: "0.30" },
    ]),
  };

  const top = topOutcome(market);

  assert.equal(outcomeProbability({ market_cap_hmr: "30" }, 40), 0.75);
  assert.equal(top.tokenId, "2");
  assert.equal(top.probability, 0.75);
});
