---
name: game-design
description: Settle a game's authority and anti-cheat before any code is written. For a multiplayer game, its room state and action and view schemas. For a single-player game, the run the server re-simulates, its submission route, engine version and bounds checks. Run in the main session. Use at the start of a new game on Pithy, or before a change to what a room holds, what a player may send, or how a run is verified.
---

Settle what is expensive to get wrong in a game, before anyone writes code. You are the main session. Ask, decide with the user, and write the result down in this conversation. Do not delegate this.

Ask one question at a time. Recommend an answer with each, and say why in one sentence.

First, unless `/pithy-games:new-game` already asked: **do players share a live room?** If they do, settle steps 1 to 5. If they do not, the game is single-player: skip to the single-player branch below.

## 1. What the server is the authority for

The Worker's room is authoritative. A client sends intent, and the server decides what happened. For each rule of the game, decide with the user:

- **What the server decides.** Turn order, legal moves, scoring, randomness, the end of the game, the winner. Default: all of it.
- **What a client may predict.** Movement or animation it shows before the server confirms, and how it reconciles when the server disagrees. Anything predicted is still decided on the server.
- **Randomness.** Drawn on the server from the session's seed. Its hash is shown from the start and the seed is revealed at the end, so a player can check every draw.

## 2. What the room holds

Run `pithy add --list --json` and read `multiplayer`'s entry. Then decide:

- **The game model.** A built-in game, or the app's own model. Prefer a built-in when one fits: it is maintained with the kit.
- **The room's state.** Every field, what it means, and who may see it.
- **Its players.** How many, whether a seat can be left and retaken, and whether the room closes when it empties.
- **Its phases.** From open to active to resolved or abandoned, and what moves it along. A turn timeout, if the game has turns.
- **How players meet.** By invitation, sharing the session id, or through `matchmaking`. By skill, through `rating`, if it matters who meets whom.
- **What a result feeds.** A `leaderboard`, a `rating`, a `ledger` payout. Each is a capability to add.

Do not hold in the room what a capability already stores. Users, ratings, balances and rankings belong to their capabilities. Reference them by id.

## 3. The `action` and `view` schemas

These are the game's half of the socket contract. `pithy contract` writes both into `asyncapi.json`, and every client, in every engine, is typed from them.

- **`action`.** One Zod object per thing a player may do, discriminated on a field such as `kind`, every field with `.describe()`. Sent as `{ "type": "action", "payload": … }`. Keep it to intent: "play this card", never "my score is now 40".
- **`view`.** What one player sees of the room, every field with `.describe()`. It is a redaction of the state for that player: another player's hand, an opponent's hidden position, the undrawn deck are left out, not hidden in the client.

A field added later is optional. A store build lags its Worker by months, and an old client ignores a key it does not know. A change an old client cannot ignore is a new subprotocol, not an edit.

## 4. Anti-cheat

For each, the answer the design gives:

- **A forged action.** Every action is validated against `action` and the game's rules on the server. An illegal one is an error frame, and the state does not change.
- **Hidden information.** Never sent. The `view` is the only thing a client receives.
- **Acting out of turn, or for another player.** The server knows who sent each frame from the signed-in session. A payload never names its sender.
- **Speed and replay.** Rate limits, and a turn timeout that ends a stalled game.
- **Collusion and multi-accounting.** What the game can detect from results, and what it accepts it cannot.

## 5. Write it down

Summarize the decisions in this conversation, one short section per heading above, with the `action` and `view` objects written out field by field. That summary is what the server agent builds the game model from, and what `/pithy-games:playtest` writes its moves from. A decision the user deferred is listed as open, not guessed.

If the game needs something `multiplayer` cannot do, that is a kit gap. Note it, and once the design is settled, invoke `pithy:report-kit-gap` with it.

## Single-player branch: a run the server re-simulates

A single-player game has no shared state while it is played. The client plays the whole run, and the server decides the result afterwards. Settle each part with the user, as above.

### Authority by re-simulation

The server is the authority for every result, and it gets there by re-simulation. The client records the run as an input log and submits it. The Worker replays that log through the game's deterministic engine, against content the server owns: levels, tables, item stats, drop rates. What the replay produces is the result. Decide:

