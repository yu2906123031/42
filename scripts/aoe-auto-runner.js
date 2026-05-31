import { spawn } from "node:child_process";
import fs from "node:fs";
import { createPublicClient, http, fallback } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { runAutoClaim } from "./aoe-auto-claim.js";
import { acquireAutoBuyLock, updateAutoBuyLock } from "./aoe-dashboard-store.js";

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

const GRAPHQL_URL = process.env.GRAPHQL_URL || "https://ft.42.space/v1/graphql";
const PAIRS = (process.env.AUTO_BUY_PAIRS || "BNB/USDT,BTC/USDT,SOL/USDT,ETH/USDT")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const AMOUNTS = {
  "BNB/USDT": process.env.PRIMARY_BUY_USDT || process.env.AUTO_BUY_AMOUNT_USDT || "5",
  "BTC/USDT": process.env.BTC_BUY_USDT || "2",
  "SOL/USDT": process.env.SOL_BUY_USDT || "2",
  "ETH/USDT": process.env.ETH_BUY_USDT || "2",
};
const ENABLED = ["1", "true", "yes", "on"].includes(String(process.env.AUTO_BUY_ENABLED || "0").toLowerCase());
const DRY_RUN = ["1", "true", "yes", "on"].includes(String(process.env.AUTO_BUY_DRY_RUN || process.env.DRY_RUN || "0").toLowerCase());
const SCAN_INTERVAL_MS = Math.max(5_000, Number(process.env.AUTO_BUY_SCAN_INTERVAL_MS || "60000"));
const LOOP_ONCE = ["1", "true", "yes", "on"].includes(String(process.env.AUTO_BUY_ONCE || "0").toLowerCase());
const FORCE_BUY = ["1", "true", "yes", "on"].includes(String(process.env.AUTO_BUY_FORCE || "0").toLowerCase());

export class NonceManager {
  constructor(startNonce) { this.nextNonce = Number(startNonce); }
  allocate() { const nonce = this.nextNonce; this.nextNonce += 1; return nonce; }
  allocateForPairs(pairs) { return new Map(pairs.map((pair) => [pair, this.allocate()])); }
}

async function createNonceManager() {
  if (DRY_RUN) return null;
  if (process.env.BASE_BUY_NONCE) return new NonceManager(Number(process.env.BASE_BUY_NONCE));
  if (!process.env.PRIVATE_KEY) return null;
  const urls = (process.env.BSC_RPC_URLS || process.env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com").split(",").map((v) => v.trim()).filter(Boolean);
  const publicClient = createPublicClient({ chain: bsc, transport: fallback(urls.map((url) => http(url, { retryCount: 0, timeout: 8000 }))) });
  const account = privateKeyToAccount(process.env.PRIVATE_KEY);
  const pending = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  console.log(`[${new Date().toISOString()}] NonceManager base pending nonce=${pending}`);
  return new NonceManager(pending);
}
const MARKET_QUERY = `
query DiscoverMarket($pattern: String!) {
  home_market_list(where: { title: { _ilike: $pattern } }, limit: 20) {
    title
    status
    market_address
    outcomes
  }
}`;

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

function beijingNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

function nextScanDelayMs(now = new Date()) {
  const bj = beijingNow();
  const scan = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 7 - 8, 59, 30));
  if (now <= scan) return scan.getTime() - now.getTime();
  return scan.getTime() + 86_400_000 - now.getTime();
}

function eventDateForScan(now = new Date()) {
  return new Date(now.getTime() + 30_000);
}

async function queryMarkets(pair, eventDate) {
  const pattern = `%${pair} Futures Daily Volume, ${monthName(eventDate)} ${ordinal(eventDate.getUTCDate())}%`;
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: MARKET_QUERY, variables: { pattern } }),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors.map((error) => error.message).join("; "));
  return json?.data?.home_market_list || [];
}

function marketScore(market, pair) {
  let score = 0;
  if (market.title?.includes(pair)) score += 10;
  if (market.status === "live") score += 5;
  if (market.status === "not_started") score += 3;
  return score;
}

async function discoverMarket(pair, eventDate) {
  const markets = await queryMarkets(pair, eventDate);
  const ranked = markets
    .filter((market) => market.market_address)
    .sort((left, right) => marketScore(right, pair) - marketScore(left, pair));
  return ranked[0] || null;
}

