# AOE trades.db analysis

Source DB: `runtime-state/trades.db`

## Counts
- Total executions: 282
- Last 7 days exported rows: 27
- Success/confirmed: 254
- Failed: 28
- Pending: 0

## Status summary
- success: n=254, amount_usdt=40480.9976, gas_usdt=38.8784
- failed: n=28, amount_usdt=4287.0, gas_usdt=3.95

## Findings
- Pending records: no (0)
- Same-minute duplicate BUY groups: no (0)
- Same-day same-pair successful BUY groups: no (0)
- Success/confirmed with empty tx_hash: no (0)
- gas_usdt abnormal (<0 or >1): no (0)
- amount_usdt distribution among BUY records:
  - 88.0: 45
  - 106.0: 45
  - 142.0: 45
  - 160.0: 45
  - 180.0: 30
  - 249.0: 30
  - 318.0: 30
  - 1.9998358216272099: 2
  - 5.0: 2
  - 1.9997487462323358: 1
  - 1.999749770589414: 1
  - 1.9998033685070316: 1
  - 1.9998362794711102: 1
  - 1.9998775105815014: 1
  - 1.999962830111967: 1
- source distribution:
  - aoe-scheduler: 180
  - manual: 90
  - aoe-onchain-buy: 12
- Claim records: no (0)

## Failure reasons
- 25x Gas cap reached before submission
- 2x The contract function "swap" reverted with the following reason: BEP20: transfer
- 1x The contract function "swap" reverted with the following signature: 0x774620b8

## Recommendations
- Run the new opening-plan enforced AUTO mode so daily pair/token/amount/max_price comes from one plan file.
- Keep auto-buy locks enabled as a preventive guard for future same-day same-pair duplicates.
- Treat empty tx_hash successful rows as invalid execution records; enforce tx_hash required for success/confirmed writes.
- Preflight allowance before BUY submission; recent failures include BEP20 allowance reverts.
- Add a migration step for old trades.db files so new claim fields such as market_address/token_id/buy_id exist before auto-claim runs.
- Keep demo/seed data isolated from live trades; the source distribution contains manual/aoe-scheduler rows with large synthetic amounts.
