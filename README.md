# solmara-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/jarcokpahang5-ai/solmara-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/jarcokpahang5-ai/solmara-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Entry for make.fun's Pump.fun Sharpe Sprint bounty — cleanest paper bot wins.

## Strategy

A clean, disciplined paper scalper for the pump.fun replay (agent-fun/replay/v2). Sharpe
(hourly) rewards many small, steady wins, not one lucky moonshot — so this bot buys only
after a confirmed burst of real buy pressure on a somewhat mature curve, sizes every entry
the same small stake (0.02 SOL), and exits fast on a tight take-profit, a stop-loss, a
trailing stop, or a short time limit. Capital recycles fast, so the bot touches many coins
and its hourly equity stays smooth.

- **Entry (momentum):** over the coin's last 40 trades — net SOL flowing in (≥ 0.25 SOL),
  ≥ 5 buys from ≥ 4 distinct wallets, price up 4–60% and sitting near its window high, no
  single wallet over 60% of the buy flow. The coin must be ≥ 250 slots old with 10–80 SOL
  real reserve. One buy per coin per run, never while an order on it is in flight.
- **Exits:** take-profit at 1.10× cost, stop-loss at 0.85× cost, trailing stop 8% once
  armed at +3%, or a 300-slot time limit — whichever comes first.
- **Risk:** max 5 open positions (harness cap), uniform 0.02 SOL stakes, tight slippage
  (500 bps buys / 1000 bps sells) so a fill is refused rather than chased.

## What the dev-window sweeps found

- Chasing runs after they start loses; buying the very first tick loses worse. Selectivity
  is the whole edge: longer window (40 trades), older coins, bigger reserves.
- Longer holds always lose; 300-slot holds beat 1500/6000.
- Fade exits (sell on short-window net outflow) were tried and removed: win rate fell
  from ~46% to ~29%.

## Dev-window grade (local, `grade-local --driver process`)

- Net PnL **-0.050 SOL** (-0.50%), Sharpe (hourly) -0.246, max drawdown 0.76%
- 210 fills over **105 coins**, 105 round trips, win rate 45.7%
- Guardrails met (105 coins ≥ 20, drawdown well under 50%)

The dev window is hard for every approach tried (the kit's own pilot bots score -0.50 to
-9.44 SOL there); this bot sits at the good end of that range with the lowest drawdown.
The final window is fresh 6-hour data, so dev numbers are a guide, not a forecast.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` (Node 22, type-stripping, no dependencies).
`vendor/makefun-bot.ts` is the kit's SDK shim, vendored byte for byte; the strategy lives
in `strategy.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yv60esak&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
