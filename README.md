# WIPEOUT — perp liquidation radar

**Live: https://wipeout-kappa.vercel.app**

Single-file, zero-backend dashboard. Every visitor's browser talks straight to
Hyperliquid and Lighter; nothing runs on a server and no keys are needed.
Rate limits apply per viewer IP, so it scales by itself.

## Run locally

```sh
cd ~/wipeout && python3 -m http.server 8447   # → http://localhost:8447
```

## Deploy

```sh
cd ~/wipeout && npx vercel deploy --prod --yes
```

## What it shows

- **The map (left)** — one unified plot: the live price (thin line by default;
  PRICE toggle switches to candles or off) drawn over translucent liquidation
  bands anchored to the price axis. Bands = real Hyperliquid positions at their
  exact liquidation prices; shorts die above price, longs below. Diamonds = the
  biggest individual positions (hover for wallet/size/leverage; click → Hypurrscan).
  Ground truth, not a Coinglass-style estimate. The range auto-zooms per coin to
  wherever most of the money actually dies (manual zoom overrides).
- **Live wipes (right)** — on-chain venues only: Lighter's typed trade stream
  (every liquidation on subscribed markets) and Hyperliquid wipes detected from
  position tracking (marked ◆ — most tracked money, but not literally every
  account; HL has no global liq feed). Rows show entry → wiped price, and how
  long the position was open when we watched it open. All CEX feeds (Binance,
  Bybit, OKX, Gate, Aster) are excluded: sampled or unverifiable.
- **Coins** — a searchable, categorized dropdown built at boot from Hyperliquid's
  universe: every perp with >$1M 24h volume (plus pinned favorites like CASHCAT),
  sorted by volume, Lighter markets matched automatically.
- **HL vs Lighter table (under the map)** — mark, open interest, and annualized
  funding for the two on-chain books, side by side.
- **$ liquidated strip (header)** — how much got wiped in each 30-second slice,
  last 20 minutes. Green portion = longs wiped, red = shorts (even split =
  half/half bar). Green = longs, red = shorts everywhere in the app.
- **Whale bias** — accounts ≥$5M + named/tagged desks: net long/short across
  their whole book, the ~30-min shift, and which coins they're piling into.
- **Hyperliquid positioning** — tracked notional, % in profit, $ that dies within
  2% / 5% of price ("the hunt zone").
- **Venue table (bottom)** — mark, OI, funding APR, long/short ratios per exchange
  for the selected coin.

## How the map is built

1. Pull the public HL leaderboard (~42k wallets, cached 6h in IndexedDB).
2. Sweep the top ~4k by account value + weekly volume through
   `clearinghouseState` (~7 wallets/s, inside the 1200 weight/min IP limit).
   Wallets with a position within 2.5% of its liq price get re-checked every ~25s.
3. Harvest fresh wallets live from the HL trade tape (every trade names both sides).
4. Wallet labels: HL leaderboard display names + Hypurrscan aliases + your own
   watchlist (bottom of the HL panel, saved in localStorage).

## Honest caveats

- CEX liquidation feeds are *sampled* except Bybit's (`allLiquidation`, complete).
  Binance pushes at most one event per symbol per second — totals under-report cascades.
- The map covers tracked HL wallets (a few thousand of the biggest), not every
  wallet — treat it as "where serious money dies", which is the hunt zone anyway.
- CEX books are private; nobody can build a real map for them (Coinglass sells an
  estimate). Funding APRs assume 8h intervals on CEXs, 1h on HL.
