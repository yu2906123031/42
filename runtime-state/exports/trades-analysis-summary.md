# AOE trades.db analysis

Source DB: `runtime-state/trades.db`

## Counts
- Total executions: 282
- Last 7 days exported rows: 27
- Success/confirmed: 254
- Failed: 28
- Pending: 0

## Live-source stats
- Live sources counted for real dashboard stats: aoe-onchain-buy, aoe-auto-claim
- Live success/confirmed: 9
- Live turnover USDT: 25.997607
- Live gas USDT: 0.116405

## Status summary
- success: n=254, amount_usdt=40480.997607, gas_usdt=38.878405
- failed: n=28, amount_usdt=4287.000000, gas_usdt=3.950000

## Findings
- Pending records: no (0)
- Success/confirmed with empty tx_hash: no (0)
- gas_usdt abnormal (<0 or >1): no (0)
- amount_usdt distribution among BUY records:
  - 88.0: 45
  - 160.0: 45
  - 142.0: 45
  - 106.0: 45
  - 180.0: 30
  - 318.0: 30
  - 249.0: 30
  - 5.0: 2
  - 1.9998358216272099: 2
  - 9.998957145754854: 1
  - 1.9997487462323358: 1
  - 2.0: 1
  - 1.9998775105815014: 1
  - 1.9998033685070316: 1
  - 1.9998362794711102: 1
  - 1.999749770589414: 1
  - 1.999962830111967: 1
- source distribution:
  - aoe-scheduler: 180
  - manual: 90
  - aoe-onchain-buy: 12

## Failure reasons
- 25x Gas cap reached before submission
- 2x The contract function "swap" reverted with the following reason:
- 1x The contract function "swap" reverted with the following signature:

## Recommendations
- Keep AUTO mode bound to opening_snipe_plans.json so pair, market, token, amount, and max_price share one source of truth.
- Keep batch allowance preflight before concurrent BUY submission.
- Keep success/confirmed execution writes gated on non-empty tx_hash.
- Keep demo/manual/scheduler rows excluded from live dashboard stats and exports clearly labeled by source.
