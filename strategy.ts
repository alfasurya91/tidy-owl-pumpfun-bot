// tidy-owl strategy for pump.fun (agent-fun/replay/v2).
// Winner-takes-all NET PnL: highest net PnL wins, subject to round-trip >=0.01 SOL on >=20 mints + max DD <=50%.
// S3 BASELINE — best config passing all guardrails: net PnL -0.0295 SOL, 32 qualifying coins, DD 0.43%, WR 15.6%.

import {
  BPS,
  LAMPORTS_PER_SOL,
  type BotState,
  type Batch,
  type OrderInput,
  type Pubkey,
  type ChainEvent,
  type TradeEventRecord,
  type CreateEventRecord,
  type CompleteEventRecord,
} from './vendor/makefun-bot.ts';

export interface Params {
  minAge: number;
  maxAge: number;
  stakeLamports: bigint;
  maxTotalExposureLamports: bigint;
  minBuySliceLamports: bigint;
  buySlippageBps: number;
  sellSlippageBps: number;
  minRealSolLamports: bigint;
  maxRealSolLamports: bigint;
  minDevBuyLamports: bigint;
  maxDevBuyLamports: bigint;
  maxNonCreatorBuyers: number;
  minNonCreatorBuyers: number;
  minNetInflowLamports: bigint;
  maxSingleSellPctOfReserveBps: number;
  maxRunupFromCreateBps: number;

  // Exits — S3 BASELINE
  tpBps: number;             // +12% = 1200 bps
  slBps: number;             // -8% = 800 bps
  trailArmBps: number;       // arm trailing at +5% = 500 bps
  trailBps: number;          // trail -5% = 500 bps from peak
  maxHoldSlots: number;      // time stop 10 slots
  exitOnCreatorSell: boolean;
  exitOnWhaleSellLamports: bigint;

  cooldownSlots: number;
  maxEntriesPerCoin: number;
  targetQualifyingCoins: number;
  relaxMaxBuyersWhenBehind: number;
  txFeeLamports: bigint;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 15,
  stakeLamports: 50_000_000n,
  maxTotalExposureLamports: 500_000_000n,
  minBuySliceLamports: 10_000_000n,
  buySlippageBps: 1200,
  sellSlippageBps: 10_000,
  minRealSolLamports: 300_000_000n,
  maxRealSolLamports: 30_000_000_000n,
  minDevBuyLamports: 0n,
  maxDevBuyLamports: 2_500_000_000n,
  maxNonCreatorBuyers: 5,
  minNonCreatorBuyers: 4,
  minNetInflowLamports: 1n,
  maxSingleSellPctOfReserveBps: 1000,
  maxRunupFromCreateBps: 2000,

  // S3 BASELINE exits
  tpBps: 1200,               // +12%
  slBps: 800,                // -8%
  trailArmBps: 500,          // +5%
  trailBps: 500,             // -5%
  maxHoldSlots: 10,          // 10 slots
  exitOnCreatorSell: true,
  exitOnWhaleSellLamports: 1_000_000_000n,

  cooldownSlots: 200,
  maxEntriesPerCoin: 2,
  targetQualifyingCoins: 25,
  relaxMaxBuyersWhenBehind: 8,
  txFeeLamports: 105_000n,
};

const FEE_BPS = 125n;

interface CoinTape {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuyLamports: bigint;
  trades: number;
  nonCreatorBuyers: Set<Pubkey>;
  boughtLamports: bigint;
  soldByOthersLamports: bigint;
  maxSingleSellBps: bigint;
  creatorSold: boolean;
  lastTradeSlot: number;
  complete: boolean;
}

