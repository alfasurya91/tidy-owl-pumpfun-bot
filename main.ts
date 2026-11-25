// agent-fun/replay/v2 pump.fun bot: tidy-owl strategy (winner-takes-all NET PnL).
// Grader runs `node main.ts` (Node 22, type-stripping, no build/install/network).
// Protocol: NDJSON on stdin/stdout — harness sends hello, then one batch per slot, then done.
// Bot replies exactly one reply per batch (echoing seq) containing 0..N orders.
// Stdout is for replies only; diagnostics go to stderr.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  // Called once after hello, before the first batch.
  onHello(state) {
    // Strategy initialization is internal to createStrategy closure.
    // state.hello.seed is the only source of randomness if ever needed.
  },

  // Called once per batch after state absorbed it; return orders for this slot.
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },

  // Called once after the final account (positions already flattened). No reply is sent.
  onDone(state, done) {
    // Nothing to do.
  },
});