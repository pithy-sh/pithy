---
name: playtest
description: Playtest a Pithy game with simulated players. Writes the moves from the game design, has the runner join N players to one room against pithy dev and play them through, and returns a summary of frames, errors and the outcome. Use after the server builds or changes a game.
argument-hint: "[game key] [players]"
---

Play a game through, start to finish, with simulated players against the local Worker. You write the moves. The runner plays them and reports.

## 1. What you need

- **`pithy dev` is up.** If not, dispatch `pithy:runner` to start it, and read the port the Worker answers on. That port's origin, such as `http://localhost:8787`, is `--origin`.
- **The game's key**, as the Worker's `multiplayer` config names it, and **how many players**.
- **Players to sign in as.** The script signs each one in through the dev login, which `pithy seed --env dev` writes to `logs/dev-login.json`, one entry per seeded user. Seeding the example cast gives several. If the file has fewer users than players, or no dev login can be used, pass one bearer token per player with `--token` instead.

## 2. Write the moves

From the `action` schema `/pithy-games:game-design` settled, write a JSON array to a file in your scratchpad directory, one entry per move in the order they are played:

```json
[
  { "player": 0, "payload": { "kind": "place", "cell": 4 } },
  { "player": 1, "payload": { "kind": "place", "cell": 0 } }
]
```

`player` is an index: 0 creates the room, and 1 onward join it in order. `payload` is exactly what the client sends as the action. Write a full game that reaches a result, and add one move the rules must refuse, so the playtest proves the server refuses it.

## 3. Run it

Dispatch `pithy:runner` with the Agent tool, with no `model` or `effort`: the runner's settings belong to the `pithy` plugin and reach only its skills, so here it runs on its own default, Haiku at low effort, which is what a script run needs. Ask it to run this from the project root and return the script's summary:

```text
node ${CLAUDE_PLUGIN_ROOT}/scripts/playtest.ts --origin <origin> --game <key> --players <n> --moves <file>
```

It needs Node 22.18 or later, which runs TypeScript as it is, and nothing else: no Bun, no install. With tokens instead of the dev login, add `--token <bearer>` once per player, in player order.

The script signs each player in, creates the room with `POST /multiplayer/games/<key>`, joins the rest with `POST /multiplayer/sessions/<id>/join`, opens every player's socket with `Sec-WebSocket-Protocol: pithy.multiplayer.v1`, and sends each move as `{ "type": "action", "payload": … }`. A move owns every frame any socket receives after it is sent, until all sockets have been quiet for 150 ms (`--settle`), and the next move waits for that, so a late broadcast is never read as the next move's reply. It prints one line per move: which players got a state, or the move's refusal and its code when the mover got an `error`. Then the final phase and outcome.

## 4. Read the summary

Compare it with the design:

- Did the game reach the phase and outcome the moves should produce?
- Was the move the rules must refuse refused, with the code you expected, and nothing else?
- Did every player receive a state after every move that was not refused?

Report it in a few lines. A failure is the server's to fix: hand the summary to `pithy:server`. If the failure is the kit's, not the game's, invoke `pithy:report-kit-gap` with the script's summary as the repro.