- **What the run records.** The input log: one entry per tick that has input, nothing derived from it. Plus the score the client computed, which the server compares and never stores.
- **The engine.** Deterministic: a fixed tick rate, integer or fixed-point math, no wall clock, no iteration order that differs between runtimes. Randomness comes only from the run's seed. The Worker imports it as a TypeScript module. A Unity client runs its own C# engine, so the TypeScript one is its twin, and one set of recorded logs with their expected results holds the two to each other.
- **The seed.** Issued by the server when a run starts, bound to the signed-in player and to that run. A client never picks its own seed. That alone does not stop a reroll: the client holds a twin of the engine, so it can play any seed it is handed offline before it plays for real.
- **Open runs.** What stops the reroll. A player has one open run at a time, and starting another closes the open one as abandoned. An abandoned run counts as played: decide whether it is recorded as a loss, scores zero, or spends what the run cost to enter, so that starting runs until a good seed appears costs the player every run they leave. Decide also whether the start route takes a rate limit on top. A game that has nothing seeded worth rerolling says so, and still closes abandoned runs.
- **The content.** Read by the Worker from what the server owns, by the version the run started on. A level the client sends is never replayed.

### The run routes and the submission schema

Two routes, declared like every route in the app: `describeRoute`, then `requireAuth()`, then `validate("json", …)`.

- **The start route.** Returns the run's id, its seed, and the engine version and content version the run plays.
- **The submission route.** Takes one run, once. A run that is submitted is closed, whether it is accepted or refused, so a refused log is never corrected and sent again. The schema is a Zod object, every field with `.describe()`: the run's id, the engine version, the tick count, the input log, and the score the client computed. The player is the signed-in session; the body never names one.
- **The verdict.** Accepted, with the score the replay produced. Or refused, with a code under the app's own domain, declared through `defineErrorPayload`, one per reason: a bound broken, an engine version no longer accepted, a replay that does not match the client's score, a run already submitted, a run closed as abandoned.

A field added later is optional. A store build lags its Worker by months.

### Engine versioning

Every engine build carries a version, and the submission names it. The Worker keeps every engine version it still replays, and refuses the rest. A change to the rules, the tick rate, or anything the engine reads is a new version, never an edit. Decide how long an old version is accepted, because a player on last month's store build is still playing it.

### Bounds checks

Cheap checks, before the replay spends any CPU:

- **Tick count.** Between the shortest and the longest run the level allows, and no more ticks than the time since the run started could hold.
- **Engine version.** One the Worker still replays.
- **Input range.** Only inputs the game defines, analog values inside their range, ticks ascending and inside the tick count.
- **Size.** A cap on the log, so the replay fits the Worker's CPU limit.

### Anti-cheat

For each, the answer the design gives:

- **A forged score.** Never stored. The replay computes the score, and a client score that disagrees is refused, not corrected.
- **A tampered log.** It replays to a different score than the client claimed, or breaks a bound.
- **A modified client.** It still has to submit a log the server's engine accepts, under a version the server still replays.
- **A run replayed or resubmitted.** The run id is bound to one player and one seed, and takes one submission.
- **A rerolled seed.** Seeds are cheap to start and the client can simulate each one offline, so a player starts runs until one is favorable and submits only that. The open-run rule answers it: every run left behind is closed as abandoned and counted as played. Name what an abandoned run costs, and whether the start route is rate limited.
- **A bot that plays within the rules.** Re-simulation cannot see it. Decide what the game detects from inputs, such as reaction times no person has, and what it accepts it cannot.

### What a result feeds, and writing it down

A verified score feeds a `leaderboard`; a reward goes through `ledger`; recorded runs and content live in `storage`; purchases through `payments`. Each is a capability to add, and the server writes to it only after a run is accepted.

Summarize the decisions in this conversation, one short section per heading in this branch, with the start and submission schemas written out field by field and every refusal code named. That summary is what the server agent builds the engine, the routes and the verification from, and what `/pithy-games:playtest` plays its run from. A decision the user deferred is listed as open, not guessed. If the game needs something the kit cannot do, that is a kit gap: once the design is settled, invoke `pithy:report-kit-gap` with it.
