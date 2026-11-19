---
name: playtest
description: Playtest a Pithy game against pithy dev. For a multiplayer game, writes the moves from the game design, has the runner join N players to one room and play them through, and returns a summary of frames, errors and the outcome. For a single-player game, a bot plays one run, submits it and a tampered copy, and reports the server's verdict on each. Use after the server builds or changes a game.
argument-hint: "[game key] [players]"
---

Play a game through, start to finish, with simulated players against the local Worker. You write the moves. The runner plays them and reports.

Steps 1 to 4 are for a game whose players share a live room. A single-player game has no room: use the single-player mode below.

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

## Single-player mode: one run, and a tampered one

A bot plays one run through the game's own engine, submits it to the app's routes against `pithy dev`, and reports the server's verdict. Then it plays more runs and tampers with each before submitting it, and the server must refuse every one.

### What you need

- **`pithy dev` is up**, and the Worker's origin, as in step 1.
- **The start and submission routes**, their schemas and the refusal codes, from the single-player branch of `/pithy-games:game-design`.
- **The engine**, the TypeScript module the Worker re-simulates with.
- **One player to sign in as.** A claim from `logs/dev-login.json`, which `GET /__pithy/dev-login?t=<claim>` exchanges for a session cookie, or a bearer token.

### Write the bot

The bot always drives the engine, so every run it submits is one the engine really produced, against the seed the server issued. Where its inputs come from is the only choice: a simple policy that plays to the end, or an input log recorded from a real play of the client, fed to the engine tick by tick. A recorded log replays only against the seed it was recorded on, so use it when the design lets a dev run start on a fixed seed.

Write one script to a file in your scratchpad directory. It signs in, calls the start route, plays the run through the engine to the end, and builds the submission exactly as the client would. It submits that genuine run.

A run takes one submission, so each tampered submission is its own run. For each one, the script calls the start route again, plays the new run through the engine on that run's seed, tampers with the one thing the case names, and submits it once:

- **A forged score.** The client's score set higher than the engine computed.
- **One case for each bound the design names.** An input out of range, a tick count past the longest run, an engine version the Worker no longer replays.

The engine plays a run far faster than real time, and the server refuses a run with more ticks than the time since it started could hold. So before every submission the script waits until the tick count it submits, divided by the tick rate, has passed since the start route answered for that run. It waits on the tick count it sends, tampered or not, so the tick count past the longest run waits long enough to reach the longest-run check. The playtest uses no dev-only allowance: the server it tests is the one that ships. The bot plays as one player, and a player has one open run at a time, so it takes the runs one after another: start a run, play it, wait it out, submit it, read the verdict, and only then start the next. The playtest takes as long as its runs added together.

Then the only case that reuses a run: the genuine run submitted again, which the server must refuse as already submitted. If the design closes an open run when another starts, the script also starts a run, starts another without submitting the first, and then submits the first, which the server must refuse as abandoned.

It prints one line per submission: the run id, what was tampered, the HTTP status, and the verdict or the refusal's code.

### Run it

Dispatch `pithy:runner` with the Agent tool, with no `model` or `effort`, as in step 3. Ask it to run the script from the project root with `node <file>` and return what it prints. Node 22.18 or later runs TypeScript as it is.

### Read the verdicts

- Was the genuine run accepted, with the score the engine computed?
- Was every tampered run refused, each with the code the design names for its own case, and none accepted? A tampered run refused as already submitted means the bot reused a run, and the check it meant to reach never ran.
- Did anything the result feeds, such as a leaderboard entry, appear for the genuine run and only for it?

Report it in a few lines. A failure is the server's to fix: hand the output to `pithy:server`. If the failure is the kit's, not the game's, invoke `pithy:report-kit-gap` with the output as the repro.
