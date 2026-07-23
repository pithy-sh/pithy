# @pithy-sh/wallet

A per-user balance ledger for your app's economy — chips, gold, gems, credits, tokens — in your own D1. Currency-agnostic, and correct by construction.

Every game with an economy needs this, not just gambling. It's the primitive under in-game currency, rewards, buy-ins, prize pools, and wagers. It composes with `@pithy-sh/multiplayer` (escrow a wager, settle a payout) the same way `@pithy-sh/leaderboard` does — but it stands alone.

## Correctness is the product

A balance store that can double-spend or go negative is not a balance store. Three invariants hold no matter how operations interleave or how many times they're delivered — and they're enforced by the database, not by hopeful application code:

- **Atomic.** Each operation is one `DB.batch` (a D1 transaction): the ledger entry and the balance change commit together or not at all. There is never a recorded movement with no matching balance change.
- **Idempotent.** Every operation carries a caller-supplied `ref`, written as a `UNIQUE` ledger row. A replay inserts a duplicate `ref`, which aborts the transaction; the operation returns the balance unchanged. **A payout delivered twice pays once.**
- **Overdraft-safe.** A debit or hold is applied by an `UPDATE` guarded by the account's `CHECK (balance >= 0 AND held >= 0 AND held <= balance)`. A movement that would break solvency — even against a balance another concurrent operation just lowered — aborts, and surfaces `wallet/insufficient_funds`. No race slips past a `CHECK` in SQLite.

**Amounts are integers in the currency's minor unit** — never floats — so arithmetic is exact. A currency's `decimals` only says how to *display* them.

## Money and regulation are yours

The wallet is currency-agnostic and takes no position on whether your units map to money. If they do, KYC/AML, licensing, responsible-gaming limits, and payment rails are your concern — Pithy provides the ledger; you provide the compliance.

## What it is *not* — scores, levels, and XP

The wallet is for **spendable, fungible balances**: things a player *holds and spends* — chips, gems, redeemable reward points. Its holds, overdraft protection, and transfers only make sense for value that moves and can run out.

Ranked scores and player progression are a different shape and belong elsewhere:

- **Scores / rankings** → `@pithy-sh/leaderboard` (ranked, windowed daily/weekly/all-time, joinable in your own D1).
- **XP / levels** → a leaderboard board, or a small table of your own. They only ever go up, you never "spend" a level, and none of the wallet's hold/overdraft/transfer machinery applies — using the wallet for XP would be forcing a spend-and-settle ledger onto a counter.

The one genuine overlap is **spendable reward points** (earn them, then redeem them for something) — that *is* a wallet currency, because you spend it. If a player can never spend it, it is a score, not a balance.

## Configure

```ts
wallet({
  currencies: [
    { code: "chips", name: "Casino Chips" },
    { code: "gold", name: "Gold", decimals: 2 }, // stored as integer minor units; 150 displays as 1.50
  ],
})
```

## Use the ledger in-process

The ledger is a server-authoritative primitive. Your own code — a game model, a reward handler, a trusted server route — calls it directly against the `DB` binding. Pass a unique `ref` for every operation so retries are safe.

```ts
import { ledger } from "@pithy-sh/wallet/src/ledger/ledger";

const w = ledger(env.DB);

await w.credit("alice", "chips", 1000, "signup-bonus:alice"); // open + fund an account
await w.debit("alice", "chips", 50, "buyin:table-7:hand-3");  // fails if the balance can't cover it
await w.transfer("alice", "bob", "chips", 30, "tip:xyz");     // atomic move between two players

// Wagering: hold the stake when the bet is placed, resolve it when the outcome lands.
await w.hold("alice", "chips", 100, "bet:hand-9:alice");      // reserves 100 (balance unchanged, available drops)
await w.capture("bet:hand-9:alice");                          // she lost → the stake is spent
// or: await w.release("bet:hand-9:alice");                   // pushed → the stake returns

const { balance, held, available } = await w.balance("alice", "chips");
```

## HTTP surface

Balance reads are for players; moving funds over HTTP is server-authoritative.

```
GET  /wallet/:currency               → your balance                (bearer | session)
GET  /wallet/:currency/transactions  → your recent ledger entries  (bearer | session)
POST /wallet/:currency/credit        → add funds to a player       (bearer | session + wallet:admin)
POST /wallet/:currency/debit         → remove funds from a player  (bearer | session + wallet:admin)
```

A read is always scoped to the authenticated caller — never a user id in the request body — so no player can read or move another's balance without the admin scope. Add `@pithy-sh/auth`; without it every route is denied.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
