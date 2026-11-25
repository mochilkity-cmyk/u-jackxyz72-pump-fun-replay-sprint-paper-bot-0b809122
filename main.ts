// Ember: an early-momentum scalper for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). See strategy.ts for the rules.
//
// The grader runs `node /bot/main.ts` on Node 22.23.4; this file is plain
// erasable TypeScript (no build step, no dependencies) and speaks the replay
// protocol over stdin/stdout through the kit's SDK shim in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
