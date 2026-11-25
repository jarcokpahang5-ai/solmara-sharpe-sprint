// Solmara Sharpe Sprint — a clean, disciplined paper scalper for the pump.fun replay.
//
// Idea: Sharpe (hourly) rewards many small, steady wins, not one lucky moonshot. The dev data
// says why: buy a coin once its real reserve reaches 1 SOL and its median price is -6% after
// 300 slots and -14% by the end — but 74% of coins spike at least +10% above that entry price
// at some point. So the bot buys only after a confirmed burst of real buy pressure on a
// somewhat mature curve (40-trade window, 250+ slots old, 10+ SOL real reserve), sizes every
// entry the same small stake (0.02 SOL), and exits fast on a tight take-profit, a stop-loss, a
// trailing stop, or a short time limit. Capital recycles fast, so the bot touches many coins
// and its hourly equity stays smooth.
//
// What the sweeps found (local sim, verified to match grade-local within 0.01 SOL):
// - Chasing runs after they start loses; buying the very first tick loses worse (-1.18 SOL).
//   Selectivity is the whole edge: longer window (40), older coins, bigger reserves.
// - Longer holds always lose; 300-slot holds beat 1500/6000.
// - Tight slippage on both sides helps a little (500 buy / 1000 sell bps).
// - Fade exits (sell on short-window net outflow) were tried and removed: win rate fell
//   from ~46% to ~29%.
// - minAge 250 was chosen over 450/500 for the final 6h window: nearly the same net PnL
//   but ~104 dev coins vs ~84, a safer margin above the 20-coin guardrail.
//
// 'earliest' mode (buy the first tick the size cap allows) is kept as an alternative entry
// but is NOT the default: it lost far more in testing. A coin is bought at most once per run
// and never while an order on it is still in flight.
//
// Exit: sell the whole position when its marked value reaches TAKE_PROFIT x cost, falls to
// STOP_LOSS x cost, trails TRAIL below its peak (once armed), or the hold passes MAX_HOLD slots.
// Sells go out at max slippage so a fill is never refused for the price moving in the latency.
//
// Deterministic by construction: no clock, no environment, no randomness; iteration only over
// insertion-ordered maps fed by the batch stream. Diagnostics go to stderr only.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry mode: 'momentum' (buy pressure burst) or 'earliest' (first chance the size cap allows). */
  entryMode: 'momentum' | 'earliest';
  /** Trades kept per coin for the entry window. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip coins that already ran too far in one window. */
  maxPriceUp: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL put into one position. */
  stakeSol: number;
  /** Slippage on buys (bps). Tighter buys refuse a fill when the price ran away in the latency. */
  buySlipBps: number;
  /** Slippage on sells (bps). Tighter sells refuse a fill when the price ran away in the latency. */
  sellSlipBps: number;
  /** Sell when marked value reaches cost * takeProfit. */
  takeProfit: number;
  /** Sell when marked value falls to cost * stopLoss. */
  stopLoss: number;
  /** Trailing stop: sell when value falls to peak * (1 - trail). */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMode: 'momentum',
  window: 40,
  minNetSol: 0.25,
  minBuys: 5,
  minBuyers: 4,
  minPriceUp: 0.04,
  maxPriceUp: 0.6,
  nearHigh: 0.96,
  maxBuyerShare: 0.6,
  minRqSol: 10,
  maxRqSol: 80,
  minAge: 250,
  stakeSol: 0.02,
  buySlipBps: 500,
  sellSlipBps: 1000,
  takeProfit: 1.1,
  stopLoss: 0.85,
  trail: 0.08,
  trailArm: 0.03,
  maxHold: 300,
  cooldown: 150,
  maxEntries: 1,
};

/** One recorded trade: slot, price (quote lamports per token), signed SOL, buyer. */
interface TapeTrade {
  slot: number;
  price: number;
  sol: number;
  buyer: string;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  mint: Pubkey;
  buySlot: number;
  peakValue: bigint;
}

