import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  fallback,
  formatUnits,
  http,
  keccak256,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

function loadDotEnv(path = ".env") {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

const OFFICIAL_BSC_RPC_URLS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc.meowrpc.com",
  "https://bsc-mainnet.public.blastapi.io",
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed-public.bnbchain.org",
  "https://bsc-dataseed.nariox.org",
  "https://bsc-dataseed.defibit.io",
  "https://bsc-dataseed.ninicoin.io",
];

function rpcCandidates() {
  const configured = (process.env.BSC_RPC_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([process.env.BSC_RPC_URL, ...configured, ...OFFICIAL_BSC_RPC_URLS].filter(Boolean))];
}

const config = {
  graphqlUrl: process.env.GRAPHQL_URL || "https://ft.42.space/v1/graphql",
  rpcUrls: rpcCandidates(),
  privateKey: process.env.PRIVATE_KEY,
  marketAddress:
    process.env.MARKET_ADDRESS || "0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd",
  targetOutcome: process.env.TARGET_OUTCOME || "AOE",
  targetTokenId: BigInt(process.env.TARGET_TOKEN_ID || "4"),
  buyAmount: process.env.BUY_AMOUNT_USDT || "10",
  dryRun: process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true",
  dryRunMaxWaitMs: Number(process.env.DRY_RUN_MAX_WAIT_MS || "10000"),
  pollMs: Number(process.env.POLL_MS || "500"),
  preApprovalMs: Number(process.env.PRE_APPROVAL_MS || "10000"),
  maxPrice: Number(process.env.MAX_PRICE || "0.0015"),
  slippageBps: parseSlippageBps(process.env.SLIPPAGE_BPS),
  gasPriceMultiplierBps: BigInt(process.env.GAS_PRICE_MULTIPLIER_BPS || "15000"),
  preSignOpeningTx: shouldPreSignOpeningTx(process.env.PRE_SIGN_OPENING_TX),
  preSignGasLimit: BigInt(process.env.PRE_SIGN_GAS_LIMIT || "650000"),
  rawTxFanoutLimit: Number(process.env.RAW_TX_FANOUT_LIMIT || "0"),
  collateral: "0x55d398326f99059ff775485246999027b3197955",
  router: "0x888888886619275d33c00D3BC62DF94D700DCD42",
  lens: "0x8aF85927Cb4deBE57C47DDE5cdb4665839f55a32",
  integrator: "0xc60E3415648684b1D0D0D97e85CB21E6a2bCb620",
  integratorFeeBps: 40n,
  collateralDecimals: 18,
  otDecimals: 18,
};

const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

const lensAbi = [
  {
    type: "function",
    name: "simulateMint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "isExactIn", type: "bool" },
      { name: "dataSwap", type: "bytes" },
      { name: "dataGuess", type: "bytes" },
      { name: "integratorFeeBps", type: "uint256" },
    ],
    outputs: [
      {
        name: "pre",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "supply", type: "uint256" },
          { name: "totalMarketCap", type: "uint256" },
          { name: "payoutPerOt", type: "uint256" },
          { name: "marketCap", type: "uint256" },
        ],
      },
      {
        name: "post",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "price", type: "uint256" },
          { name: "supply", type: "uint256" },
          { name: "totalMarketCap", type: "uint256" },
          { name: "payoutPerOt", type: "uint256" },
          { name: "marketCap", type: "uint256" },
        ],
      },
      {
        name: "quote",
        type: "tuple",
        components: [
          { name: "collateralFromUser", type: "uint256" },
          { name: "collateralToTreasury", type: "uint256" },
          { name: "collateralToIntegrator", type: "uint256" },
          { name: "otToUser", type: "uint256" },
        ],
      },
    ],
  },
];

const routerAbi = [
  {
    type: "error",
    name: "MarketNotStarted",
    inputs: [],
  },
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "receiver", type: "address" },
      { name: "tokenId", type: "uint256" },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "isMint", type: "bool" },
          { name: "amount", type: "uint256" },
          { name: "isExactIn", type: "bool" },
          { name: "minOutOrMaxIn", type: "uint256" },
        ],
      },
      { name: "dataSwap", type: "bytes" },
      { name: "dataGuess", type: "bytes" },
      { name: "integrator", type: "address" },
      { name: "integratorFeeBps", type: "uint256" },
    ],
    outputs: [],
  },
];

