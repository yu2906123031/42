import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_UINT256,
  approvalAmountForRouter,
  buildSwapFailureDiagnostics,
  chooseSwapQuoteAfterSimulationFailure,
  decodeRouterErrorName,
  defaultOpeningSlippageBps,
  classifyRawTxBroadcastError,
  describeTransactionReceiptStatus,
  minOutFromQuote,
  parseSlippageBps,
  sendSignedTransactionWithRetry,
  shouldApproveRouter,
  shouldPreSignOpeningTx,
} from "../scripts/aoe-onchain-buy.js";

test("router approval uses unlimited uint256 approval", () => {
  assert.equal(approvalAmountForRouter(2n), MAX_UINT256);
});

test("router approval is skipped once existing allowance covers buy amount", () => {
  assert.equal(shouldApproveRouter(10n, 10n), false);
  assert.equal(shouldApproveRouter(MAX_UINT256, 10n), false);
  assert.equal(shouldApproveRouter(9n, 10n), true);
});

test("router error selector 0x774620b8 decodes to MarketNotStarted", () => {
  assert.equal(decodeRouterErrorName("0x774620b8"), "MarketNotStarted");
});

test("opening buy default slippage is 8 percent", () => {
  assert.equal(defaultOpeningSlippageBps(), 800n);
  assert.equal(parseSlippageBps(undefined), 800n);
  assert.equal(minOutFromQuote(1000n, defaultOpeningSlippageBps()), 920n);
  assert.throws(() => parseSlippageBps("10001"), /SLIPPAGE_BPS/);
});

test("swap failure diagnostics include quote, minOut, market, gas, block and decoded router error", () => {
  const diagnostics = buildSwapFailureDiagnostics({
    error: { data: "0x774620b8" },
    initialQuote: { prePrice: 1n, postPrice: 2n, otToUser: 1000n },
    retryQuote: { prePrice: 3n, postPrice: 4n, otToUser: 900n },
    minOut: 920n,
    retryMinOut: 828n,
    gasPrice: 12n,
    blockNumber: 123n,
    marketStatus: "live",
    deadline: "none",
  });

  assert.deepEqual(diagnostics, {
    router_error: "MarketNotStarted",
    router_error_data: "0x774620b8",
    initial_quote_out: "1000",
    retry_quote_out: "900",
    initial_pool_price_pre: "1",
    initial_pool_price_post: "2",
    retry_pool_price_pre: "3",
    retry_pool_price_post: "4",
    min_out: "920",
    retry_min_out: "828",
    deadline: "none",
    gas_price: "12",
    block_number: "123",
    market_status: "live",
  });
});

test("simulate failure re-quotes and pursues when retry quote still meets the original minOut", () => {
  const decision = chooseSwapQuoteAfterSimulationFailure({
    originalMinOut: 920n,
    retryQuote: { otToUser: 950n },
    slippageBps: 800n,
  });

  assert.equal(decision.shouldRetrySwap, true);
  assert.equal(decision.minOut, 874n);
});

test("simulate failure re-quotes and stops when retry quote is below the original minOut", () => {
  const decision = chooseSwapQuoteAfterSimulationFailure({
    originalMinOut: 920n,
    retryQuote: { otToUser: 900n },
    slippageBps: 800n,
  });

  assert.equal(decision.shouldRetrySwap, false);
  assert.equal(decision.reason, "retry_quote_below_original_min_out");
});

test("opening buy pre-signing is enabled by default and can be disabled", () => {
  assert.equal(shouldPreSignOpeningTx(undefined), true);
  assert.equal(shouldPreSignOpeningTx("1"), true);
  assert.equal(shouldPreSignOpeningTx("true"), true);
  assert.equal(shouldPreSignOpeningTx("0"), false);
  assert.equal(shouldPreSignOpeningTx("false"), false);
});

test("signed raw transaction broadcast retries once after a failed send", async () => {
  const attempts = [];
  const hash = await sendSignedTransactionWithRetry({
    signedTransaction: "0xsigned",
    sendRawTransaction: async ({ serializedTransaction }) => {
      attempts.push(serializedTransaction);
      if (attempts.length === 1) throw new Error("temporary rpc failure");
      return "0xhash";
    },
    logFn: () => {},
  });

  assert.equal(hash, "0xhash");
  assert.deepEqual(attempts, ["0xsigned", "0xsigned"]);
});

