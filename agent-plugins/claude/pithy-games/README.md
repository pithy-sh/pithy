# pithy-games

A game add-on to the [`pithy`](../pithy/README.md) agent team, for Claude Code. Game design, a Unity client, and playtests with simulated players. It builds on Pithy's game capabilities — `auth`, `multiplayer`, `matchmaking`, `leaderboard`, `rating`, `ledger` — and on the socket contract every engine plays against.

## Install

```text
/plugin marketplace add pithy-sh/pithy#release
/plugin install pithy-games@pithy
```

`pithy-games` depends on `pithy`, so installing it installs `pithy` with it. Both carry the `pithy` CLI's version, so they always match.

`#release` is deliberate, for the reason the `pithy` README gives: the `release` branch moves only when the kit is published to npm.

**Install from one source.** `pithy-games@pithy` brings `pithy@pithy`. If `pithy@synced`, from Anthropic's plugin directory, is installed as well, every `pithy` agent and skill appears twice. Not both: remove one.

## The team

It reuses `pithy`'s team — `pithy:server`, `pithy:client-web`, `pithy:client-mobile`, `pithy:runner` — and adds one agent. A web game is `pithy:client-web` as it is. A React Native game is `pithy:client-mobile`.

| Agent | Default | Job |
|---|---|---|
| `client-unity` | Sonnet, medium | The Unity client in C#. Generates the HTTP layer from `openapi.json`, writes the socket layer against `asyncapi.json`, and knows IL2CPP stripping and WebGL. Compiling is the adopter's, in their own Unity project. |

### Settings

`client-unity`'s model and effort are settings: `client_unity_model` and `client_unity_effort`, with the defaults above. Change them with `/plugin`, or from a shell:

```bash
echo '{"client_unity_model": "opus", "client_unity_effort": "high"}' | claude plugin configure pithy-games@pithy --values-stdin
```

`/new-game` passes these on every Unity dispatch. A plugin's settings reach only its own skills, so the base team's — `server_model`, `runner_model` and the rest — stay `pithy`'s, set on `pithy@pithy`, and `/new-game` brings that team in through `pithy`'s own `/new-app` so they apply. `/playtest` dispatches the runner on its own default, Haiku at low effort.

## The skills

- `/new-game`: `/new-app` from `pithy`, plus the game capabilities the design calls for and a Unity target.
- `/game-design`: settles what the server is the authority for, what the room holds, the game's `action` and `view` schemas, and anti-cheat, before any code. It runs in the main session.
- `/playtest`: has `pithy:runner` sign in simulated players against `pithy dev`, join them to one room, play the moves the design implies, and return a summary: per move, which players got a state or the refusal's code, then the final phase and outcome. The script runs on Node 22.18 or later.

A gap in the kit is filed with `pithy`'s `/report-kit-gap`.

## The Unity client

The HTTP layer is generated from the Worker's `openapi.json` with `openapi-generator`'s `csharp` generator and its `unityWebRequest` library, which works on IL2CPP and WebGL where `HttpClient` does not. The library is marked experimental, so the generator is pinned:

```text
openapitools/openapi-generator-cli:v7.26.0
```

From the project root, where `<unity project>` is the Unity project's folder:

```text
docker run --rm -v "$PWD:/local" -w /local openapitools/openapi-generator-cli:v7.26.0 generate -i apps/<worker>/openapi.json -g csharp --library unityWebRequest --additional-properties=packageName=Pithy.Client -o <unity project>/Assets/Pithy/Client
```

Pithy ships no C# code. The generated client compiles in your Unity project, against Unity's own assemblies.

## The socket contract

The room and presence sockets are described in the Worker's `asyncapi.json`, which `pithy contract` writes beside `openapi.json`, with the game's own `action` and `view` schemas in it. A room socket opens with `Sec-WebSocket-Protocol: pithy.multiplayer.v1`, and a presence socket with `pithy.presence.v1`. Every frame is JSON discriminated on `type`. How a frame may change between releases, and what a client must ignore, is stated once in [`docs/SOCKETS.md`](../../../docs/SOCKETS.md).
