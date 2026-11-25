// Ember: an early-momentum scalper for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// What the dev window teaches (24h of pump.fun chain data, 1,122 coins):
//   - Most coins die within ~10 minutes of creation; the median coin's best-ever
//     price is only ~1.17x its first-trade price, but ~17% reach 2x and ~3%
//     complete the curve at ~14x. The money is in catching a few runners
//     while losers are cut fast, not in holding the average coin.
//   - A coin that has gathered a few SOL of real reserves with several distinct
//     buyers and positive net inflow reaches +50% from there about 44% of the
//     time, so a small stake with a tight stop and a trailing exit can have
//     positive expectancy even after the ~2.5% round-trip curve fee plus the
//     fixed per-order tx fee.
//   - Dumps are instant: 15 minutes after its peak a coin is typically worth
//     63% of the peak. Exits therefore trigger on the first bad batch, sells
//     accept any price (slippage 10000), and no position is held long.
//
// Rules, in short: watch every coin from its CreateEvent; buy ONE small fixed
// stake when it is young, has real reserves in band, several distinct buyers,
// positive recent net inflow, a sane run-up from its create price, and no
// creator sale / bundle / big-sell red flag. The strongest filter found on
// the dev window is the creator's own opening buy: 0.2–2.5 SOL of skin in
// the game, no more and no less. Never re-enter a coin. Exit within ~15
// slots on a stop loss, a trailing stop once ahead, a hard take-profit, a
// time limit, a creator sale, or a single big sell — holding longer only
// loses money on this market, where a coin is typically worth 63% of its
// peak 15 minutes later. Sells accept any price. A coin whose real reserves
// approach completion rides: stops and the time limit are suspended and only
// a deep stop can end it, because completion pays ~14x.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream, with
// touched mints processed in sorted order so the reply never depends on
// arrival order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** SOL staked on one coin (a single buy; the 1%-of-real-reserve cap means the
   *  coin must hold at least stakeSol * 100 SOL of real reserves at entry). */
  stakeSol: number;
  /** Youngest/oldest age (slots since CreateEvent) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Real SOL reserve band at entry. minRqSol is normally stakeSol * 100 so the
   *  whole stake fits in one order under the 1% cap. */
  minRqSol: number;
  maxRqSol: number;
  /** Distinct non-creator buyers that must have bought before entry. */
  minBuyers: number;
  /** Distinct non-creator buyers in the create slot, at most: a launch bundled
   *  by many wallets in its first slot is usually a dump in waiting. */
  maxFirstSlotBuyers: number;
  /** Creator's own buys (SOL) in the create slot: entry band. Too little means
   *  no skin in the game; too much means a big bag waiting to dump. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Net SOL (buys minus sells) over the recent window that entry requires. */
  flowWindow: number;
  minFlowSol: number;
  /** Buy trades in the recent window that entry requires. */
  minRecentBuys: number;
  /** Price now over the create price: entry band (don't buy below the start,
   *  don't chase a coin that already ran far). */
  minRunup: number;
  maxRunup: number;
  /** A single recorded sell of at least this share of the real SOL reserve
   *  before entry disqualifies the coin for good. */
  maxSellShare: number;
  /** Slippage allowed on buys (bps). */
  buySlipBps: number;
  /** Exit: sell everything when the position is worth this far under its cost. */
  stopLoss: number;
  /** Exit: sell everything when the position is worth this far over its cost. */
  takeProfit: number;
  /** Trailing stop: arms once the position is worth cost * (1 + trailArm);
   *  then sell on a fall of `trail` from the best value seen. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots (suspended while riding). */
  maxHold: number;
  /** Real SOL at/above which the coin rides toward completion: the stop loss,
   *  trailing stop, take-profit and time limit are suspended and only the deep
   *  stop below can end the position. */
  rideRqSol: number;
  /** Deep stop while riding (fraction under cost). */
  rideStopLoss: number;
  /** A single recorded sell of at least this share of the real SOL reserve
   *  while holding exits. */
  exitBigSellShare: number;
  /** Exit while holding once the creator has sold at least this many SOL in total. */
  devSellExitSol: number;
  /** Skip entry when the creator has already sold at least this many SOL. */
  skipDevSoldSol: number;
  /** Keep this much SOL of free cash unspent so a sell's tx fee is always payable. */
  cashBufferSol: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.05,
  minAge: 0,
  maxAge: 600,
  minRqSol: 5,
  maxRqSol: 40,
  minBuyers: 2,
  maxFirstSlotBuyers: 8,
  minDevBuySol: 0.2,
  maxDevBuySol: 2.5,
  flowWindow: 10,
  minFlowSol: 0.05,
  minRecentBuys: 2,
  minRunup: 1.0,
  maxRunup: 1.75,
  maxSellShare: 0.25,
  buySlipBps: 1000,
  stopLoss: 0.2,
  takeProfit: 0.25,
  trailArm: 0.12,
  trail: 0.2,
  maxHold: 15,
  rideRqSol: 55,
  rideStopLoss: 0.4,
  exitBigSellShare: 0.3,
  devSellExitSol: 0.5,
  skipDevSoldSol: 0.5,
  cashBufferSol: 0.2,
};

