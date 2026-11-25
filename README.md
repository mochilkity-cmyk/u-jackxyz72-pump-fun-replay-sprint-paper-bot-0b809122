# Ember — Pump.fun Replay Sprint paper bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mochilkity-cmyk/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mochilkity-cmyk/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Ember is an early-momentum scalper (see `strategy.ts` for the full rules):

- Watch every coin from its `CreateEvent`. Buy **one small fixed stake** (0.05 SOL) when the coin is young, holds real reserves in band, has several distinct buyers, positive recent net inflow, a sane run-up from its create price, and no red flag (creator sale, bundled launch, big single sell). Never re-enter a coin.
- Exit fast on a stop loss, a trailing stop once ahead, a hard take-profit, a time limit, a creator sale, or a single big sell. Sells accept any price — dumps on pump.fun are instant.
- A coin whose real reserves approach completion **rides**: stops and the time limit are suspended and only a deep stop can end it, because completing the curve pays ~14x.

The bot is dependency-free, deterministic (no clock, no randomness, no network), and speaks the `agent-fun/replay/v2` protocol over stdin/stdout via the kit's SDK shim in `vendor/`.

## Run

```sh
node main.ts
```

The grader runs `node /bot/main.ts` on Node 22.23.4.

## Files

- `main.ts` — entrypoint: wires the strategy into the replay shim.
- `strategy.ts` — the trading rules.
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim, copied byte for byte from the bounty kit.
- `LICENSE` — MIT.