test("signed raw transaction broadcast stops after one retry", async () => {
  let attempts = 0;
  await assert.rejects(
    sendSignedTransactionWithRetry({
      signedTransaction: "0xsigned",
      sendRawTransaction: async () => {
        attempts += 1;
        throw new Error(`failed ${attempts}`);
      },
      logFn: () => {},
    }),
    /failed 2/,
  );
  assert.equal(attempts, 2);
});

test("raw transaction broadcast errors are classified for operator diagnostics", () => {
  assert.equal(classifyRawTxBroadcastError(new Error("already known")), "already_known");
  assert.equal(classifyRawTxBroadcastError(new Error("nonce too low")), "nonce_too_low");
  assert.equal(classifyRawTxBroadcastError(new Error("replacement transaction underpriced")), "replacement_underpriced");
  assert.equal(classifyRawTxBroadcastError(new Error("insufficient funds for gas")), "insufficient_funds");
  assert.equal(classifyRawTxBroadcastError(new Error("execution reverted")), "reverted");
  assert.equal(classifyRawTxBroadcastError(new Error("request timeout")), "timeout");
  assert.equal(classifyRawTxBroadcastError(new Error("weird rpc error")), "unknown");
});

test("transaction receipt status is described for confirmation diagnostics", () => {
  assert.deepEqual(describeTransactionReceiptStatus({ transactionHash: "0xhash", status: "success", blockNumber: 10n }), {
    confirmation_status: "confirmed",
    transaction_hash: "0xhash",
    block_number: "10",
  });
  assert.deepEqual(describeTransactionReceiptStatus({ transactionHash: "0xhash", status: "reverted", blockNumber: 11n }), {
    confirmation_status: "reverted",
    transaction_hash: "0xhash",
    block_number: "11",
  });
  assert.deepEqual(describeTransactionReceiptStatus(null, new Error("wait timeout"), "0xhash"), {
    confirmation_status: "timeout",
    transaction_hash: "0xhash",
    error: "wait timeout",
  });
});

test("signed raw transaction fanout treats already-known as propagated and returns tx hash", async () => {
  const signedTransaction = "0x02f86c82003880843b9aca00843b9aca008252089400000000000000000000000000000000000000008080c080a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const hash = await sendSignedTransactionWithRetry({
    signedTransaction,
    sendRawTransactionClients: [
      { name: "rpc-a", sendRawTransaction: async () => { throw new Error("already known"); } },
      { name: "rpc-b", sendRawTransaction: async () => { throw new Error("nonce too low"); } },
    ],
    logFn: () => {},
  });

  assert.match(hash, /^0x[0-9a-f]{64}$/);
});

test("signed raw transaction fanout broadcasts to all clients and returns the first success", async () => {
  const attempts = [];
  const hash = await sendSignedTransactionWithRetry({
    signedTransaction: "0xsigned",
    sendRawTransactionClients: [
      { name: "rpc-a", sendRawTransaction: async ({ serializedTransaction }) => {
        attempts.push(["rpc-a", serializedTransaction]);
        throw new Error("rpc-a down");
      } },
      { name: "rpc-b", sendRawTransaction: async ({ serializedTransaction }) => {
        attempts.push(["rpc-b", serializedTransaction]);
        return "0xhashb";
      } },
      { name: "rpc-c", sendRawTransaction: async ({ serializedTransaction }) => {
        attempts.push(["rpc-c", serializedTransaction]);
        return "0xhashc";
      } },
    ],
    logFn: () => {},
  });

  assert.equal(hash, "0xhashb");
  assert.deepEqual(attempts, [
    ["rpc-a", "0xsigned"],
    ["rpc-b", "0xsigned"],
    ["rpc-c", "0xsigned"],
  ]);
});

test("signed raw transaction fanout retries the full client set once when all clients fail", async () => {
  const attempts = [];
  const hash = await sendSignedTransactionWithRetry({
    signedTransaction: "0xsigned",
    sendRawTransactionClients: [
      { name: "rpc-a", sendRawTransaction: async () => {
        attempts.push("rpc-a");
        throw new Error("rpc-a down");
      } },
      { name: "rpc-b", sendRawTransaction: async () => {
        attempts.push("rpc-b");
        if (attempts.length < 4) throw new Error("rpc-b slow");
        return "0xhashb";
      } },
    ],
    logFn: () => {},
  });

  assert.equal(hash, "0xhashb");
  assert.deepEqual(attempts, ["rpc-a", "rpc-b", "rpc-a", "rpc-b"]);
});
