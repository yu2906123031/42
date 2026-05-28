import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  fallback,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { recordExecution } from "./aoe-dashboard-store.js";

function loadDotEnv(path = ".env") {
  if (!fs.existsSync(path)) return;
  for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
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
  market: process.env.MARKET_ADDRESS || "0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd",
  tokenId: BigInt(process.env.TARGET_TOKEN_ID || "4"),
  amount: process.env.ROUNDTRIP_AMOUNT_USDT || "1",
  delayMs: Number(process.env.ROUNDTRIP_DELAY_MS || "60000"),
  preflightOnly: process.env.ROUNDTRIP_PREFLIGHT_ONLY === "YES",
  slippageBps: BigInt(process.env.SLIPPAGE_BPS || "200"),
  minRecoveryBps: BigInt(process.env.MIN_ROUNDTRIP_RECOVERY_BPS || "9500"),
  collateral: "0x55d398326f99059ff775485246999027b3197955",
  router: "0x888888886619275d33c00D3BC62DF94D700DCD42",
  lens: "0x8aF85927Cb4deBE57C47DDE5cdb4665839f55a32",
  integrator: "0xc60E3415648684b1D0D0D97e85CB21E6a2bCb620",
  integratorFeeBps: 40n,
};

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];
const marketAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "id", type: "uint256" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];
const snapshot = [
  { name: "tokenId", type: "uint256" },
  { name: "price", type: "uint256" },
  { name: "supply", type: "uint256" },
  { name: "totalMarketCap", type: "uint256" },
  { name: "payoutPerOt", type: "uint256" },
  { name: "marketCap", type: "uint256" },
];
const lensAbi = [
  {
    type: "function", name: "simulateMint", stateMutability: "nonpayable",
    inputs: [{ name: "market", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "isExactIn", type: "bool" }, { name: "dataSwap", type: "bytes" }, { name: "dataGuess", type: "bytes" }, { name: "integratorFeeBps", type: "uint256" }],
    outputs: [{ name: "pre", type: "tuple", components: snapshot }, { name: "post", type: "tuple", components: snapshot }, { name: "quote", type: "tuple", components: [{ name: "collateralFromUser", type: "uint256" }, { name: "collateralToTreasury", type: "uint256" }, { name: "collateralToIntegrator", type: "uint256" }, { name: "otToUser", type: "uint256" }] }],
  },
  {
    type: "function", name: "simulateRedeem", stateMutability: "nonpayable",
    inputs: [{ name: "market", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "isExactIn", type: "bool" }, { name: "dataSwap", type: "bytes" }, { name: "dataGuess", type: "bytes" }, { name: "integratorFeeBps", type: "uint256" }],
    outputs: [{ name: "pre", type: "tuple", components: snapshot }, { name: "post", type: "tuple", components: snapshot }, { name: "quote", type: "tuple", components: [{ name: "collateralToUser", type: "uint256" }, { name: "collateralToTreasury", type: "uint256" }, { name: "collateralToIntegrator", type: "uint256" }, { name: "otFromUser", type: "uint256" }, { name: "collateralMintValue", type: "uint256" }] }],
  },
];
const routerAbi = [{
  type: "function", name: "swap", stateMutability: "nonpayable",
  inputs: [{ name: "market", type: "address" }, { name: "receiver", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "params", type: "tuple", components: [{ name: "isMint", type: "bool" }, { name: "amount", type: "uint256" }, { name: "isExactIn", type: "bool" }, { name: "minOutOrMaxIn", type: "uint256" }] }, { name: "dataSwap", type: "bytes" }, { name: "dataGuess", type: "bytes" }, { name: "integrator", type: "address" }, { name: "integratorFeeBps", type: "uint256" }],
  outputs: [],
}];

function guess(amount, iterations = 100n) {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [amount, iterations, 1_000_000_000_000_000n],
  );
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function probe(url) {
  const start = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(4000) });
  const body = await res.json();
  if (!res.ok || body.result !== "0x38") throw new Error("not BSC mainnet");
  return { url, ms: Math.round(performance.now() - start) };
}
async function clients(account) {
  const checked = (await Promise.all(config.rpcUrls.map(async (url) => { try { return await probe(url); } catch { return null; } }))).filter(Boolean).sort((a, b) => a.ms - b.ms);
  if (!checked.length) throw new Error("No available BSC RPC");
  console.log("RPC:", checked.map(({ url, ms }) => `${url} ${ms}ms`).join(", "));
  const transport = fallback(checked.map(({ url }) => http(url, { timeout: 8000, retryCount: 0 })), { retryCount: 1 });
  return { publicClient: createPublicClient({ chain: bsc, transport }), walletClient: createWalletClient({ account, chain: bsc, transport }) };
}
async function approveIfNeeded(publicClient, walletClient, account, abi, token, args, amount, label) {
  const allowance = await publicClient.readContract({ address: token, abi, functionName: "allowance", args });
  if (allowance >= amount) return;
  if (config.preflightOnly) throw new Error(`${label} allowance is insufficient for preflight simulation.`);
  const approveArgs = label === "USDT" ? [config.router, amount] : [config.router, config.tokenId, amount];
  const hash = await walletClient.writeContract({ account, address: token, abi, functionName: "approve", args: approveArgs });
  console.log(`${label} approval:`, hash);
  await publicClient.waitForTransactionReceipt({ hash });
}