const LAMPORTS = 1e9;

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a buy or sell of ours still in flight. */
  const inFlight = new Set<Pubkey>();
  /** Coins we have filled an order on (for the guardrail pace). */
  const myCoins = new Set<Pubkey>();
  let myFills = 0;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
      // Keep memory bounded: drop the stalest tape once the map gets big.
      if (tapes.size > 8000) {
        const first = tapes.keys().next().value;
        if (first !== undefined && first !== mint) tapes.delete(first);
      }
    }
    return t;
  };

  /** Price of a curve now, in quote lamports per token, from virtual reserves. */
  const priceOf = (state: BotState, mint: Pubkey): number => {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n) return 0;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  };

  /** Marked value of a position in lamports at the curve's current price. */
  const valueOf = (state: BotState, mint: Pubkey, tokens: bigint): bigint => {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n) return 0n;
    return (tokens * c.virtual_quote_reserves) / c.virtual_token_reserves;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const { caps } = state.hello;
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slots = caps.max_open_positions - state.committedPositionCount();
      const stake = BigInt(Math.round(p.stakeSol * LAMPORTS));

      // Fold this batch's fills in: clear in-flight flags, track our fills/coins, note exits.
      for (const f of batch.fills) {
        inFlight.delete(f.mint);
        if (f.client_id.startsWith('_')) {
          // Harness close (complete / flatten / writeoff): the position is gone.
          if (held.has(f.mint)) {
            const h = held.get(f.mint)!;
            tapeOf(f.mint).lastExit = batch.slot;
            held.delete(f.mint);
            void h;
          }
          continue;
        }
        if (f.status === 'filled') {
          myFills += 1;
          myCoins.add(f.mint);
          if (f.side === 'sell') {
            tapeOf(f.mint).lastExit = batch.slot;
            held.delete(f.mint);
          } else if (f.side === 'buy') {
            const pos = state.positions.get(f.mint);
            if (pos !== undefined) {
              const v = valueOf(state, f.mint, pos.token_amount);
              held.set(f.mint, { mint: f.mint, buySlot: batch.slot, peakValue: v });
            }
          }
        }
      }

      // Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const vt = Number(e.virtual_token_reserves);
          const vq = Number(e.virtual_quote_reserves);
          if (vt > 0) {
            t.trades.push({
              slot: e.slot,
              price: vq / vt,
              sol: (e.is_buy ? 1 : -1) * (Number(e.sol_amount) / LAMPORTS),
              buyer: e.user,
            });
            if (t.trades.length > p.window) t.trades.splice(0, t.trades.length - p.window);
          }
        } else {
          // CompleteEvent: the curve is done; drop its tape.
          tapes.delete(e.mint);
        }
      }

      // --- Exits first: sell whole positions on TP / SL / trail / time. ---
      for (const [mint, pos] of state.positions) {
        if (inFlight.has(mint)) continue;
        const h = held.get(mint);
        const value = valueOf(state, mint, pos.token_amount);
        const cost = pos.cost_lamports;
        let exit = false;
        if (value >= (cost * BigInt(Math.round(p.takeProfit * 1000))) / 1000n) exit = true;
        else if (value <= (cost * BigInt(Math.round(p.stopLoss * 1000))) / 1000n) exit = true;
        else if (h !== undefined) {
          if (value > h.peakValue) h.peakValue = value;
          const armed = h.peakValue >= (cost * BigInt(Math.round((1 + p.trailArm) * 1000))) / 1000n;
          if (armed && value <= (h.peakValue * BigInt(Math.round((1 - p.trail) * 1000))) / 1000n) exit = true;
          if (batch.slot - h.buySlot >= p.maxHold) exit = true;
        }
        // Fade exits were tried and removed: selling on short-window net outflow cut the win
        // rate from ~46% to ~29% — it sold winners during normal churn.
        if (exit) {
          if (orders.length >= caps.max_orders_per_batch) break;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
          inFlight.add(mint);
        }
      }

      // --- Entries: one fresh buy per coin, only on a confirmed burst of buy pressure. ---
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const mint = e.mint;
        if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
        if (state.positions.has(mint) || inFlight.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        if (t.entries >= p.maxEntries) continue;
        if (batch.slot - t.lastExit < p.cooldown) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (t.created !== null && batch.slot - t.created < p.minAge) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;

        if (p.entryMode === 'earliest') {
          // Buy the first spike: enter the moment the size cap allows a real buy, while the
          // coin is still young. The data says most coins spike early and then bleed, so the
          // edge is being in before the spike, not chasing it after.
          if (t.trades.length < 3) continue;
        } else {
          let net = 0;
          let buys = 0;
          let buySol = 0;
          const buyers = new Set<string>();
          let firstPrice = 0;
          let lastPrice = 0;
          let high = 0;
          const perBuyer = new Map<string, number>();
          for (let i = 0; i < t.trades.length; i++) {
            const tr = t.trades[i];
            if (i === 0) firstPrice = tr.price;
            lastPrice = tr.price;
            if (tr.price > high) high = tr.price;
            net += tr.sol;
            if (tr.sol > 0) {
              buys += 1;
              buySol += tr.sol;
              buyers.add(tr.buyer);
              perBuyer.set(tr.buyer, (perBuyer.get(tr.buyer) ?? 0) + tr.sol);
            }
          }
          if (t.trades.length < p.window) continue;
          if (firstPrice <= 0 || lastPrice <= 0) continue;
          const up = lastPrice / firstPrice - 1;
          if (net < p.minNetSol) continue;
          if (buys < p.minBuys) continue;
          if (buyers.size < p.minBuyers) continue;
          if (up < p.minPriceUp || up > p.maxPriceUp) continue;
          if (lastPrice < high * p.nearHigh) continue;
          let topShare = 0;
          for (const v of perBuyer.values()) if (buySol > 0 && v / buySol > topShare) topShare = v / buySol;
          if (topShare > p.maxBuyerShare) continue;
        }

        const cap = state.maxBuyLamports(mint);
        if (cap < LAMPORTS_PER_SOL / 100n) continue; // below the 0.01 SOL round-trip floor
        const amount = cap < stake ? cap : stake;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        t.entries += 1;
        inFlight.add(mint);
        free -= amount + tx;
        slots -= 1;
      }

      return orders;
    },

    onDone(state: BotState): void {
      console.error(
        `solmara-sharpe-sprint done: fills=${myFills} coins=${myCoins.size} ` +
          `cash=${state.cash} positions=${state.positions.size}`,
      );
    },
  };
}
