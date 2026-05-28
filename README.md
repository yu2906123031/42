# AOE On-Chain Buy

只保留 AOE 链上买入入口：

```powershell
npm run buy:aoe:onchain
```

配置 `.env`：

```env
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org
BSC_RPC_URLS=https://bsc-dataseed.bnbchain.org,https://bsc-dataseed-public.bnbchain.org,https://bsc-dataseed.nariox.org,https://bsc-dataseed.defibit.io,https://bsc-dataseed.ninicoin.io
MARKET_ADDRESS=0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd
TARGET_OUTCOME=AOE
TARGET_TOKEN_ID=4
BUY_AMOUNT_USDT=5
MAX_PRICE=0.0015
SLIPPAGE_BPS=200
PRIVATE_KEY=0x...
```

脚本会轮询 42 GraphQL，等市场 `live` 后用 EOA 私钥在 BSC 上直接调用 Router 买入。链上操作前会并发探测配置的 BSC RPC，选用返回 Chain ID `56` 的最低延迟节点，并在有效候选间自动回退。

## 桌面端自动买入

在 AOE Dashboard 点击 `启用自动买入` 后，软件会在每天北京时间 `07:59:30` 预先发现下一 UTC 日的 BNB Daily Volume 市场。北京时间 `08:00:00` 后，程序严格使用 Binance Futures `BNBUSDT` UTC 日 K 线 `Vol(USDT)` 进行预测，自动选择主区间并可选取邻近副区间，而不是固定买入某个 outcome。

自动买入必须同时通过成交额异常过滤、置信度过滤和 outcome 价格过滤。同一北京时间日期最多启动一组订单。历史成交仍保存在 `runtime-state/trades.db`，成交量历史与预测记录保存在 `runtime-state/volume_history.db`。

可选配置：

```env
AUTO_MODE=SMART
PRIMARY_BUY_USDT=5
SECONDARY_BUY_USDT=0
AUTO_MAX_OUTCOME_PRICE=0.45
MIN_CONFIDENCE=60
AUTO_SKIP_IF_DAILY_VOL_BELOW=100000000
AUTO_SKIP_IF_DAILY_VOL_ABOVE=1000000000
OPENING_SNIPE_MODE=true
OPENING_SNIPE_WINDOW_MINUTES=30
```
