# Sockets

Two capabilities serve a WebSocket: `@pithy-sh/multiplayer`'s session socket and `@pithy-sh/matchmaking`'s presence socket. A client on either one may be an app store build that lags its Worker by months, so every frame on them is a contract, and it changes by one rule.

This is the rule, stated once. Every other doc links here rather than restating it.

## The sockets

| Socket | Path | Subprotocol | The Worker sends | The client sends |
|---|---|---|---|---|
| `multiplayerSession` | `/multiplayer/sessions/:id/socket` | `pithy.multiplayer.v1` | `state`, `error` | `action`, `state` |
| `matchmakingPresence` | `/matchmaking/presence` | `pithy.presence.v1` | `init`, `match_found`, `invite`, `friend_request`, `error`, and `pong` as plain text | `ping` as plain text |

Each path sits under its capability's `basePath`, so a project that moves the routes moves the socket with them. Both upgrades take a bearer token or a session cookie, and only a member of the session may open a session socket.

## Frames

**Every frame is JSON text, discriminated on `type`, and every frame is a Zod schema.** The session socket's live in `packages/multiplayer/src/session/frames.ts`, the presence socket's in `packages/matchmaking/src/presence/frames.ts`. Both modules are pure, so a browser or an engine's TypeScript client can import them. Every field carries a `.describe()`, as every other schema in the kit does.

**Every frame the Worker receives is parsed with that schema.** It is the same schema the contract publishes, never a copy, so the document and the socket cannot disagree about what is accepted.

**An `error` frame carries the same public error payload an HTTP error body does,** and the socket stays open after it.

**`ping` and `pong` are the one exception to JSON.** The presence keepalive is plain text each way, and the contract describes it as text.

## Versions

**A socket's version is negotiated at the upgrade.** A client offers the subprotocol it speaks in `Sec-WebSocket-Protocol`, and the Worker answers with the one it chose.

**The Worker serves two: the current version and the previous one.** It picks the current one when the client offers it, and the previous one otherwise. A client that offers only versions the Worker does not serve is refused with a `validation/invalid_input` 400 before the upgrade, naming the versions it does serve. A socket that opened anyway would speak frames the client cannot read.

**The first versioned protocol's previous version is the unversioned one.** A client that offers no subprotocol at all is every client written before versions existed, and it gets exactly what it always got:

- **On the session socket,** the state arrives as the bare session view with no `type`, which the contract calls `snapshot`. A frame that names an unknown `type`, or none, is ignored. A frame that is not JSON is still answered with an `error` frame, as it always was.
- **On the presence socket,** a frame it cannot accept is ignored, because that client was never promised an `error` frame.

On `pithy.multiplayer.v1` and `pithy.presence.v1`, the state arrives as a `state` frame, and any frame the socket cannot accept is answered with a `validation/invalid_input` `error` frame.

## How a frame changes

- **A field added to a frame is optional.** A client built before the field existed never sees it, and a client built after it must read its absence.
- **A client ignores a `type` it does not know, and a key it does not know.** That is what lets the Worker add a frame or a field without a new version.
- **A change no client could ignore is a new subprotocol:** a field removed, retyped or made required, or a frame whose meaning moved. The new version becomes the current one, the old current one becomes the previous one, and a client released before the change keeps playing.

This is the socket's form of the rule a response schema follows, for the same reason: both are read across a version boundary.

## A game's own shapes

A game model may declare an `action` schema and a `view` schema (`packages/multiplayer/src/game/model.ts`). The three built-in games declare both.

- **`action`** is one player's move: the body of `POST /multiplayer/sessions/:id/action` and the `payload` of an `action` frame. When it is declared, every action is checked against it before `apply` runs, and a malformed one is refused with `validation/invalid_input`.
- **`view`** is what `redact` returns: one player's sight of the game, in a session view's `state`. It is never parsed on the way out. `redact` is the authority on what a player may see, and the schema only tells a client how to read it.

Both are optional, so a model written before them still loads, and a client reads that game's payload and state as unknown.

## The contract

A capability that serves a socket declares it on `Capability.sockets` (`packages/core/src/http/socket.ts`): the path it mounted, how the upgrade is verified, the versions it serves, and every frame each side sends. `asyncApiDocument` (`packages/core/src/asyncapi/document.ts`) turns the declarations into AsyncAPI 3.0, the way `openApiDocument` turns the route table into OpenAPI.

`pithy contract` writes a Worker's `asyncapi.json` beside its `openapi.json` when the Worker serves a socket, with each configured game's schemas in it as `<gameKey>.action` and `<gameKey>.view`. See [`commands/contract.md`](commands/contract.md). The kit's own is [`asyncapi.generated.json`](asyncapi.generated.json), written by `bun run kit-contract`.

A TypeScript web app the Worker serves calls the HTTP routes through each capability's `src/client/api.ts`. Anything else, a mobile app or a game engine, generates its HTTP client from `openapi.json` and writes its socket layer against `asyncapi.json`.