const LAMPORTS = 1e9;
/** Curve fee on every fill: protocol 95 bps + creator 30 bps (the hello fallbacks). */
const CURVE_FEE = 0.0125;
const BPS = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  creator: string | null;
  /** Create-time price (virtual quote / virtual token) for the run-up band. */
  createPrice: number;
  /** Distinct non-creator buyers in the create slot (bundle filter). */
  firstSlotBuyers: Set<string>;
  /** Distinct non-creator buyers overall. */
  buyers: Set<string>;
  /** SOL the creator bought in the create slot. */
  devBuySol: number;
  /** SOL the creator has sold in total. */
  devSoldSol: number;
  /** Largest single sell seen, as a share of the real SOL reserve just before it. */
  maxSellShare: number;
  /** Recent trades, pruned to the entry window plus a margin. */
  trades: Trade[];
  /** Never buy again (entered once, exited, filtered out for good, completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  opened: number;
  /** Best close value seen (SOL, net of curve fee and the sell tx fee). */
  peakValue: number;
  /** A sell is already in flight for this position. */
  exiting: boolean;
  /** Some buy of this position filled (the position is real, not just decided). */
  filled: boolean;
  /** Cost of the tokens still held, in SOL, as the account reports it. */
  cost: number;
}

function sellValue(tokens: number, vq: number, vt: number): number {
  if (tokens <= 0 || vt <= 0) return 0;
  const q = (tokens * vq) / (vt + tokens);
  return q * (1 - CURVE_FEE);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.flowWindow, 1) + 5;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: null,
        creator: null,
        createPrice: 0,
        firstSlotBuyers: new Set<string>(),
        buyers: new Set<string>(),
        devBuySol: 0,
        devSoldSol: 0,
        maxSellShare: 0,
        trades: [],
        done: false,
        complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const tr = c.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  const recentBuys = (c: Coin, now: number, w: number): number => {
    let n = 0;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const tr = c.trades[i]!;
      if (tr.slot <= now - w) break;
      if (tr.buy) n++;
    }
    return n;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched = new Set<Pubkey>();
      const bigSell = new Set<Pubkey>();
      // A sell that came back rejected or failed frees the position to try again.
      for (const f of batch.fills) {
        if (f.side === 'sell' && f.status !== 'filled' && !f.client_id.startsWith('_')) {
          const h = held.get(f.mint);
          if (h !== undefined) h.exiting = false;
        }
      }
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          const vt = Number(e.virtual_token_reserves);
          c.createPrice = vt > 0 ? Number(e.virtual_quote_reserves) / vt : 0;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const vt = Number(e.virtual_token_reserves);
          c.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: vt > 0 ? Number(e.virtual_quote_reserves) / vt : 0,
          });
          touched.add(e.mint);
          if (c.created !== null && e.slot === c.created) {
            if (e.is_buy) {
              if (c.creator !== null && e.user === c.creator) c.devBuySol += sol;
              else c.firstSlotBuyers.add(e.user);
            }
          }
          if (e.is_buy) {
            if (c.creator === null || e.user !== c.creator) c.buyers.add(e.user);
          } else {
            // Share of the real SOL reserve this sell took: the reserves in the
            // event are post-trade, so add the sold SOL back for the pre-trade base.
            const rqBefore = (Number(e.real_sol_reserves) + Number(e.sol_amount)) / LAMPORTS;
            const share = rqBefore > 0 ? sol / rqBefore : 1;
            if (share > c.maxSellShare) c.maxSellShare = share;
            if (c.creator !== null && e.user === c.creator) c.devSoldSol += sol;
            if (share >= p.exitBigSellShare) bigSell.add(e.mint);
          }
        } else {
          coinOf(e.mint).complete = true;
        }
      }
      for (const mint of touched) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.trades.length && c.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.trades.splice(0, cut);
      }
      const touchedSorted = [...touched].sort();

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const m = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') m.buy = true;
        else m.sell = true;
        pendingByMint.set(po.order.mint, m);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Value of a held position now (SOL, net of curve fee and the sell tx fee).
      const valueOf = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        return sellValue(Number(pos.token_amount), vq, vt) / LAMPORTS - tx;
      };

      // Exits first: every held position is re-priced on this batch's reserves.
      for (const mint of [...held.keys()].sort()) {
        const h = held.get(mint)!;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            if (h.filled) coinOf(mint).done = true;
          }
          continue;
        }
        h.filled = true;
        h.cost = Number(pos.cost_lamports) / LAMPORTS;
        if (curve === undefined || curve.complete) continue;
        if (h.exiting) continue;
        const pend = pendingByMint.get(mint);
        if (pend !== undefined && pend.sell) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const value = valueOf(mint);
        if (value > h.peakValue) h.peakValue = value;
        const riding = rqSol >= p.rideRqSol;
        const c = coinOf(mint);
        let exit = false;
        if (riding) {
          if (value < h.cost * (1 - p.rideStopLoss)) exit = true;
        } else {
          if (value < h.cost * (1 - p.stopLoss)) exit = true;
          else if (value >= h.cost * (1 + p.takeProfit)) exit = true;
          else if (h.peakValue >= h.cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
          else if (now - h.opened > p.maxHold) exit = true;
        }
        if (!exit && c.devSoldSol >= p.devSellExitSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
        h.exiting = true;
      }

      // Entries: one fixed stake per coin, only on coins that traded this batch.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of touchedSorted) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const c = coins.get(mint)!;
        if (c.done || c.complete || held.has(mint)) continue;
        if (pendingByMint.has(mint)) continue;
        if (c.created === null || now - c.created < p.minAge || now - c.created > p.maxAge) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        if (c.devSoldSol >= p.skipDevSoldSol || c.devBuySol < p.minDevBuySol || c.devBuySol > p.maxDevBuySol) continue;
        if (c.firstSlotBuyers.size > p.maxFirstSlotBuyers) continue;
        if (c.buyers.size < p.minBuyers) continue;
        if (c.maxSellShare >= p.maxSellShare) continue;
        if (flow(c, now, p.flowWindow) < p.minFlowSol) continue;
        if (recentBuys(c, now, p.flowWindow) < p.minRecentBuys) continue;
        const vt = Number(curve.virtual_token_reserves);
        const price = vt > 0 ? Number(curve.virtual_quote_reserves) / vt : 0;
        if (c.createPrice <= 0 || price <= 0) continue;
        const runup = price / c.createPrice;
        if (runup < p.minRunup || runup > p.maxRunup) continue;
        // The 1%-of-real-reserve cap must fit the whole stake in one order.
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        if (capSol < p.stakeSol) continue;
        if (free < p.stakeSol + tx + p.cashBufferSol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.stakeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        held.set(mint, { opened: now, peakValue: 0, exiting: false, filled: false, cost: p.stakeSol });
        c.done = true;
        free -= p.stakeSol + tx;
        slotsLeft--;
      }
      return orders;
    },
  };
}
