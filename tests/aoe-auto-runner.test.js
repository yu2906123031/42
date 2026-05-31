import test from "node:test";
import assert from "node:assert/strict";

import {
  runBuysConcurrently,
  summarizeBuyResults,
} from "../scripts/aoe-auto-runner.js";

test("runBuysConcurrently starts all discovered market buys before awaiting completion", async () => {
  const starts = [];
  const releases = [];
  const pairs = ["BNB/USDT", "BTC/USDT", "SOL/USDT"];
  const discoveries = new Map(
    pairs.map((pair) => [pair, { market_address: `0x${pair.slice(0, 3)}`, status: "live", title: pair }]),
  );

  const runPromise = runBuysConcurrently({
    pairs,
    eventDate: new Date("2026-06-01T00:00:00Z"),
    discoverMarketFn: async (pair) => discoveries.get(pair),
    runBuyFn: async (pair) => {
      starts.push(pair);
      return new Promise((resolve) => releases.push(() => resolve(pair === "BTC/USDT" ? 1 : 0)));
    },
    logFn: () => {},
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts.sort(), pairs.slice().sort());
  releases.forEach((release) => release());

  const results = await runPromise;
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((result) => result.pair).sort(), pairs.slice().sort());
});

test("runBuysConcurrently isolates one market failure and keeps other buys", async () => {
  const pairs = ["BNB/USDT", "BTC/USDT", "ETH/USDT"];
  const results = await runBuysConcurrently({
    pairs,
    eventDate: new Date("2026-06-01T00:00:00Z"),
    discoverMarketFn: async (pair) => ({ market_address: `0x${pair.slice(0, 3)}`, status: "live", title: pair }),
    runBuyFn: async (pair) => {
      if (pair === "BNB/USDT") throw new Error("router MarketNotStarted");
      return 0;
    },
    logFn: () => {},
  });

  assert.deepEqual(
    results.map((result) => [result.pair, result.status]),
    [
      ["BNB/USDT", "failed"],
      ["BTC/USDT", "success"],
      ["ETH/USDT", "success"],
    ],
  );
  assert.equal(results[0].error, "router MarketNotStarted");
});

test("summarizeBuyResults reports success, failure and skipped counts", () => {
  assert.deepEqual(
    summarizeBuyResults([
      { status: "success" },
      { status: "failed" },
      { status: "skipped" },
      { status: "success" },
    ]),
    { total: 4, success: 2, failed: 1, skipped: 1 },
  );
});
