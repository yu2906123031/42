import { ethers } from "ethers";

const RPC_URL = process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Set PRIVATE_KEY");

const ROUTER = "0x888888886619275d33c00D3BC62DF94D700DCD42";
const LENS = "0x4AAd5A856941FB64df10362024e3Ece24023d4d1";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const MARKET = process.env.MARKET_ADDRESS || "0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd";
const TOKEN_ID = BigInt(process.env.TOKEN_ID || "4");
const AMOUNT_USDT = process.env.AMOUNT_USDT || "10";
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS || "200");
const INTEGRATOR = process.env.INTEGRATOR || "0xc60E3415648684b1D0D0D97e85CB21E6a2bCb620";
const INTEGRATOR_FEE_BPS = BigInt(process.env.INTEGRATOR_FEE_BPS || "40");

const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];
const lensAbi = [
  "function simulateMint(address market,uint256 tokenId,uint256 amount,bool isExactIn,bytes dataSwap,bytes dataGuess,uint256 integratorFeeBps) returns ((uint256 tokenId,uint256 price,uint256 supply,uint256 totalMarketCap,uint256 payoutPerOt) pre,(uint256 tokenId,uint256 price,uint256 supply,uint256 totalMarketCap,uint256 payoutPerOt) post,(uint256 collateralFromUser,uint256 collateralToTreasury,uint256 collateralToIntegrator,uint256 otToUser) quote)",
];
const routerAbi = [
  "function swap(address market,address receiver,uint256 tokenId,(bool isMint,uint256 amount,bool isExactIn,uint256 minOutOrMaxIn) params,bytes dataSwap,bytes dataGuess,address integrator,uint256 integratorFeeBps)",
];

function encodeGuess(otDeltaGuess, maxIterations, eps) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "uint256", "uint256"],
    [otDeltaGuess, maxIterations, eps],
  );
}

function smartSimEps(amount) {
  if (amount < 5) return 50_000_000_000_000_000n;
  if (amount <= 1000) return 1_000_000_000_000_000n;
  return BigInt(Math.floor((1 / amount) * 1e18));
}

function smartEps(amount) {
  if (amount < 5) return 200_000_000_000_000_000n;
  if (amount <= 3000) return 1_000_000_000_000_000n;
  return BigInt(Math.floor((1 / amount) * 1e18));
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const usdt = new ethers.Contract(USDT, erc20Abi, wallet);
const lens = new ethers.Contract(LENS, lensAbi, wallet);
const router = new ethers.Contract(ROUTER, routerAbi, wallet);

const amountWei = ethers.parseUnits(AMOUNT_USDT, 18);
const allowance = await usdt.allowance(wallet.address, ROUTER);
if (allowance < amountWei) {
  const tx = await usdt.approve(ROUTER, ethers.MaxUint256);
  console.log("approve:", tx.hash);
  await tx.wait();
}

const amountNumber = Number(AMOUNT_USDT);
const simGuess = encodeGuess(0n, 100n, smartSimEps(amountNumber));
const [, , quote] = await lens.simulateMint.staticCall(
  MARKET,
  TOKEN_ID,
  amountWei,
  true,
  "0x",
  simGuess,
  INTEGRATOR_FEE_BPS,
);

const minOut = (quote.otToUser * (10_000n - SLIPPAGE_BPS)) / 10_000n;
const execGuess = encodeGuess(quote.otToUser, 50n, smartEps(amountNumber));

const tx = await router.swap(
  MARKET,
  wallet.address,
  TOKEN_ID,
  [true, amountWei, true, minOut],
  "0x",
  execGuess,
  INTEGRATOR,
  INTEGRATOR_FEE_BPS,
);
console.log("swap:", tx.hash);
await tx.wait();
