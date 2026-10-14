---
name: game-design
description: Settle a multiplayer game's authority, room state, action and view schemas, and anti-cheat before any code is written. Run in the main session. Use at the start of a new game on Pithy, or before a change to what a room holds or what a player may send.
---

Settle what is expensive to get wrong in a game, before anyone writes code. You are the main session. Ask, decide with the user, and write the result down in this conversation. Do not delegate this.

Ask one question at a time. Recommend an answer with each, and say why in one sentence.

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