export function summarizeBuyResults(results) {
  return {
    total: results.length,
    success: results.filter((result) => result.status === "success").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
}

function buyStatusFromCode(code) {
  return code === 0 ? "success" : "failed";
}

function log(message, logFn = console.log) {
  logFn(`[${new Date().toISOString()}] ${message}`);
}

function runBuy(pair, market, { nonce } = {}) {
  const env = {
    ...process.env,
    AOE_PAIR: pair,
    MARKET_ADDRESS: market.market_address,
    EVENT_DAY: market.event_day,
    BUY_AMOUNT_USDT: AMOUNTS[pair] || AMOUNTS["BNB/USDT"] || "5",
    DRY_RUN: DRY_RUN ? "true" : "false",
    MAX_PRICE: process.env.AUTO_MAX_OUTCOME_PRICE || process.env.AUTO_BUY_MAX_PRICE || process.env.MAX_PRICE || "0.45",
    OPENING_EXECUTION_MODE: process.env.OPENING_EXECUTION_MODE || "HYBRID",
    ...(nonce == null ? {} : { BUY_NONCE: String(nonce) }),
  };
  console.log(`[${new Date().toISOString()}] buy start pair=${pair} market=${market.market_address} nonce=${env.BUY_NONCE ?? "auto"} amount=${env.BUY_AMOUNT_USDT} dryRun=${env.DRY_RUN}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/aoe-onchain-buy.js"], { env, stdio: "inherit" });
    child.on("exit", (code, signal) => {
      console.log(`[${new Date().toISOString()}] buy finished pair=${pair} code=${code} signal=${signal || ""}`);
      resolve(code || 0);
    });
  });
}

export async function runBuysConcurrently({
  pairs = PAIRS,
  eventDate = eventDateForScan(),
  discoverMarketFn = discoverMarket,
  runBuyFn = runBuy,
  logFn = console.log,
} = {}) {
  const nonceManager = await createNonceManager();
  const jobs = pairs.map(async (pair) => {
    let lock = null;
    try {
      const market = await discoverMarketFn(pair, eventDate);
      if (!market) {
        log(`market not found pair=${pair}`, logFn);
        return { pair, status: "skipped", reason: "market_not_found" };
      }
      log(`discovered pair=${pair} status=${market.status} market=${market.market_address} title=${market.title}`, logFn);
      lock = acquireAutoBuyLock({ pair, event_day: market.event_day || eventDate.toISOString().slice(0, 10), market_address: market.market_address, force: FORCE_BUY });
      if (!lock.acquired) {
        log(`buy skipped pair=${pair} reason=${lock.reason} market=${market.market_address}`, logFn);
        return { pair, status: "skipped", reason: lock.reason, market: market.market_address };
      }
      const nonce = nonceManager?.allocate();
      updateAutoBuyLock(lock.lockId, { status: "running", nonce });
      const code = await runBuyFn(pair, market, { nonce });
      const status = buyStatusFromCode(code);
      updateAutoBuyLock(lock.lockId, { status, nonce });
      return { pair, status, code, market: market.market_address, nonce };
    } catch (error) {
      if (lock?.lockId) updateAutoBuyLock(lock.lockId, { status: "failed", error: error.message });
      log(`buy failed pair=${pair} error=${error.message}`, logFn);
      return { pair, status: "failed", error: error.message };
    }
  });
  return Promise.all(jobs);
}

async function runCycle() {
  const eventDate = eventDateForScan();
  console.log(`[${new Date().toISOString()}] discovering markets for UTC ${eventDate.toISOString().slice(0, 10)}`);
  const results = await runBuysConcurrently({ eventDate });
  const summary = summarizeBuyResults(results);
  console.log(`[${new Date().toISOString()}] buy cycle summary total=${summary.total} success=${summary.success} failed=${summary.failed} skipped=${summary.skipped}`);
}

async function main() {
  console.log(`[${new Date().toISOString()}] 42 headless auto runner ready enabled=${ENABLED} dryRun=${DRY_RUN} pairs=${PAIRS.join(",")}`);
  if (!ENABLED) {
    console.log("AUTO_BUY_ENABLED is off by default. Set AUTO_BUY_ENABLED=1 to run server-side automatic buying.");
    return;
  }
  do {
    const delay = LOOP_ONCE ? 0 : nextScanDelayMs();
    if (delay > 0) {
      console.log(`[${new Date().toISOString()}] next scan in ${Math.round(delay / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, SCAN_INTERVAL_MS)));
      if (delay > SCAN_INTERVAL_MS) continue;
    }
    await runAutoClaim();
    await runCycle();
  } while (!LOOP_ONCE);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
