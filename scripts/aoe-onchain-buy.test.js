import test from "node:test";
import assert from "node:assert/strict";
import { shouldPrefetchApproval, applyGasPriceOverride } from "./aoe-onchain-buy.js";

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
