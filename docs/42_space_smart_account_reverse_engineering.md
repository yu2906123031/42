# 42.space Smart Account Reverse Engineering

目标：

- 分析前端 JS
- 找 Privy 配置
- 找 ZeroDev 配置
- 找 Bundler 地址
- 找 Paymaster 地址
- 找 UserOperation 结构
- 实现 Python 版下单器
- 不依赖浏览器
- 不依赖 Playwright
- 支持自动交易机器人

## 结论

42 官方 REST API Alpha 没有下单接口，也没有公开的 smart account relayer endpoint。官方文档确认 REST API 当前是只读数据接口，交易执行在链上合约完成。

因此，无浏览器版机器人不能靠 `docs.42.space/api` 下单。它必须走 ERC-4337 / ZeroDev / Kernel 智能账户路径：

```text
Privy 登录/owner signer
  -> ZeroDev Kernel smart account
  -> build Router swap calldata
  -> build UserOperation
  -> paymaster sponsor / sign
  -> bundler eth_sendUserOperation
```

如果没有合法 Privy session、owner signer 或已签 UserOperation，不能代表 42 智能账户交易。

## 已定位的前端配置

### Privy

前端公开 JS 中的 Privy Provider：

```text
appId = cmi46hf4x01mxjr0cbet4t15e
loginMethods = wallet, email, google, discord, twitter
walletChainType = ethereum-only
embeddedWallets.ethereum.createOnLogin = all-users
```

这说明 42 使用 Privy 管理登录和 embedded wallet。智能账户交易需要 Privy 登录后得到的 wallet client / signer。

### Chain

```text
chain = BNB Smart Chain
chainId = 56
```

### Collateral

```text
BUSDT / USDT = 0x55d398326f99059ff775485246999027b3197955
decimals = 18
```

### Router / Lens / Integrator

前端 production config：

```text
routerAddress = 0x888888886619275d33c00D3BC62DF94D700DCD42
lensAddress = 0x8aF85927Cb4deBE57C47DDE5cdb4665839f55a32
integratorAddress = 0xc60E3415648684b1D0D0D97e85CB21E6a2bCb620
integratorFeeBps = 40
```

官方 deployments 文档还列出：

```text
FTRouter = 0x88888888338e60bfB4657187169cFFa5c8640E42
```

实际前端交易用的是 proxy/router config 中的 `0x888888886619275d33c00D3BC62DF94D700DCD42`。

### Bundler / Paymaster

前端 ZeroDev/Pimlico 配置：

```text
ZeroDev bundler:
https://rpc.zerodev.app/api/v3/81d8983c-a3ff-4521-8553-31ad0c4e2155/chain/56

ZeroDev Alchemy provider:
https://rpc.zerodev.app/api/v3/81d8983c-a3ff-4521-8553-31ad0c4e2155/chain/56?provider=ALCHEMY

Pimlico bundler/paymaster:
https://api.pimlico.io/v2/56/rpc?apikey=pim_EoZgCEstSMGMb3zUYB2U85

Paymaster context:
sponsorshipPolicyId = sp_natural_sumo
```

## 前端交易路径

前端关键调用链：

```text
useTrade().swap(...)
  -> useZeroDev().swap(...)
  -> executeMint(kernelClient, ...)
  -> getERC20Approval(collateral, smartAccount, router)
  -> simulateMint(market, tokenId, amountWei, collateralDecimals)
  -> encodeDataGuess(...)
  -> router.swap(...)
  -> kernelClient.core.sendUserOperation({ calls })
  -> kernelClient.core.waitForUserOperationReceipt(...)
```

买入时构造的 calls：

```text
if USDT allowance < amount:
  call 1: USDT.approve(router, maxUint256)

call 2: Router.swap(
  market,
  receiver,
  tokenId,
  {
    isMint: true,
    amount: amountWei,
    isExactIn: true,
    minOutOrMaxIn: simulatedOtOut * (1 - slippage)
  },
  dataSwap = 0x,
  dataGuess,
  integrator,
  integratorFeeBps
)
```

## Router `swap` ABI

