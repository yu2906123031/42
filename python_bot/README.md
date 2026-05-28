# Python 42 Smart Account Bot

这个 Python 版本不依赖浏览器，也不依赖 Playwright。它完成：

- 监听 42 市场状态
- 校验目标 outcome
- 调用 Lens `simulateMint`
- 构建 USDT `approve` calldata
- 构建 Router `swap` calldata
- 输出 ZeroDev Kernel calls / UserOperation 骨架
- 可选提交已经签名的 UserOperation

它不会绕过 Privy，也不会伪造智能账户签名。要真正提交 42 智能账户交易，需要合法 owner signer / Privy session / ZeroDev Kernel 签名流程。

## 安装

```powershell
pip install -r requirements.txt
```

## 配置

`.env` 示例：

```env
GRAPHQL_URL=https://ft.42.space/v1/graphql
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org
BSC_RPC_URLS=https://bsc-dataseed.bnbchain.org,https://bsc-dataseed-public.bnbchain.org,https://bsc-dataseed.nariox.org,https://bsc-dataseed.defibit.io,https://bsc-dataseed.ninicoin.io
MARKET_ADDRESS=0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd
TARGET_TOKEN_ID=4
BUY_AMOUNT_USDT=10
POLL_MS=500
MAX_PRICE=0.0015
SLIPPAGE_BPS=200
SMART_ACCOUNT_ADDRESS=0x你的42智能账户地址
```

启动时会并发验证 `BSC_RPC_URLS` 中各节点的 Chain ID 与延迟，并选择最快可用 BSC 主网 RPC。`BSC_RPC_URL` 会作为额外候选保留。

## 运行

```powershell
python python_bot/fortytwo_smart_account_bot.py
```

输出的 `calls` 可交给合法 ZeroDev Kernel signer 转换成签名 UserOperation。

## 提交已签名 UserOperation

```env
ENTRY_POINT_ADDRESS=0x...
SIGNED_USEROP_JSON={...}
SUBMIT_SIGNED_USEROP=YES
```

然后运行同一个脚本。注意 `SIGNED_USEROP_JSON` 必须是已经由智能账户 owner 正确签名并经过 paymaster 填充的 UserOperation。