async function main() {
  if (!config.privateKey || /^0x0+$/.test(config.privateKey)) throw new Error("PRIVATE_KEY is missing.");
  const account = privateKeyToAccount(config.privateKey);
  const { publicClient, walletClient } = await clients(account);
  const amount = parseUnits(config.amount, 18);
  const response = await fetch(config.graphqlUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query($a:String!){ home_market_list(where:{market_address:{_eq:$a}},limit:1){status title outcomes} }", variables: { a: config.market } }) });
  const market = (await response.json()).data?.home_market_list?.[0];
  const outcome = market?.outcomes?.find((item) => BigInt(item.token_id) === config.tokenId);
  if (!market || market.status !== "live" || !outcome) throw new Error("Target market/outcome is not live.");
  console.log("Market:", market.title, "Outcome:", outcome.name, "Price:", outcome.price_hmr);
  const usdt = await publicClient.readContract({ address: config.collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (usdt < amount) throw new Error(`Insufficient USDT: ${formatUnits(usdt, 18)}`);
  console.log("Account:", account.address, "USDT:", formatUnits(usdt, 18), "waiting ms:", config.delayMs, "preflight:", config.preflightOnly);
  await sleep(config.delayMs);

  const beforeOt = await publicClient.readContract({ address: config.market, abi: marketAbi, functionName: "balanceOf", args: [account.address, config.tokenId] });
  const mintGuess = guess(0n);
  const { result: mintResult } = await publicClient.simulateContract({
    account, address: config.lens, abi: lensAbi, functionName: "simulateMint",
    args: [config.market, config.tokenId, amount, true, "0x", mintGuess, config.integratorFeeBps],
  });
  const mintQuote = mintResult.quote ?? mintResult[2];
  const minOt = (mintQuote.otToUser * (10000n - config.slippageBps)) / 10000n;
  const { result: projectedRedeemResult } = await publicClient.simulateContract({
    account, address: config.lens, abi: lensAbi, functionName: "simulateRedeem",
    args: [config.market, config.tokenId, mintQuote.otToUser, true, "0x", "0x", config.integratorFeeBps],
  });
  const projectedRedeemQuote = projectedRedeemResult.quote ?? projectedRedeemResult[2];
  const recoveryBps = (projectedRedeemQuote.collateralToUser * 10000n) / mintQuote.collateralFromUser;
  console.log(
    "Roundtrip estimate, spend/recover/recovery:",
    formatUnits(mintQuote.collateralFromUser, 18),
    formatUnits(projectedRedeemQuote.collateralToUser, 18),
    `${Number(recoveryBps) / 100}%`,
  );
  if (recoveryBps < config.minRecoveryBps) {
    throw new Error(
      `Projected recovery ${Number(recoveryBps) / 100}% is below minimum ${Number(config.minRecoveryBps) / 100}%; aborting before buy.`,
    );
  }
  await approveIfNeeded(publicClient, walletClient, account, erc20Abi, config.collateral, [account.address, config.router], amount, "USDT");
  const { request: buyRequest } = await publicClient.simulateContract({
    account, address: config.router, abi: routerAbi, functionName: "swap",
    args: [config.market, account.address, config.tokenId, { isMint: true, amount, isExactIn: true, minOutOrMaxIn: minOt }, "0x", mintGuess, config.integrator, config.integratorFeeBps],
  });
  console.log("BUY simulation ready, expected OT:", formatUnits(mintQuote.otToUser, 18), "minimum OT:", formatUnits(minOt, 18));
  if (config.preflightOnly) return;
  const buyStarted = Date.now();
  const buyHash = await walletClient.writeContract(buyRequest);
  const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
  console.log("BUY confirmed:", buyHash, buyReceipt.status);
  recordExecution({ pair: "BNB/USDT", side: "BUY", amount_usdt: Number(formatUnits(mintQuote.collateralFromUser, 18)), status: buyReceipt.status === "success" ? "success" : "failed", tx_hash: buyHash, duration_ms: Date.now() - buyStarted, source: "roundtrip-test" });
  if (buyReceipt.status !== "success") throw new Error("Buy transaction failed.");

  const afterOt = await publicClient.readContract({ address: config.market, abi: marketAbi, functionName: "balanceOf", args: [account.address, config.tokenId] });
  const boughtOt = afterOt - beforeOt;
  if (boughtOt <= 0n) throw new Error("No newly acquired OT to sell.");
  await approveIfNeeded(publicClient, walletClient, account, marketAbi, config.market, [account.address, config.router, config.tokenId], boughtOt, "OT");
  const { result: redeemResult } = await publicClient.simulateContract({
    account, address: config.lens, abi: lensAbi, functionName: "simulateRedeem",
    args: [config.market, config.tokenId, boughtOt, true, "0x", "0x", config.integratorFeeBps],
  });
  const redeemQuote = redeemResult.quote ?? redeemResult[2];
  const minUsdt = (redeemQuote.collateralToUser * (10000n - config.slippageBps)) / 10000n;
  const { request: sellRequest } = await publicClient.simulateContract({
    account, address: config.router, abi: routerAbi, functionName: "swap",
    args: [config.market, account.address, config.tokenId, { isMint: false, amount: boughtOt, isExactIn: true, minOutOrMaxIn: minUsdt }, "0x", "0x", config.integrator, config.integratorFeeBps],
  });
  const sellStarted = Date.now();
  const sellHash = await walletClient.writeContract(sellRequest);
  const sellReceipt = await publicClient.waitForTransactionReceipt({ hash: sellHash });
  console.log("SELL confirmed:", sellHash, sellReceipt.status, "expected USDT:", formatUnits(redeemQuote.collateralToUser, 18));
  recordExecution({ pair: "BNB/USDT", side: "SELL", amount_usdt: Number(formatUnits(redeemQuote.collateralToUser, 18)), status: sellReceipt.status === "success" ? "success" : "failed", tx_hash: sellHash, duration_ms: Date.now() - sellStarted, source: "roundtrip-test" });
}

main().catch((error) => {
  console.error("Roundtrip failed:", error.message);
  process.exitCode = 1;
});
