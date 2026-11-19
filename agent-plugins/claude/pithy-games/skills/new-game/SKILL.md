---
name: new-game
description: Start a new game on Pithy, multiplayer or single-player. Runs /new-app from the pithy plugin, adds the game capabilities the design calls for, and brings in a Unity client when the game ships in Unity. Use when someone wants to build a game, or a game backend, on Pithy.
argument-hint: "[web|mobile|unity|several]"
---

Start a new game on Pithy, end to end. You are the main session: you decide, the agents build. This is `/pithy:new-app` with a game's capabilities and a Unity target added.

## 1. Ask which clients play

Ask one question at a time, and skip any the user already answered.

1. **Which clients play this game?** Any of `web` (a React app the Worker serves), `mobile` (React Native from the app stores) and `unity` (a Unity build on any platform it targets). `web` and `mobile` are `pithy init --target`. `unity` adds no target: a Unity client is an API client, like a mobile app, so a Unity-only game is `--target mobile` with no mobile agent.
2. **Do players share a live room?** Yes when two or more players act in one game at the same time and see each other's moves. No for a single-player game, even one with sign-in, purchases, leaderboards and server-verified scores. The answer decides whether the game composes `multiplayer` and `matchmaking`, and which branch of `/pithy-games:game-design` runs.
3. **The project name**, and **the first Worker's name**, as `/pithy:new-app` asks them.

## 2. Settle the design before any code

Run `/pithy:app-design` if it has not run in this conversation, then `/pithy-games:game-design`, and tell it whether players share a live room. The first settles who signs in and what the app stores. The second settles what the server is the authority for, what the room holds, the game's `action` and `view` schemas, and anti-cheat. Do not scaffold a game whose authority is still undecided.

A single-player game takes `game-design`'s single-player branch instead. It settles the run the server re-simulates: the run submission route and its schema, the engine version, the bounds checks, and anti-cheat. It designs no room.

## 3. Scaffold, and bring in the base team, through `/pithy:new-app`

Invoke the `pithy:new-app` skill, and give it the answers from step 1 and the designs from step 2 so it asks nothing twice. It runs `pithy init`, installs, and dispatches the server, web and mobile clients and the runner. It does that inside the `pithy` plugin, on purpose: each plugin's settings reach only its own skills, so the user's `server_model`, `runner_model` and the rest apply there and nowhere else. Dispatching those agents from here would drop the user's choices.

Tell it two things it would not otherwise know:

- **The game capabilities**, for the server agent to add, from those the design called for:

| Capability | When |
|---|---|
| `auth` | Always. A player is a signed-in user, and a room binds membership to a user id. Device sign-in for mobile and Unity. |
| `multiplayer` | Players share a live room. The authoritative room, its socket, and the game model. |
| `matchmaking` | Players share a live room, and are paired by queue or by skill rather than by invitation. |
| `leaderboard` | Results are ranked. |
| `rating` | Skill is tracked between games, as a rating matchmaking can read. |
| `ledger` | Something is earned, spent or wagered. |
| `payments` | Players buy something with real money. |
| `storage` | The game serves files: levels, assets, recorded runs. |

  Each is added with `pithy add <capability> --worker <worker> --with-prerequisites`. The server also writes the game model with its `action` and `view` schemas, and runs `pithy contract`, which writes `openapi.json` and `asyncapi.json` side by side.

  A single-player game composes neither `multiplayer` nor `matchmaking`: only what it uses, often `auth`, `leaderboard`, `payments` and `storage`. The server writes the deterministic engine, the run start and submission routes with their schemas, and the replay verification `game-design` settled, as app code. `pithy contract` writes those routes into `openapi.json`.
- **Which clients to bring in**: only the ones the user named. A Unity-only game is `--target mobile` with no mobile agent.

## 4. Bring in the Unity client

When the game is built in Unity, dispatch it with the Agent tool once the contract exists, passing `subagent_type`, `model` and `effort` exactly as this table gives them. They are the user's choices from this plugin's settings, and they outrank the agent's own defaults.

A cell that still reads `${user_config.…}` is a setting the user never chose. Leave that parameter out of the call rather than passing the text, and the agent runs on its own default, which is the same one the setting offers. A model other than `opus`, `sonnet`, `haiku`, `fable` or `inherit`, or an effort other than `low`, `medium`, `high`, `xhigh` or `max`, is a setting typed wrong. Leave that parameter out too, and tell the user which setting to fix.

| Agent | `subagent_type` | `model` | `effort` | When |
|---|---|---|---|---|
| Unity client | `pithy-games:client-unity` | `${user_config.client_unity_model}` | `${user_config.client_unity_effort}` | The game is built in Unity. |

It builds in `unity/` at the project root, outside `apps/`, which holds Workers only.

Tell it which kind of game it is building, because the two briefs differ:

- **Players share a live room.** It generates the HTTP layer and writes the socket layer against `asyncapi.json`, and sends intent and renders what the room tells it.
- **Single-player.** There is no socket. It generates the HTTP layer, writes the C# engine as the twin of the TypeScript engine the Worker replays with, plays each run from the start route's seed, and submits the input log to the submission route. Give it `game-design`'s single-player summary: the engine's rules and version, the start and submission schemas, every refusal code, and the recorded logs with their expected results that hold the two engines to each other.

Then run `/pithy-games:playtest` once `pithy dev` is up: simulated players through a room, start to finish. For a single-player game, run its single-player mode: one run submitted to the app's routes, and a tampered one the server must refuse.

## 5. Report

What exists now, in a few lines: the project, its Workers, its capabilities, the clients, the playtest's summary, and the one command that runs it all locally (`pithy dev`). Name anything left undecided.

If anything the game needs is missing from the kit, or a capability cannot do what the design asks, invoke `pithy:report-kit-gap` with what is missing. Name each issue it filed.
