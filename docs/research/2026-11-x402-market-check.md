# Market check — 2026-11-23

Plan Task 1. Script: `scripts/market-check.ts`. Data: the public x402 discovery
list run by Coinbase's CDP facilitator (39,543 listed paid resources, of which
39,179 are on Base mainnet). It includes the facilitator's own 30-day stats:
unique payers and total calls per resource.

On-chain cross-check was **not possible**. The public Base RPC
(`mainnet.base.org`) refuses `eth_getLogs` with "request limit reached". The
facilitator's statistics are used instead. They cover facilitator-settled
payments only and could include sellers paying themselves.

## Verdict: **PAUSE** — direct competitors show almost no demand

| Measure (30 days) | Value |
|---|---|
| Listings in our niche (funding / open interest / liquidations / perps / basis / implied volatility) | **1,224** |
| …of those with ≥ 10 unique payers | 13 |
| …of those with ≥ 50 unique payers | **0** |
| Best direct competitor | 18 unique payers, 35 calls, $0.001/call (Hyperliquid perps data) |
| Typical price in the niche | $0.001 (we planned $0.005–0.01) |

By the plan's rule ("if even the leaders have under ~50 real repeat payers,
pause"), this niche fails. It is crowded, mostly $0.001, and buyers are
scarce.

## What the whole market looks like

- 39,179 Base listings. Only **656** have ≥ 10 unique payers, **99** have ≥ 50,
  and 30 of those show repeat use (calls ≥ 3× payers).
- Rough gross for 30 days across all listings (calls × price): **~$107k**,
  heavily concentrated:

| ~30d gross | Unique payers | Resource |
|---|---|---|
| $41,000 | 22 | Bitrefill invoice payment (gift cards / top-ups) |
| $34,659 | 5,112 | `console.ax1.vc` "q-verdict": crypto token verdict, $0.02 |
| $4,070 | 1,295 | `ax1-new.vercel.app` "q-verdict" (same service) |
| $2,780 | 71 | api-xpay text rewrite |
| $2,370 | 59 | api-xpay sentiment |
| $2,148 | 752 | Clash of Coins in-game shop |

## Reading

- The one crypto-data product with real, repeat demand is a **token
  verdict/safety check** (5,112 payers, ~1.7M calls in 30 days, $0.02 each).
  This matches the earlier research note that the top paid resource was a $0.02
  crypto safety assessment.
- Raw market data (prices, funding, open interest, order books) is offered by
  hundreds of sellers at $0.001 and bought by almost nobody.
- Owner decision needed before more building: pivot, narrow, or stop.
