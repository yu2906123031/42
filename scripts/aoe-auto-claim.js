import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatUnits,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { recordExecution } from "./aoe-dashboard-store.js";

function loadDotEnv(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
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
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed-public.bnbchain.org",
  "https://bsc-dataseed.nariox.org",
  "https://bsc-dataseed.defibit.io",
  "https://bsc-dataseed.ninicoin.io",
];

const config = {
  graphqlUrl: process.env.GRAPHQL_URL || "https://ft.42.space/v1/graphql",
  rpcUrls: [...new Set([
    process.env.BSC_RPC_URL,
    ...(process.env.BSC_RPC_URLS || "").split(",").map((value) => value.trim()),
    ...OFFICIAL_BSC_RPC_URLS,
  ].filter(Boolean))],
  privateKey: process.env.PRIVATE_KEY,
  dryRun: ["1", "true", "yes", "on"].includes(String(process.env.AUTO_CLAIM_DRY_RUN || process.env.AUTO_BUY_DRY_RUN || process.env.DRY_RUN || "0").toLowerCase()),
  enabled: !["0", "false", "no", "off"].includes(String(process.env.AUTO_CLAIM_ENABLED || "1").toLowerCase()),
  lookbackDays: Number(process.env.AUTO_CLAIM_LOOKBACK_DAYS || "21"),
  buyId: process.env.AUTO_CLAIM_BUY_ID ? Number(process.env.AUTO_CLAIM_BUY_ID) : null,
  targetTokenId: BigInt(process.env.TARGET_TOKEN_ID || "4"),
};

const MARKET_QUERY = `
query DiscoverMarket($pattern: String!) {
  home_market_list(where: { title: { _ilike: $pattern } }, limit: 20) {
    title
    status
    market_address
    outcomes
  }
}`;

const marketAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "receiver", type: "address" }, { name: "tokenIds", type: "uint256[]" }, { name: "otToBurn", type: "uint256[]" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "readState", stateMutability: "view", inputs: [], outputs: [{ type: "tuple", components: [
    { name: "market", type: "address" },
    { name: "curve", type: "address" },
    { name: "timestampStart", type: "uint128" },
    { name: "totalMarketCap", type: "uint256" },
    { name: "treasury", type: "address" },
    { name: "numOutcomes", type: "uint256" },
    { name: "timestampEnd", type: "uint128" },
    { name: "answer", type: "uint256" },
    { name: "isFinalised", type: "bool" },
  ] }] },
];

export function claimableBuysQuery() {
  return `
    SELECT id, ts, pair, amount_usdt, tx_hash
    FROM executions b
    WHERE side = 'BUY'
      AND status IN ('success', 'confirmed')
      AND ts >= ?
      AND NOT EXISTS (
        SELECT 1 FROM executions c
        WHERE c.side = 'CLAIM'
          AND c.status IN ('success', 'confirmed')
          AND c.source = 'aoe-auto-claim'
          AND c.error = 'buy_id=' || b.id
      )
    ORDER BY ts ASC
  `;
}

export function isMarketFinalised(market) {
  return ["finalised", "finalized", "resolved", "closed"].includes(String(market?.status || "").toLowerCase());
}

export function isWinningOutcome(market, tokenId) {
  const target = BigInt(tokenId).toString();
  const outcome = market?.outcomes?.find((item) => BigInt(item.token_id).toString() === target);
  return Number(outcome?.payout_hmr || 0) > 0;
}

export function shouldClaimBuy(buy, market) {
  return isMarketFinalised(market) && isWinningOutcome(market, buy.target_token_id ?? config.targetTokenId);
}

function ordinal(day) {
  if (day > 3 && day < 21) return `${day}th`;
  const last = day % 10;
  if (last === 1) return `${day}st`;
  if (last === 2) return `${day}nd`;
  if (last === 3) return `${day}rd`;
  return `${day}th`;
}

function monthName(date) {
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date);
}

async function queryMarkets(pair, eventDate) {
  const pattern = `%${pair} Futures Daily Volume, ${monthName(eventDate)} ${ordinal(eventDate.getUTCDate())}%`;
  const response = await fetch(config.graphqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: MARKET_QUERY, variables: { pattern } }),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors.map((error) => error.message).join("; "));
  return json?.data?.home_market_list || [];
}

async function discoverMarket(pair, eventDate) {
  const markets = await queryMarkets(pair, eventDate);
  return markets
    .filter((market) => market.market_address)
    .sort((left, right) => Number(isMarketFinalised(right)) - Number(isMarketFinalised(left)))[0] || null;
}

async function probeRpc(url) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(4000),
  });
  const body = await response.json();
  if (!response.ok || body.result !== "0x38") throw new Error("not BSC mainnet");
  return url;
}