interface HeldPos {
  entrySlot: number;
  entryCount: number;
  costLamports: bigint;
  tokens: bigint;
  peakValueLamports: bigint;
  lastExitSlot: number;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

function priceRatioBps(vq: bigint, vt: bigint, vq0: bigint, vt0: bigint): bigint {
  if (vq0 === 0n || vt0 === 0n || vq === 0n || vt === 0n) return 0n;
  return (vq * vt0 * BPS) / (vt * vq0);
}

function markValueLamports(tokens: bigint, vq: bigint, vt: bigint, txFee: bigint): bigint {
  const val = sellValue(tokens, vq, vt);
  return val > txFee ? val - txFee : 0n;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;

  const tapes = new Map<Pubkey, CoinTape>();
  const held = new Map<Pubkey, HeldPos>();
  const selling = new Set<Pubkey>();
  let qualifyingRoundTrips = 0;
  let firstBatchSlot: number | null = null;

  function ingestEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const ce = e as CreateEventRecord;
        const tape: CoinTape = {
          mint: ce.mint,
          createSlot: ce.slot,
          creator: ce.creator,
          vq0: BigInt(ce.virtual_quote_reserves),
          vt0: BigInt(ce.virtual_token_reserves),
          devBuyLamports: 0n,
          trades: 0,
          nonCreatorBuyers: new Set(),
          boughtLamports: 0n,
          soldByOthersLamports: 0n,
          maxSingleSellBps: 0n,
          creatorSold: false,
          lastTradeSlot: ce.slot,
          complete: false,
        };
        tapes.set(ce.mint, tape);
      } else if (e.event === 'TradeEvent') {
        const te = e as TradeEventRecord;
        const tape = tapes.get(te.mint);
        if (!tape) continue;

        const sol = BigInt(te.sol_amount);
        const isBuy = te.is_buy;
        const isDev = te.user === tape.creator;

        tape.trades += 1;
        tape.lastTradeSlot = te.slot;

        if (isBuy) {
          if (isDev && te.slot === tape.createSlot) {
            tape.devBuyLamports += sol;
          } else if (!isDev) {
            tape.nonCreatorBuyers.add(te.user);
            tape.boughtLamports += sol;
          }
        } else {
          if (isDev) {
            tape.creatorSold = true;
          } else {
            tape.soldByOthersLamports += sol;
            const realSolBefore = BigInt(te.real_quote_reserves) + sol;
            if (realSolBefore > 0n) {
              const bps = (sol * BPS) / realSolBefore;
              if (bps > tape.maxSingleSellBps) tape.maxSingleSellBps = bps;
            }
          }
        }
      } else {
        const tape = tapes.get(e.mint);
        if (tape) tape.complete = true;
      }
    }
  }

  function qualifiesForEntry(state: BotState, tape: CoinTape, slot: number, maxBuyersNow: number): boolean {
    const age = slot - tape.createSlot;
    if (age < P.minAge || age > P.maxAge) return false;
    if (tape.complete) return false;
    if (tape.creatorSold && P.exitOnCreatorSell) return false;

    const curve = state.curves.get(tape.mint);
    if (!curve || curve.complete) return false;

    const realSol = curve.real_quote_reserves;
    if (realSol < P.minRealSolLamports || realSol > P.maxRealSolLamports) return false;

    if (tape.devBuyLamports < P.minDevBuyLamports || tape.devBuyLamports > P.maxDevBuyLamports) return false;

    const buyerCount = tape.nonCreatorBuyers.size;
    if (buyerCount < P.minNonCreatorBuyers) return false;
    if (buyerCount > maxBuyersNow) return false;

    const netInflow = tape.boughtLamports - tape.soldByOthersLamports;
    if (netInflow <= P.minNetInflowLamports) return false;

    if (tape.maxSingleSellBps > P.maxSingleSellPctOfReserveBps) return false;

    const runupBps = priceRatioBps(curve.virtual_quote_reserves, curve.virtual_token_reserves, tape.vq0, tape.vt0);
    if (runupBps > BPS + BigInt(P.maxRunupFromCreateBps)) return false;

    const maxBuy = state.maxBuyLamports(tape.mint);
    if (maxBuy < P.minBuySliceLamports) return false;

    return true;
  }

  function currentMaxBuyers(state: BotState): number {
    if (firstBatchSlot === null) return P.maxNonCreatorBuyers;
    const elapsed = state.slot - firstBatchSlot;
    if (elapsed <= 0) return P.maxNonCreatorBuyers;
    const PACING_WINDOW_SLOTS = 1000;
    const expected = (P.targetQualifyingCoins * elapsed) / PACING_WINDOW_SLOTS;
    if (qualifyingRoundTrips < expected) {
      return P.relaxMaxBuyersWhenBehind;
    }
    return P.maxNonCreatorBuyers;
  }

  return {
    onBatch(state, batch) {
      if (firstBatchSlot === null) {
        firstBatchSlot = batch.slot;
      }

      ingestEvents(batch);

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled' && f.side === 'sell') {
          const h = held.get(f.mint);
          if (h && h.costLamports >= 10_000_000n) {
            qualifyingRoundTrips += 1;
          }
          held.delete(f.mint);
          selling.delete(f.mint);
        } else if (f.status === 'filled' && f.side === 'buy') {
          const pos = state.positions.get(f.mint);
          if (pos) {
            held.set(f.mint, {
              entrySlot: f.slot,
              entryCount: 1,
              costLamports: pos.cost_lamports,
              tokens: pos.token_amount,
              peakValueLamports: 0n,
              lastExitSlot: 0,
            });
          }
        }
      }

      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (h) {
          h.costLamports = pos.cost_lamports;
          h.tokens = pos.token_amount;
        } else {
          held.set(mint, {
            entrySlot: state.slot,
            entryCount: 1,
            costLamports: pos.cost_lamports,
            tokens: pos.token_amount,
            peakValueLamports: 0n,
            lastExitSlot: 0,
          });
        }
      }

      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint)) {
          held.delete(mint);
        }
      }
      for (const mint of [...selling]) {
        if (!state.positions.has(mint) && !hasPendingSell(state, mint)) {
          selling.delete(mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txFee = state.txFeeLamports();

      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // ---------- EXITS ----------
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;

        const h = held.get(mint);
        if (!h) continue;

        const tape = tapes.get(mint);
        const mk = marks.get(mint);
        let vq: bigint, vt: bigint;
        if (mk) {
          vq = mk.vq;
          vt = mk.vt;
        } else {
          const cv = state.curves.get(mint);
          if (!cv) continue;
          vq = cv.virtual_quote_reserves;
          vt = cv.virtual_token_reserves;
        }

        const value = markValueLamports(pos.token_amount, vq, vt, txFee);
        const basis = h.costLamports;

        if (value > h.peakValueLamports) {
          h.peakValueLamports = value;
        }

        let exit = false;

        // TP +8%
        if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) {
          exit = true;
        }
        // SL -6%
        if (value * BPS <= basis * (BPS - BigInt(P.slBps))) {
          exit = true;
        }
        // Trailing stop
        if (h.peakValueLamports * BPS >= basis * (BPS + BigInt(P.trailArmBps))) {
          if (value * BPS <= h.peakValueLamports * (BPS - BigInt(P.trailBps))) {
            exit = true;
          }
        }
        // Time stop 20 slots
        if (state.slot - h.entrySlot >= P.maxHoldSlots) {
          exit = true;
        }
        // Creator sell
        if (tape && P.exitOnCreatorSell && tape.creatorSold) {
          exit = true;
        }

        if (exit) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlippageBps });
          selling.add(mint);
          h.lastExitSlot = state.slot;
          continue;
        }
      }

      // ---------- ENTRIES ----------
      const maxBuyersNow = currentMaxBuyers(state);

      let freeCash = state.freeCashLamports();
      let openPositions = state.committedPositionCount();

      for (const [mint, tape] of tapes) {
        if (orders.length >= cap) break;
        if (tape.complete) continue;

        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;

        const hasPos = state.positions.has(mint);
        const hasPendingBuy = hasPendingBuyOrder(state, mint);

        const h = held.get(mint);
        if (h && state.slot - h.lastExitSlot < P.cooldownSlots) continue;

        const entryCount = h?.entryCount ?? 0;
        if (entryCount >= P.maxEntriesPerCoin) continue;

        if (!hasPos && openPositions >= state.hello.caps.max_open_positions) continue;

        if (tape.creatorSold && P.exitOnCreatorSell) continue;

        if (!qualifiesForEntry(state, tape, state.slot, maxBuyersNow)) continue;

        const realSol = curve.real_quote_reserves;

        const maxBuy = state.maxBuyLamports(mint);
        let wantLamports = P.stakeLamports;
        if (hasPos && h) {
          if (h.costLamports >= P.stakeLamports) continue;
          wantLamports = P.stakeLamports - h.costLamports;
        }

        const amount = wantLamports < maxBuy ? wantLamports : maxBuy;
        if (amount < P.minBuySliceLamports) continue;

        let currentExposure = 0n;
        for (const hp of held.values()) {
          currentExposure += hp.costLamports;
        }
        if (currentExposure + amount > P.maxTotalExposureLamports) continue;

        if (freeCash < amount + txFee) continue;

        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        freeCash -= amount + txFee;
        if (!hasPos) openPositions += 1;
      }

      return orders;
    },
  };
}

function hasPendingBuyOrder(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return true;
  }
  return false;
}

function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell' && p.order.mint === mint) return true;
  }
  return false;
}