```solidity
function swap(
  address market,
  address receiver,
  uint256 tokenId,
  SwapParams params,
  bytes dataSwap,
  bytes dataGuess,
  address integrator,
  uint256 integratorFeeBps
)

struct SwapParams {
  bool isMint;
  uint256 amount;
  bool isExactIn;
  uint256 minOutOrMaxIn;
}
```

## Lens `simulateMint`

```solidity
function simulateMint(
  address market,
  uint256 tokenId,
  uint256 amount,
  bool isExactIn,
  bytes dataSwap,
  bytes dataGuess,
  uint256 integratorFeeBps
) returns (
  OtSnapshot pre,
  OtSnapshot post,
  MintQuote quote
)
```

`MintQuote.otToUser` 用于计算买入下限：

```text
minOut = otToUser * (10000 - slippageBps) / 10000
```

## `dataGuess` 编码

前端算法：

```text
encodeDataGuess(otDeltaGuessOffchain, maxIterations, eps)
```

ABI 编码：

```solidity
uint256 otDeltaGuessOffchain
uint256 maxIterations
uint256 eps
```

前端常量：

```text
DEFAULT_MAX_ITERATIONS_SIM = 100
DEFAULT_MAX_ITERATIONS_EXECUTE = 50
```

`smartSimEps(amount)`：

```text
amount < 5       -> 0.05e18
amount <= 1000   -> 0.001e18
otherwise        -> floor(1 / amount * 1e18)
```

`smartEps(amount)`：

```text
amount < 5       -> 0.2e18
amount <= 3000   -> 0.001e18
otherwise        -> floor(1 / amount * 1e18)
```

## UserOperation 结构

前端包里同时存在 EntryPoint v0.6 和 v0.7 类型。ZeroDev Kernel 当前实现由 SDK 封装，发送时不是手写交易，而是：

```text
kernelClient.core.sendUserOperation({ calls })
```

Bundler JSON-RPC 最终是：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_sendUserOperation",
  "params": [
    {
      "sender": "0x...",
      "nonce": "0x...",
      "initCode": "0x...",
      "callData": "0x...",
      "callGasLimit": "0x...",
      "verificationGasLimit": "0x...",
      "preVerificationGas": "0x...",
      "maxFeePerGas": "0x...",
      "maxPriorityFeePerGas": "0x...",
      "paymasterAndData": "0x...",
      "signature": "0x..."
    },
    "0x..."
  ]
}
```

或 EntryPoint v0.7 packed fields：

```json
{
  "sender": "0x...",
  "nonce": "0x...",
  "initCode": "0x...",
  "callData": "0x...",
  "accountGasLimits": "0x...",
  "preVerificationGas": "0x...",
  "gasFees": "0x...",
  "paymasterAndData": "0x...",
  "signature": "0x..."
}
```

实际版本、nonce key、factory data、paymaster data、signature domain 都由 ZeroDev Kernel SDK 决定。Python 版如果要完全提交，必须复刻这些 SDK 细节，或者接入一个可签名的 Kernel/ZeroDev Python 实现。

## Python 版下单器边界

本仓库生成的 Python 机器人实现以下部分：

- 市场轮询
- outcome 校验
- 价格风控
- Lens `simulateMint`
- USDT `approve` calldata
- Router `swap` calldata
- UserOperation call 列表/骨架
- 可选：提交“已签名 UserOperation”到 bundler

不实现以下绕过：

- 不绕过 Privy 登录
- 不伪造 Privy access token
- 不从浏览器偷取 session
- 不代替 embedded wallet 私钥签名

要实现完全自动、无浏览器下单，有两条合法路径：

1. 使用你控制的 external wallet 作为 42 smart account owner，并在 Python 中用该 owner key 签 Kernel UserOperation。
2. 让 42/Privy/ZeroDev 提供正式 server-side signer 或交易 API。

## 目标市场配置

```text
marketAddress = 0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd
title = BNB/USDT Futures Daily Volume, May 27th?
target tokenId = 4
target outcome = $300M - $450M
amount = 10 USDT
```