async function clients(account) {
  const checked = (await Promise.all(config.rpcUrls.map(async (url) => {
    try { return await probeRpc(url); } catch { return null; }
  }))).filter(Boolean);
  if (!checked.length) throw new Error("No available BSC RPC");
  const transport = fallback(checked.map((url) => http(url, { timeout: 8000, retryCount: 0 })), { retryCount: 1 });
  return {
    publicClient: createPublicClient({ chain: bsc, transport }),
    walletClient: createWalletClient({ account, chain: bsc, transport }),
  };
}

function claimableBuys() {
  const database = new DatabaseSync("runtime-state/trades.db", { readOnly: true });
  const since = new Date(Date.now() - config.lookbackDays * 86400000).toISOString();
  try {
    return database.prepare(claimableBuysQuery()).all(since).map((buy) => ({
      ...buy,
      target_token_id: config.targetTokenId,
    }));
  } finally {
    database.close();
  }
}

async function claimOne({ buy, market, account, publicClient, walletClient }) {
  const balance = await publicClient.readContract({
    address: market.market_address,
    abi: marketAbi,
    functionName: "balanceOf",
    args: [account.address, config.targetTokenId],
  });
  if (balance <= 0n) {
    console.log(`[${new Date().toISOString()}] claim skip pair=${buy.pair} buy_id=${buy.id} reason=no_ot_balance`);
    return;
  }
  const state = await publicClient.readContract({
    address: market.market_address,
    abi: marketAbi,
    functionName: "readState",
  });
  if (!state.isFinalised) {
    console.log(`[${new Date().toISOString()}] claim skip pair=${buy.pair} buy_id=${buy.id} market=${market.market_address} reason=market_not_finalised_onchain answer=${state.answer.toString()}`);
    return;
  }
  if (BigInt(state.answer) !== config.targetTokenId) {
    console.log(`[${new Date().toISOString()}] claim skip pair=${buy.pair} buy_id=${buy.id} market=${market.market_address} reason=target_not_winning answer=${state.answer.toString()} target=${config.targetTokenId.toString()}`);
    return;
  }
  const outcome = market.outcomes.find((item) => BigInt(item.token_id) === config.targetTokenId);
  const estimatedPayout = Number(formatUnits(balance, 18)) * Number(outcome?.payout_hmr || 0);
  console.log(`[${new Date().toISOString()}] claim ready pair=${buy.pair} buy_id=${buy.id} market=${market.market_address} ot=${formatUnits(balance, 18)} est_usdt=${estimatedPayout.toFixed(6)} dryRun=${config.dryRun}`);
  if (config.dryRun) return;

  const startedAt = Date.now();
  const { request } = await publicClient.simulateContract({
    account,
    address: market.market_address,
    abi: marketAbi,
    functionName: "claim",
    args: [account.address, [config.targetTokenId], [balance]],
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  recordExecution({
    pair: buy.pair,
    side: "CLAIM",
    amount_usdt: estimatedPayout,
    status: receipt.status === "success" ? "success" : "failed",
    tx_hash: receipt.transactionHash,
    duration_ms: Date.now() - startedAt,
    source: "aoe-auto-claim",
    error: `buy_id=${buy.id}`,
  });
  console.log(`[${new Date().toISOString()}] claim finished pair=${buy.pair} buy_id=${buy.id} tx=${receipt.transactionHash} status=${receipt.status}`);
}

export async function runAutoClaim() {
  console.log(`[${new Date().toISOString()}] auto-claim start enabled=${config.enabled} dryRun=${config.dryRun}`);
  if (!config.enabled) return;
  if (!config.privateKey || /^0x0+$/.test(config.privateKey)) throw new Error("Set PRIVATE_KEY in .env or environment first.");
  const account = privateKeyToAccount(config.privateKey);
  const { publicClient, walletClient } = await clients(account);
  const buys = claimableBuys().filter((buy) => config.buyId == null || Number(buy.id) === config.buyId);
  console.log(`[${new Date().toISOString()}] auto-claim candidates=${buys.length}${config.buyId == null ? "" : ` buy_id=${config.buyId}`}`);
  for (const buy of buys) {
    const eventDate = new Date(buy.ts);
    const market = await discoverMarket(buy.pair, eventDate);
    if (!market) {
      console.log(`[${new Date().toISOString()}] claim skip pair=${buy.pair} buy_id=${buy.id} reason=market_not_found`);
      continue;
    }
    if (!shouldClaimBuy(buy, market)) {
      console.log(`[${new Date().toISOString()}] claim skip pair=${buy.pair} buy_id=${buy.id} status=${market.status} reason=not_finalised_or_not_winner`);
      continue;
    }
    await claimOne({ buy, market, account, publicClient, walletClient });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutoClaim().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
