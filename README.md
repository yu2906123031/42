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

## 安全执行模式

开盘买入链路采用 plan-driven 执行：

- `scripts/aoe-opening-plan-generator.js` 负责发现当天 Futures Daily Volume market，读取 Binance Futures 24h、1d、1h 成交额数据，预测 UTC 日成交额并生成 `runtime-state/opening_snipe_plans.json`。
- `scripts/aoe-auto-runner.js` 负责发现市场、先生成 plan、批量授权、按已有 plan 并发执行；某个 pair 没有生成 plan 时，该 pair 会被跳过。
- `scripts/aoe-onchain-buy.js` 只负责按 plan 里的 `market_address`、`selected_token_id`、`outcome_name`、`buy_amount_usdt`、`max_price` 精确买入。

自动买入默认使用 `AOE_BUY_MODE=AUTO`，脚本会读取 `runtime-state/opening_snipe_plans.json`，并把链上 `market_address`、`selected_token_id`、`outcome_name`、`buy_amount_usdt`、`max_price` 绑定到同一个计划。AUTO/SMART 模式缺少计划文件时会直接退出，避免回退到过期的 `TARGET_TOKEN_ID`。

手动生成开盘 plan：

```bash
PLAN_DRY_RUN=1 npm run plan:aoe:opening
npm run plan:aoe:opening
```

常用 plan 配置：`AUTO_BUY_PAIRS`、`EVENT_DAY`、`GRAPHQL_URL`、`BINANCE_FAPI_URL`、`OPENING_SNIPE_PLAN_PATH`、`PLAN_MIN_CONFIDENCE`、`PLAN_MAX_PRICE`、`PLAN_ALLOW_LOW_CONFIDENCE`、`PRIMARY_BUY_USDT`、`BTC_BUY_USDT`、`SOL_BUY_USDT`、`ETH_BUY_USDT`。

开盘 plan 先识别 volume regime，再选档：

- `NORMAL`：保守均值回归，默认 `NORMAL_CONSERVATIVE_FACTOR=0.80`，早盘再额外降权。
- `TRANSITION`：轻度保守，默认 `TRANSITION_CONSERVATIVE_FACTOR=0.90`，边界保护保留。
- `SPIKE`：异常放量跟随，需要成交额与 1h/3h realized volatility 同时确认；默认允许最高档、关闭机械下调，并用 `SPIKE_BUY_AMOUNT_FACTOR=0.50` 半仓。
- `POST_SPIKE_COOLDOWN`：异常后冷却，默认 `POST_SPIKE_CONSERVATIVE_FACTOR=0.85`，`current24hVolume` 权重只有 5%，重点看 UTC 当日与日内动量，避免 24h 残影误导。

默认 pair profile：BNB 允许 `SPIKE`，BTC/SOL/ETH 的 spike 信号会降级为 `TRANSITION`，避免常规高估场景追高。相关阈值可用 `REGIME_NORMAL_SPIKE_RATIO`、`REGIME_SPIKE_RATIO`、`REGIME_INTRADAY_SPIKE_RATIO`、`REGIME_POST_SPIKE_DECAY_RATIO`、`REGIME_POST_SPIKE_MOMENTUM_RATIO`、`SPIKE_PROJECTED_CAP_MULTIPLIER` 调整。

回测 regime 维度：

```bash
npm test
PLAN_DRY_RUN=1 node scripts/aoe-opening-plan-generator.js
node scripts/aoe-plan-backtest.js
```

人工验证时使用：

```bash
AOE_BUY_MODE=MANUAL DRY_RUN=1 \
  MARKET_ADDRESS=0xfFb5Ce7060E6CE733EaBcb984dA7B47a721184bd \
  TARGET_OUTCOME=AOE TARGET_TOKEN_ID=4 BUY_AMOUNT_USDT=0 MAX_PRICE=1 \
  npm run buy:aoe:onchain
```

并发自动买入使用 `NonceManager` 从 pending nonce 或 `BASE_BUY_NONCE` 分配连续 nonce；`auto_buy_locks` 按 `event_day + pair` 加锁，`AUTO_BUY_FORCE=1` 才会覆盖，并记录 `nonce`、`error`、`tx_hash` 方便实盘复盘。

`OPENING_EXECUTION_MODE` 支持三种安全执行模式：

- `HYBRID`：默认模式，先链上 quote/simulate，再提交交易；旧的 `PRE_SIGN_OPENING_TX` 在该模式下不会触发预签。只有明确设置 `HYBRID_PRESIGN_AFTER_QUOTE=1` 时，quote 之后才会走预签广播。实盘推荐使用该模式。
- `SAFE_SIMULATE`：全程模拟优先，强制关闭预签，适合实盘前验证与保守运行。
- `FAST_PRESIGN`：开盘前准备签名交易并在条件满足时广播，适合抢开盘成交，需配合更严格的计划、价格与 nonce 管理；确认 plan 和 allowance 长期稳定后再启用。

Runner 在真实买入前会按本轮全部 pair 的 `buy_amount_usdt` 做一次 USDT allowance preflight。allowance 不足时只提交一次 Router `approve(MAX_UINT256)`，receipt 成功后会向子进程传递 `BATCH_APPROVAL_DONE`、`BATCH_APPROVAL_OWNER`、`BATCH_APPROVAL_TOTAL_WEI`、`BATCH_APPROVAL_TX`；子进程仅在 owner 匹配且本单金额被总额度覆盖时跳过 allowance 检查。

成交记录会写入 market/token/outcome/event_day、nonce、graph/effective price、quote/minOut、plan_id 等上下文；`success` / `confirmed` 记录必须带 `tx_hash`。Dashboard 的实时 KPI、strategy 汇总和 `daily_stats` 只统计 `aoe-onchain-buy` / `aoe-auto-claim` 来源，demo、manual、scheduler 行通过 source 保留在明细中。Dashboard 余额字段在接入链上读取前返回 `null`，并标记 `walletBalanceSource` / `usdtBalanceSource` 为 `not_configured`，前端应隐藏假余额。

Auto-claim 使用成交记录里的 `market_address` 与 `token_id` 精确查询 market 并执行 claim；历史记录缺少 market/token 绑定时只记录 `legacy_skip`。需要迁移旧数据时可临时设置 `LEGACY_CLAIM_ALLOW_DISCOVERY=1` 做人工受控发现。

Dashboard 写接口支持 `AOE_DASHBOARD_WRITE_TOKEN`：设置后，`POST /api/config` 与 `POST /api/executions` 必须携带 `x-aoe-dashboard-token` 或 `Authorization: Bearer <token>`。CORS 默认限制到 localhost，可用 `AOE_DASHBOARD_ALLOWED_ORIGINS` 覆盖；生产环境未设置 token 时写接口返回 401。
