# @pithy-sh/multiplayer

Authoritative, turn-based multiplayer sessions on Cloudflare. The server holds the game state no client can be trusted with, resolves it, and writes a durable result to your own D1.

The package is **sessions infrastructure plus pluggable game models**. The session — membership bound to an authenticated user, a lifecycle, hidden per-player state, an alarm-driven deadline, a durable D1 result, a one-way leaderboard publish — is the same for every game. What a *game* is lives behind a `GameModel`, resolved by `kind`. Three example games ship — built on reusable pattern helpers — and you can register your own.

This is Pithy's first Durable Object. `pithy add multiplayer` wires the DO binding and its class migration tag into `wrangler.jsonc` for every environment, and writes the `MultiplayerSession` export into your worker entry; `pithy migrate` creates the result table. You write games as config.

## Games, and the patterns you build them on

A **game** is a `GameModel`: it defines how a move validates, how state advances, when the game ends, who wins, and what each player may see. The `GameModel` seam + registry is the generic, extensible foundation — but you rarely implement it from scratch. Three **pattern helpers** own the reusable lifecycle plumbing, and you layer a game on one of them by supplying only the game-specific rules:

- **`simultaneous(...)`** — every player submits a hidden choice at once; the server resolves them together when all are in. You supply the submission shape and a scoring function; the helper owns the collect-then-reveal lifecycle and the hidden-state boundary. (This is "simultaneous" in the game-theory sense, with a trusted server holding the secrets — not a cryptographic commit-reveal protocol.) Built-in example: **`battle`** (secret offensive/defensive moves; an offense scores unless any opponent blocked it — a duel or an N-player free-for-all).
- **`turnBased(...)`** — players act one at a time; the helper owns turn order and advancement. You supply the shared state, how a move changes it, and win detection. Built-in example: **`connect-n`** (tic-tac-toe at `3×3 connect 3`, Connect Four at `7×6 connect 4`, gomoku at `15×15 connect 5`).
- **`wageringTable(...)`** — a persistent casino table; the helper owns the bet book, the ledger holds, the settlement, and the table lifecycle. You supply what a valid bet is, who may trigger the random event, and how it decides each bet. Built-in example: **`craps`** (pass / don't-pass / field, come-out and point phases, shooter rotation; the house is the off-ledger counterparty).

So `battle`, `connect-n`, and `craps` are *example games* that also show how to build your own. For anything the examples don't cover — a Words-With-Friends-style game with a hidden rack *and* a dictionary — pick the closest pattern (or the raw `GameModel` seam), write the game, and `registerGameModel(myGame)` in your worker entry. Only the game logic is yours; the session infrastructure is the same for every game.

## Wagering: randomness, tables, and money

Three seams turn the session infrastructure into a wagering platform (how any of it maps to real money, and the regulation that implies, is the adopter's concern — Pithy provides the mechanics):

- **Provably-fair randomness.** Every session mints a crypto seed at creation and commits its SHA-256 hash up front (in the view's `fairness.seedHash`); the seed is revealed when the session ends. A model draws from `ctx.random` (a deterministic, seeded stream the DO advances and persists), so dice and shuffles are server-authoritative *and* an auditor can replay the seed to verify every roll.
- **Persistent tables.** A game with `mode: "table"` is long-lived: it is active from creation, players `join` and `leave` between rounds (buy in, cash out), the model settles each round, and the table stays open until it is closed or empties. (`mode: "match"`, the default, is the one-game-to-a-result lifecycle.)
- **Ledger settlement.** A model's `apply`/`resolve` are pure — they cannot touch a database — so a bet *declares* ledger effects (`hold` a stake, `capture` a loss, `credit` a win) that the DO settles through `@pithy-sh/ledger`. A hold a player cannot cover rejects the action; a deterministic model re-emits the same effect refs, so a replay pays once. Install `@pithy-sh/ledger` for any wagering game.

A craps table is just config:

```ts
multiplayer({
  games: [
    { key: "craps", kind: "craps", mode: "table", players: 8, rules: { currency: "chips", minBet: 5, maxBet: 100 } },
  ],
})
```


## What this is NOT

Cloudflare already ships the rooms layer, and it is good. This capability does not rebuild it.

It is **not rooms, not chat, not presence, not broadcast.** Cloudflare acquired PartyKit and still ships and maintains [PartyServer](https://github.com/cloudflare/partykit) — room routing, lifecycle hooks, a hibernation-uniform API, broadcast. If you want a room, use PartyServer or a raw Durable Object.

It is **not real-time action netcode** — no rollback, prediction, lag compensation, or fixed high-rate ticks. A fixed-rate loop on a Durable Object never hibernates, so it pins the object in memory and bills duration continuously (see `docs/costs.md`). For real-time action, use Photon.

It is **not matchmaking or skill rating** — different capabilities, or someone else's.

## Honest comparison

Pithy's claim is narrow, and it is not "we are better." Colyseus and Nakama are good software; if you already run one, or want what they do best, use them.

- **Colyseus** (MIT, mature) ships server-authoritative rooms and a better hidden-state primitive than this does at v1 (`StateView`). It does not run on Cloudflare — it needs an always-on Node/Bun process holding room state in memory, scaled by a matchmaker and load balancer.
- **Nakama** (Apache-2.0 core) ships authoritative TypeScript handlers and targets async mobile. It does not run on Cloudflare — it is a containerized Go binary requiring PostgreSQL/CockroachDB, running continuously.
- **Photon** owns real-time action netcode outright. This capability does not compete with it.

**What Pithy offers:** if you are already on Cloudflare, `pithy add multiplayer` wires authoritative sessions into your auth, your D1, your leaderboard, and your environments — the DO binding, the class migration tag, the per-environment namespaces — and you operate nothing. No competitor is a kit, so no competitor does this. That is the whole pitch: the wiring and the composition, not superiority. The one genuinely novel piece is atomic simultaneous resolution — a trusted server collects every hidden submission and resolves them together — not just a visibility filter.

## Define games

```ts
multiplayer({
  games: [
    // A battle (simultaneous pattern). `players` defaults to 2; set it higher for a free-for-all.
    {
      key: "battle",
      kind: "battle",
      rules: {
        offense: {
          pick: 3,
          moves: [
            { name: "fire", power: 10 },
            { name: "ice", power: 8 },
            { name: "wind", power: 6 },
            { name: "stone", power: 4 },
          ],
        },
        defense: {
          pick: 3,
          moves: [
            { name: "guard-fire", blocks: "fire" },
            { name: "guard-ice", blocks: "ice" },
            { name: "guard-wind", blocks: "wind" },
            { name: "guard-stone", blocks: "stone" },
          ],
        },
      },
      turnTimeoutMs: 60_000, // abandon if a submission doesn't land in time (alarm-enforced, never a timer)
      leaderboard: { board: "wins", points: { win: 3, draw: 1, loss: 0 } }, // optional, needs @pithy-sh/leaderboard
    },
    // A connect-n game (turn-based pattern) — this is tic-tac-toe. Connect Four is { rows: 7, cols: 6, connect: 4 }.
    {
      key: "tictactoe",
      kind: "connect-n",
      rules: { rows: 3, cols: 3, connect: 3 },
    },
  ],
})
```

## Play a session

```
POST /multiplayer/games/:game            → create a session (you are its first member)
POST /multiplayer/sessions/:id/join      → another player joins
POST /multiplayer/sessions/:id/action    → take your action (the body is whatever the game's model defines)
POST /multiplayer/sessions/:id/leave     → leave a table seat (table mode)
POST /multiplayer/sessions/:id/close     → close a table (table mode)
GET  /multiplayer/sessions/:id           → your redacted view (opponents' hidden state stays hidden)
GET  /multiplayer/sessions/:id/result    → the durable result, once terminal
GET  /multiplayer/sessions/:id/socket    → live play over a hibernation-safe WebSocket
```

An action is game-specific — a `{ offense, defense }` submission for `battle`, a `{ row, col }` cell for `connect-n`, a `{ kind: "bet", ... }` or `{ kind: "event" }` for `craps` — and the route forwards its JSON body untouched to the game's model. Every route requires authentication; membership binds to the authenticated user id from Pithy's `AuthContext` seam, never a client-supplied id, so add `@pithy-sh/auth`.

## Cost

Read `docs/costs.md` before production. A session hibernating on a player's turn bills nothing, but the 20:1 WebSocket-message billing ratio and the fixed 128 MB duration allocation shape the bill of an active session.

## License

MIT — adopter-side app value, the same as `@pithy-sh/auth` and `@pithy-sh/leaderboard`. The root `LICENSE` covers it.