export const MAX_UINT256 = (1n << 256n) - 1n;

export function shouldApproveRouter(allowance, amountWei) {
  return BigInt(allowance) < BigInt(amountWei);
}

export function approvalAmountForRouter() {
  return MAX_UINT256;
}

export function decodeRouterErrorName(data) {
  const decoded = decodeErrorResult({ abi: routerAbi, data });
  return decoded.errorName;
}

export function defaultOpeningSlippageBps() {
  return 800n;
}

export function parseSlippageBps(value) {
  const parsed = BigInt(value || String(defaultOpeningSlippageBps()));
  if (parsed < 0n || parsed > 10_000n) {
    throw new Error(`SLIPPAGE_BPS must be between 0 and 10000, got ${parsed}`);
  }
  return parsed;
}

export function shouldPreSignOpeningTx(value) {
  if (value === undefined || value === null || value === "") return true;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

export function classifyRawTxBroadcastError(error) {
  const text = String(error?.shortMessage || error?.details || error?.message || error || "").toLowerCase();
  if (text.includes("already known") || text.includes("already imported") || text.includes("known transaction")) return "already_known";
  if (text.includes("nonce too low")) return "nonce_too_low";
  if (text.includes("replacement") && text.includes("underpriced")) return "replacement_underpriced";
  if (text.includes("insufficient funds")) return "insufficient_funds";
  if (text.includes("revert")) return "reverted";
  if (text.includes("timeout") || text.includes("timed out") || text.includes("etimedout")) return "timeout";
  return "unknown";
}

function buildRawTxBroadcastDiagnostics(settled, clients) {
  return settled.map((result, index) => {
    if (result.status === "fulfilled") {
      return { rpc: clients[index]?.name ?? `rpc-${index}`, status: "success", hash: result.value };
    }
    return {
      rpc: clients[index]?.name ?? `rpc-${index}`,
      status: "failed",
      category: classifyRawTxBroadcastError(result.reason),
      message: result.reason?.shortMessage || result.reason?.message || String(result.reason),
    };
  });
}

async function broadcastSignedTransactionOnce({ signedTransaction, sendRawTransaction, sendRawTransactionClients }) {
  if (sendRawTransactionClients?.length) {
    const settled = await Promise.allSettled(
      sendRawTransactionClients.map((client) =>
        client.sendRawTransaction({ serializedTransaction: signedTransaction }),
      ),
    );
    const success = settled.find((result) => result.status === "fulfilled");
    if (success) return success.value;
    const diagnostics = buildRawTxBroadcastDiagnostics(settled, sendRawTransactionClients);
    if (diagnostics.some((entry) => entry.category === "already_known")) {
      return keccak256(signedTransaction);
    }
    const error = settled[0]?.reason ?? new Error("all raw transaction broadcasts failed");
    error.broadcastDiagnostics = diagnostics;
    throw error;
  }
  return sendRawTransaction({ serializedTransaction: signedTransaction });
}

export async function sendSignedTransactionWithRetry({
  signedTransaction,
  sendRawTransaction,
  sendRawTransactionClients,
  maxRetries = 1,
  logFn = console.warn,
}) {
  let attempt = 0;
  for (;;) {
    try {
      return await broadcastSignedTransactionOnce({
        signedTransaction,
        sendRawTransaction,
        sendRawTransactionClients,
      });
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      attempt += 1;
      logFn(`sendRawTransaction failed; retrying once attempt=${attempt} error=${error.message}`);
    }
  }
}

export function describeTransactionReceiptStatus(receipt, error, fallbackHash) {
  if (receipt) {
    return {
      confirmation_status: receipt.status === "success" ? "confirmed" : "reverted",
      transaction_hash: receipt.transactionHash,
      block_number: stringifyBigInt(receipt.blockNumber),
    };
  }
  return {
    confirmation_status: classifyRawTxBroadcastError(error) === "timeout" ? "timeout" : "failed",
    transaction_hash: fallbackHash,
    error: error?.shortMessage || error?.message || String(error),
  };
}

export function minOutFromQuote(otToUser, slippageBps) {
  return (BigInt(otToUser) * (10_000n - BigInt(slippageBps))) / 10_000n;
}

function stringifyBigInt(value) {
  if (value === undefined || value === null) return undefined;
  return BigInt(value).toString();
}

function extractErrorData(error) {
  return error?.data?.data || error?.data || error?.cause?.data?.data || error?.cause?.data;
}

export function buildSwapFailureDiagnostics({
  error,
  initialQuote,
  retryQuote,
  minOut,
  retryMinOut,
  gasPrice,
  blockNumber,
  marketStatus,
  deadline,
}) {
  const errorData = extractErrorData(error);
  let routerError;
  if (typeof errorData === "string" && errorData.startsWith("0x")) {
    try {
      routerError = decodeRouterErrorName(errorData);
    } catch {
      routerError = undefined;
    }
  }
  return Object.fromEntries(
    Object.entries({
      router_error: routerError,
      router_error_data: typeof errorData === "string" ? errorData : undefined,
      initial_quote_out: stringifyBigInt(initialQuote?.otToUser),
      retry_quote_out: stringifyBigInt(retryQuote?.otToUser),
      initial_pool_price_pre: stringifyBigInt(initialQuote?.prePrice),
      initial_pool_price_post: stringifyBigInt(initialQuote?.postPrice),
      retry_pool_price_pre: stringifyBigInt(retryQuote?.prePrice),
      retry_pool_price_post: stringifyBigInt(retryQuote?.postPrice),
      min_out: stringifyBigInt(minOut),
      retry_min_out: stringifyBigInt(retryMinOut),
      deadline,
      gas_price: stringifyBigInt(gasPrice),
      block_number: stringifyBigInt(blockNumber),
      market_status: marketStatus,
    }).filter(([, value]) => value !== undefined),
  );
}

export function chooseSwapQuoteAfterSimulationFailure({ originalMinOut, retryQuote, slippageBps }) {
  if (BigInt(retryQuote.otToUser) < BigInt(originalMinOut)) {
    return { shouldRetrySwap: false, reason: "retry_quote_below_original_min_out" };
  }
  return {
    shouldRetrySwap: true,
    quote: retryQuote,
    minOut: minOutFromQuote(retryQuote.otToUser, slippageBps),
  };
}

const MARKET_QUERY = `
query GetMarket($marketAddress: String!) {
  home_market_list(where: { market_address: { _eq: $marketAddress } }, limit: 1) {
    title
    status
    start_timestamp
    start_timestamp_tz
    outcomes
  }
}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeRpc(url) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.result !== "0x38") throw new Error(`unexpected chain ${body.result || "unknown"}`);
  return { url, latencyMs: Math.round(performance.now() - started) };
}

async function rankRpcUrls() {
  const results = await Promise.all(
    config.rpcUrls.map(async (url) => {
      try {
        return await probeRpc(url);
      } catch (error) {
        console.warn(`RPC unavailable: ${url} (${error.message})`);
        return null;
      }
    }),
  );
  const available = results.filter(Boolean).sort((left, right) => left.latencyMs - right.latencyMs);
  if (!available.length) throw new Error("No available BSC RPC endpoint returned chainId 56.");
  console.log("BSC RPC selected:", available[0].url, `${available[0].latencyMs}ms`);
  console.log("BSC RPC fallback order:", available.map((entry) => `${entry.url} (${entry.latencyMs}ms)`).join(", "));
  return available.map((entry) => entry.url);
}

function createRpcTransport(urls) {
  return fallback(
    urls.map((url) => http(url, { retryCount: 0, timeout: 8000 })),
    { retryCount: 1 },
  );
}

function createRawTxBroadcastClients(urls) {
  const selectedUrls = config.rawTxFanoutLimit > 0 ? urls.slice(0, config.rawTxFanoutLimit) : urls;
  return selectedUrls.map((url) => {
    const client = createPublicClient({
      chain: bsc,
      transport: http(url, { retryCount: 0, timeout: 8000 }),
    });
    return {
      name: url,
      sendRawTransaction: client.sendRawTransaction.bind(client),
    };
  });
}

function smartSimEps(amount) {
  if (amount < 5) return 50_000_000_000_000_000n;
  if (amount <= 1000) return 1_000_000_000_000_000n;
  return BigInt(Math.floor((1 / amount) * 1e18));
}

function encodeDataGuess(otDeltaGuessOffchain, maxIterations, eps) {
  return encodeAbiParameters(
    [
      { name: "otDeltaGuessOffchain", type: "uint256" },
      { name: "maxIterations", type: "uint256" },
      { name: "eps", type: "uint256" },
    ],
    [otDeltaGuessOffchain, maxIterations, eps],
  );
}

async function getMarket() {
  const response = await fetch(config.graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: MARKET_QUERY,
      variables: { marketAddress: config.marketAddress },
    }),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const json = await response.json();
  const market = json?.data?.home_market_list?.[0];
  if (!market) throw new Error(`Market not found: ${config.marketAddress}`);
  return market;
}

function findOutcome(market) {
  return market.outcomes?.find((outcome) => {
    if (BigInt(outcome.token_id) !== config.targetTokenId) return false;
    if (config.targetOutcome.toUpperCase() === "AOE") return true;
    const matchesName =
      outcome.name === config.targetOutcome ||
      outcome.symbol === config.targetOutcome;
    return matchesName;
  });
}

async function waitUntilLive({ allowPreApproval = false } = {}) {
  const startedAt = Date.now();
  let loggedDryRunStatus = false;
  for (;;) {
    const market = await getMarket();
    const outcome = findOutcome(market);
    if (!outcome) {
      throw new Error(
        `Target outcome not found or token changed: ${config.targetOutcome} / ${config.targetTokenId}`,
      );
    }

    const price = Number(outcome.price_hmr);
    if (!config.dryRun || !loggedDryRunStatus) {
      console.log(
        `[${new Date().toISOString()}] status=${market.status} price=${price}`,
      );
      loggedDryRunStatus = true;
    }

    if (price > config.maxPrice) {
      throw new Error(`Abort: price ${price} > MAX_PRICE ${config.maxPrice}`);
    }
    if (market.status === "live") return { market, outcome };
    if (allowPreApproval && shouldPrefetchApproval(market)) return { market, outcome, preApprovalWindow: true };
    if (config.dryRun && Date.now() - startedAt >= config.dryRunMaxWaitMs) {
      console.log(`DRY RUN: market is still ${market.status} after ${config.dryRunMaxWaitMs}ms; stopping test.`);
      return { market, outcome, timedOut: true };
    }

    await sleep(config.pollMs);
  }
}

export function shouldPrefetchApproval(market, nowMs = Date.now(), preApprovalMs = config.preApprovalMs) {
  if (!market || market.status === "live") return true;
  const startTimestamp = Number(market.start_timestamp || 0);
  if (!Number.isFinite(startTimestamp) || startTimestamp <= 0) return false;
  const startsAtMs = startTimestamp * 1000;
  return startsAtMs - nowMs <= preApprovalMs;
}

async function approveIfNeeded(publicClient, walletClient, account, amountWei) {
  const allowance = await publicClient.readContract({
    address: config.collateral,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, config.router],
  });

  if (!shouldApproveRouter(allowance, amountWei)) return true;
  if (config.dryRun) {
    console.log("DRY RUN: allowance is below buy amount; would approve USDT to router.");
    return false;
  }
  console.log("Approving unlimited USDT to router...");
  const approveHash = await walletClient.writeContract(
    await applyGasPriceOverride(publicClient, {
      address: config.collateral,
      abi: erc20Abi,
      functionName: "approve",
      args: [config.router, approvalAmountForRouter()],
    }),
  );
  console.log("Approve tx:", approveHash);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  return true;
}

export async function applyGasPriceOverride(publicClient, request, multiplierBps = config.gasPriceMultiplierBps) {
  if (multiplierBps <= 10_000n) return request;
  const gasPrice = await publicClient.getGasPrice();
  const boostedGasPrice = (gasPrice * multiplierBps) / 10_000n;
  console.log(
    "Gas price override:",
    `${formatUnits(gasPrice, 9)} -> ${formatUnits(boostedGasPrice, 9)} gwei`,
  );
  return { ...request, gasPrice: boostedGasPrice };
}

async function recordExecutionIfNeeded(payload) {
  if (config.dryRun) return;
  const { recordExecution } = await import("./aoe-dashboard-store.js");
  recordExecution(payload);
}

export function buildWeixinBuySuccessMessage(payload) {
  const lines = [
    "✅ 42 自动买入成功",
    `交易对：${payload.pair || "BNB/USDT"}`,
    `金额：${payload.amount_usdt ?? "-"} USDT`,
  ];
  if (payload.token_id) lines.push(`Token ID：${payload.token_id}`);
  if (payload.tx_hash) lines.push(`TX：${payload.tx_hash}`);
  if (payload.duration_ms != null) lines.push(`耗时：${payload.duration_ms}ms`);
  return lines.join("\n");
}

async function sendWeixinBuySuccessNotificationIfNeeded(payload) {
  if (config.dryRun) return;
  if (String(process.env.WEIXIN_BUY_NOTIFY || "1").trim().toLowerCase().match(/^(0|false|no|off)$/)) return;
  const hermesDir = process.env.HERMES_AGENT_DIR || "/root/.hermes/hermes-agent";
  const target = process.env.WEIXIN_NOTIFY_TARGET || "weixin";
  const message = buildWeixinBuySuccessMessage(payload);
  const code = String.raw`
import json, os, sys
from pathlib import Path

def load_env(path):
    values = {}
    if not Path(path).exists():
        return values
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values

payload = json.loads(sys.stdin.read())
hermes_dir = Path(payload['hermes_dir'])
if str(hermes_dir) not in sys.path:
    sys.path.insert(0, str(hermes_dir))
root_dir = Path(payload['root_dir'])
for env_file in (Path.home() / '.hermes' / '.env', root_dir / '.env'):
    for key, value in load_env(env_file).items():
        os.environ.setdefault(key, value)
from tools.send_message_tool import send_message_tool
print(send_message_tool({'action': 'send', 'target': payload['target'], 'message': payload['message']}))
`;
  const result = spawnSync("python3", ["-c", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ hermes_dir: hermesDir, root_dir: process.cwd(), target, message }),
    timeout: 30_000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status !== 0 || /"error"\s*:/.test(output)) {
    console.error("Weixin notify failed:", output || result.error?.message || `exit ${result.status}`);
    return;
  }
  console.log("Weixin notify sent.");
}

function getQuote(result) {
  const pre = result?.pre ?? result?.[0];
  const post = result?.post ?? result?.[1];
  const quote = result?.quote ?? result?.[2];
  if (!quote) throw new Error("simulateMint did not return quote");
  return {
    prePrice: pre?.price ?? pre?.[1],
    postPrice: post?.price ?? post?.[1],
    collateralFromUser: quote.collateralFromUser ?? quote[0],
    collateralToTreasury: quote.collateralToTreasury ?? quote[1],
    collateralToIntegrator: quote.collateralToIntegrator ?? quote[2],
    otToUser: quote.otToUser ?? quote[3],
  };
}

async function simulateMintQuote(publicClient, amountWei, simGuess) {
  const { result } = await publicClient.simulateContract({
    address: config.lens,
    abi: lensAbi,
    functionName: "simulateMint",
    args: [
      config.marketAddress,
      config.targetTokenId,
      amountWei,
      true,
      "0x",
      simGuess,
      config.integratorFeeBps,
    ],
  });
  return getQuote(result);
}

async function simulateSwapRequest(publicClient, account, amountWei, minOut, simGuess) {
  const { request } = await publicClient.simulateContract({
    account,
    address: config.router,
    abi: routerAbi,
    functionName: "swap",
    args: swapArgs(account, amountWei, minOut, simGuess),
  });
  return request;
}

function swapArgs(account, amountWei, minOut, simGuess) {
  return [
    config.marketAddress,
    account.address,
    config.targetTokenId,
    {
      isMint: true,
      amount: amountWei,
      isExactIn: true,
      minOutOrMaxIn: minOut,
    },
    "0x",
    simGuess,
    config.integrator,
    config.integratorFeeBps,
  ];
}

async function prepareSignedSwapTransaction({ publicClient, account, amountWei, minOut, simGuess, gasPrice }) {
  const [nonce, blockGasPrice] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    gasPrice == null ? publicClient.getGasPrice() : Promise.resolve(gasPrice),
  ]);
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: "swap",
    args: swapArgs(account, amountWei, minOut, simGuess),
  });
  const signedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to: config.router,
    data,
    value: 0n,
    gas: config.preSignGasLimit,
    gasPrice: blockGasPrice,
    nonce,
  });
  return { signedTransaction, nonce, gasPrice: blockGasPrice, gas: config.preSignGasLimit };
}

async function recordSwapFailure({ error, initialQuote, retryQuote, minOut, retryMinOut, gasPrice, blockNumber, marketStatus, startedAt }) {
  const diagnostics = buildSwapFailureDiagnostics({
    error,
    initialQuote,
    retryQuote,
    minOut,
    retryMinOut,
    gasPrice,
    blockNumber,
    marketStatus,
    deadline: "none",
  });
  console.error("Swap simulation diagnostics:", JSON.stringify(diagnostics));
  await recordExecutionIfNeeded({
    pair: process.env.AOE_PAIR || "BNB/USDT",
    side: "BUY",
    amount_usdt: Number(config.buyAmount || 0),
    status: "failed",
    duration_ms: Date.now() - startedAt,
    source: "aoe-onchain-buy",
    error: JSON.stringify({ message: error.message, diagnostics }),
  });
  return diagnostics;
}

async function ensureRouterAllowance({ publicClient, walletClient, account, amountWei }) {
  const allowance = await publicClient.readContract({
    address: config.collateral,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, config.router],
  });

  if (!shouldApproveRouter(allowance, amountWei)) {
    return;
  }
  if (config.dryRun) {
    console.log("DRY RUN: allowance is below buy amount; would approve unlimited USDT to router.");
    return;
  }
  console.log("Approving unlimited USDT to router...");
  const approveHash = await walletClient.writeContract({
    address: config.collateral,
    abi: erc20Abi,
    functionName: "approve",
    args: [config.router, approvalAmountForRouter(amountWei)],
  });
  console.log("Approve tx:", approveHash);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
}

async function main() {
  const startedAt = Date.now();
  if (!config.privateKey || /^0x0+$/.test(config.privateKey)) {
    throw new Error("Set PRIVATE_KEY in .env or environment first.");
  }

  const account = privateKeyToAccount(config.privateKey);
  const rpcUrls = await rankRpcUrls();
  const publicClient = createPublicClient({
    chain: bsc,
    transport: createRpcTransport(rpcUrls),
  });
  const rawTxBroadcastClients = createRawTxBroadcastClients(rpcUrls);
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: createRpcTransport(rpcUrls),
  });

  console.log("Receiver:", account.address);
  console.log("Watching market:", config.marketAddress);
  console.log("Target:", config.targetOutcome, "token_id", config.targetTokenId);
  if (config.preSignOpeningTx && !config.dryRun) {
    console.log("Raw tx broadcast fanout:", rawTxBroadcastClients.map((client) => client.name).join(", "));
  }
  if (config.dryRun) {
    console.log("DRY RUN: testing only; no approve or buy transaction will be sent.");
  }

  const amountWei = parseUnits(config.buyAmount, config.collateralDecimals);
  const balance = await publicClient.readContract({
    address: config.collateral,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (balance < amountWei) {
    throw new Error(
      `Insufficient USDT: ${formatUnits(balance, config.collateralDecimals)}`,
    );
  }

  let liveState;
  for (;;) {
    liveState = await waitUntilLive({ allowPreApproval: true });
    if (config.dryRun && liveState.timedOut) {
      return;
    }
    if (shouldPrefetchApproval(liveState.market)) {
      const approved = await approveIfNeeded(publicClient, walletClient, account, amountWei);
      if (!approved) return;
      break;
    }
    const startsAtMs = Number(liveState.market.start_timestamp || 0) * 1000;
    const waitMs = Math.max(0, startsAtMs - Date.now() - config.preApprovalMs);
    console.log(`Waiting ${waitMs}ms before pre-approval window.`);
    await sleep(Math.min(waitMs, config.pollMs));
  }

  if (liveState.market.status !== "live") {
    liveState = await waitUntilLive();
    if (config.dryRun && liveState.timedOut) return;
  }

  const simGuess = encodeDataGuess(0n, 100n, smartSimEps(Number(config.buyAmount)));
  const quote = await simulateMintQuote(publicClient, amountWei, simGuess);
  let minOut = minOutFromQuote(quote.otToUser, config.slippageBps);
  console.log("Simulated OT out:", formatUnits(quote.otToUser, config.otDecimals));
  console.log("Min OT out:", formatUnits(minOut, config.otDecimals));

  const [gasPrice, blockNumber] = await Promise.all([
    publicClient.getGasPrice(),
    publicClient.getBlockNumber(),
  ]);

  let request;
  let signedSwap;
  if (config.preSignOpeningTx && !config.dryRun) {
    signedSwap = await prepareSignedSwapTransaction({ publicClient, account, amountWei, minOut, simGuess, gasPrice });
    console.log(`Pre-signed buy tx nonce=${signedSwap.nonce} gas=${signedSwap.gas} gasPrice=${signedSwap.gasPrice}`);
  } else {
    try {
      request = await simulateSwapRequest(publicClient, account, amountWei, minOut, simGuess);
    } catch (error) {
      console.error("Swap simulation failed; re-quoting once before deciding whether to pursue.");
      const retryQuote = await simulateMintQuote(publicClient, amountWei, simGuess);
      const retryDecision = chooseSwapQuoteAfterSimulationFailure({
        originalMinOut: minOut,
        retryQuote,
        slippageBps: config.slippageBps,
      });
      const retryMinOut = retryDecision.minOut ?? minOutFromQuote(retryQuote.otToUser, config.slippageBps);
      console.log("Retry simulated OT out:", formatUnits(retryQuote.otToUser, config.otDecimals));
      console.log("Retry Min OT out:", formatUnits(retryMinOut, config.otDecimals));
      await recordSwapFailure({
        error,
        initialQuote: quote,
        retryQuote,
        minOut,
        retryMinOut,
        gasPrice,
        blockNumber,
        marketStatus: "pre-live-simulation",
        startedAt,
      });
      if (!retryDecision.shouldRetrySwap) {
        throw new Error(`Swap simulation failed and retry quote stopped: ${retryDecision.reason}`);
      }
      minOut = retryDecision.minOut;
      request = await simulateSwapRequest(publicClient, account, amountWei, minOut, simGuess);
    }
  }

  liveState = await waitUntilLive();
  if (config.dryRun && liveState.timedOut) {
    return;
  }

  if (config.dryRun) {
    console.log("DRY RUN: swap simulation succeeded; transaction was not sent.");
    return;
  }

  const hash = signedSwap
    ? await sendSignedTransactionWithRetry({
        signedTransaction: signedSwap.signedTransaction,
        sendRawTransactionClients: rawTxBroadcastClients,
      })
    : await walletClient.writeContract(await applyGasPriceOverride(publicClient, request));
  console.log("Buy tx:", hash);
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    const confirmation = describeTransactionReceiptStatus(null, error, hash);
    console.error("Confirmation diagnostics:", JSON.stringify(confirmation));
    await recordExecutionIfNeeded({
      pair: process.env.AOE_PAIR || "BNB/USDT",
      side: "BUY",
      amount_usdt: Number(config.buyAmount || 0),
      status: "pending",
      tx_hash: hash,
      duration_ms: Date.now() - startedAt,
      source: "aoe-onchain-buy",
      error: JSON.stringify(confirmation),
    });
    throw error;
  }
  const confirmation = describeTransactionReceiptStatus(receipt);
  console.log("Confirmation diagnostics:", JSON.stringify(confirmation));
  console.log("Confirmed:", receipt.transactionHash);

  const gasWei =
    receipt.gasUsed && receipt.effectiveGasPrice
      ? receipt.gasUsed * receipt.effectiveGasPrice
      : 0n;
  const executionPayload = {
    pair: process.env.AOE_PAIR || "BNB/USDT",
    side: "BUY",
    amount_usdt: Number(formatUnits(quote.collateralFromUser, config.collateralDecimals)),
    price: Number(formatUnits(quote.collateralFromUser, config.collateralDecimals)) /
      Math.max(Number(formatUnits(quote.otToUser, config.otDecimals)), 1e-12),
    gas_usdt: Number(formatUnits(gasWei, 18)) * Number(process.env.BNB_USDT_PRICE || "680"),
    status: receipt.status === "success" ? "success" : "failed",
    tx_hash: receipt.transactionHash,
    token_id: config.targetTokenId,
    duration_ms: Date.now() - startedAt,
    source: "aoe-onchain-buy",
  };
  await recordExecutionIfNeeded(executionPayload);
  if (receipt.status === "success") {
    await sendWeixinBuySuccessNotificationIfNeeded(executionPayload);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    console.error(error);
    if (config.dryRun) {
      process.exitCode = 1;
      return;
    }
    try {
      await recordExecutionIfNeeded({
        pair: process.env.AOE_PAIR || "BNB/USDT",
        side: "BUY",
        amount_usdt: Number(config.buyAmount || 0),
        status: "failed",
        duration_ms: 0,
        source: "aoe-onchain-buy",
        error: error.message,
      });
    } catch (recordError) {
      console.error("Failed to record execution:", recordError);
    }
    process.exitCode = 1;
  });
}
