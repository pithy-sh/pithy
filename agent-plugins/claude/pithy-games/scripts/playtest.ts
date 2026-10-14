// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * `/playtest`'s driver: N simulated players through one multiplayer room, against `pithy dev`.
 *
 *   node playtest.ts --origin http://localhost:8787 --game <key> --players 2 --moves moves.json
 *   node playtest.ts … --token <bearer> --token <bearer>
 *
 * Runs on Node 22.18 or later, which strips the types itself. Dependency-free on purpose: it ships inside
 * the plugin, which has no `node_modules`, so it imports only `node:*` and uses Node's own `fetch` and
 * `WebSocket`. Node's `WebSocket` is undici's, which takes `{ protocols, headers }` where a browser's
 * takes only protocols; that is how the bearer token or session cookie reaches the upgrade.
 *
 * **How a player signs in.** By default through the dev login: `pithy seed --env dev` writes one signed
 * claim per seeded user to `logs/dev-login.json`, and a `dev` composition outside CI serves
 * `GET /__pithy/dev-login?t=<claim>`, which mints a real session for that user and answers with its
 * cookie. N claims are N distinct players, with no prompt. Where that route is not served (CI, or not
 * `dev`) or there are fewer seeded users than players, pass `--token` once per player instead.
 *
 * **Which move a frame belongs to.** A move's frames are every frame any socket receives from the moment
 * it is sent until every socket has been quiet for the settle window (`--settle`, 150 ms), after at least
 * one frame has arrived, or until `--timeout` passes with none. Only then is the next move sent, so a
 * late broadcast from one move is never read as the next move's reply. An `error` frame on the mover's
 * socket is that move's refusal.
 */

import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const SUBPROTOCOL = "pithy.multiplayer.v1";
const DEV_LOGIN_ROUTE = "/__pithy/dev-login";

interface Options {
  origin: string;
  game: string;
  players: number;
  moves: string;
  tokens: string[];
  devLogin: string;
  timeoutMs: number;
  settleMs: number;
  json: boolean;
}

interface Move {
  player: number;
  payload: unknown;
}

interface Frame {
  kind: "state" | "error" | "unknown";
  body: Record<string, unknown>;
}

interface Player {
  index: number;
  headers: Record<string, string>;
  socket?: WebSocket;
}

/** A refusal the script prints as one line and exits 1 on. */
class Refusal extends Error {}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string[]>();
  let json = false;
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at] as string;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (!flag.startsWith("--")) throw new Refusal(`Unexpected argument: ${flag}.`);
    const value = argv[at + 1];
    if (value === undefined) throw new Refusal(`${flag} needs a value.`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
    at += 1;
  }
  const one = (flag: string, fallback?: string): string => {
    const value = values.get(flag)?.at(-1) ?? fallback;
    if (value === undefined) throw new Refusal(`${flag} is required.`);
    return value;
  };
  const millis = (flag: string, fallback: string): number => {
    const value = Number(one(flag, fallback));
    if (!Number.isFinite(value) || value <= 0) throw new Refusal(`${flag} must be milliseconds, above 0.`);
    return value;
  };
  const players = Number(one("--players", "2"));
  if (!Number.isInteger(players) || players < 1) throw new Refusal("--players must be a whole number, 1 or more.");
  return {
    origin: one("--origin").replace(/\/+$/, ""),
    game: one("--game"),
    players,
    moves: one("--moves"),
    tokens: values.get("--token") ?? [],
    devLogin: one("--dev-login", "logs/dev-login.json"),
    timeoutMs: millis("--timeout", "5000"),
    settleMs: millis("--settle", "150"),
    json,
  };
}

/** A JSON file's value, or a refusal naming what is missing or unreadable. */
async function readJson(path: string, missing: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Refusal(missing);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readMoves(path: string, players: number): Promise<Move[]> {
  const parsed = await readJson(path, `No moves file at ${path}.`);
  if (!Array.isArray(parsed)) throw new Refusal(`${path} must be a JSON array of { player, payload }.`);
  return parsed.map((entry: unknown, at) => {
    const move = entry as Partial<Move> | null;
    if (
      typeof move?.player !== "number" ||
      !Number.isInteger(move.player) ||
      move.player < 0 ||
      move.player >= players
    ) {
      throw new Refusal(`Move ${at}: player must be an index from 0 to ${players - 1}.`);
    }
    return { player: move.player, payload: move.payload };
  });
}

/** Each player's credential: a bearer token given, or a session cookie the dev login mints. */
async function signIn(options: Options): Promise<Record<string, string>[]> {
  if (options.tokens.length > 0) {
    if (options.tokens.length !== options.players) {
      throw new Refusal(`Got ${options.tokens.length} --token for ${options.players} players. Pass one per player.`);
    }
    return options.tokens.map((token) => ({ Authorization: `Bearer ${token}` }));
  }

  const logins = (await readJson(
    options.devLogin,
    `No dev login at ${options.devLogin}. Run pithy seed --env dev, or pass --token per player.`,
  )) as Record<string, { claim?: string; expiresAt?: string }> | undefined;
  const now = Date.now();
  const claims = Object.values(logins ?? {})
    .filter((login) => typeof login?.claim === "string" && Date.parse(login.expiresAt ?? "") > now)
    .map((login) => login.claim as string);
  if (claims.length < options.players) {
    throw new Refusal(
      `${options.devLogin} has ${claims.length} usable logins for ${options.players} players. Seed more users, or pass --token per player.`,
    );
  }

  const headers: Record<string, string>[] = [];
  for (const claim of claims.slice(0, options.players)) {
    // The claim is written URI-encoded, and goes into the URL as it is.
    const response = await fetch(`${options.origin}${DEV_LOGIN_ROUTE}?t=${claim}`, { redirect: "manual" });
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (response.status !== 302 || !cookie) {
      throw new Refusal(
        `The dev login answered ${response.status}. It is served only by a dev composition outside CI. Pass --token per player instead.`,
      );
    }
    // A cookie session is held to the Worker's trusted origins, and the Worker's own is one.
    headers.push({ Cookie: cookie, Origin: options.origin });
  }
  return headers;
}

async function post(options: Options, player: Player, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${options.origin}${path}`, { method: "POST", headers: player.headers });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error as { code?: string; message?: string } | undefined;
    throw new Refusal(
      `POST ${path} as player ${player.index} answered ${response.status}: ${error?.code ?? "no code"} ${error?.message ?? ""}`.trim(),
    );
  }
  return body;
}

/**
 * One frame, classified on `type`. A snapshot with no `type` is a state, as Workers before `type: "state"`
 * sent it. A `type` this script does not know is kept and counted, never an error: a client ignores it.
 */
function classify(data: unknown): Frame {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { kind: "unknown", body: { text } };
  }
  if (body.type === "error") return { kind: "error", body };
  if (body.type === "state" || (body.type === undefined && "phase" in body)) return { kind: "state", body };
  return { kind: "unknown", body };
}

/** Every frame every socket has received, in arrival order, with the time the last one landed. */
class Inbox {
  frames: { player: number; frame: Frame }[] = [];
  lastAt = 0;

  take(player: number, data: unknown): void {
    this.frames.push({ player, frame: classify(data) });
    this.lastAt = Date.now();
  }

  /**
   * Waits until at least one frame has arrived since `from` and then every socket has been quiet for
   * `settleMs`, or until `timeoutMs` passes. Returns the frames since `from`.
   */
  async settle(from: number, options: Options): Promise<{ player: number; frame: Frame }[]> {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      const now = Date.now();
      if (now >= deadline) break;
      const quietFor = now - this.lastAt;
      if (this.frames.length > from && quietFor >= options.settleMs) break;
      const wait = this.frames.length > from ? options.settleMs - quietFor : Math.min(options.settleMs, 25);
      await sleep(Math.max(1, Math.min(wait, deadline - now)));
    }
    return this.frames.slice(from);
  }
}

function open(options: Options, player: Player, sessionId: string, inbox: Inbox): Promise<void> {
  const url = `${options.origin.replace(/^http/, "ws")}/multiplayer/sessions/${sessionId}/socket`;
  // Node's WebSocket (undici) takes headers beside protocols. The subprotocol is negotiated at upgrade.
  const init = { protocols: [SUBPROTOCOL], headers: player.headers };
  const socket = new WebSocket(url, init as unknown as string[]);
  socket.binaryType = "arraybuffer";
  player.socket = socket;
  socket.addEventListener("message", (event) => inbox.take(player.index, event.data));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Refusal(`Player ${player.index}'s socket did not open.`)),
      options.timeoutMs,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      if (socket.protocol !== SUBPROTOCOL) {
        reject(new Refusal(`Player ${player.index}'s socket opened without ${SUBPROTOCOL}.`));
        return;
      }
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(
        new Refusal(
          `Player ${player.index}'s socket was refused. Is it a member, and does the Worker speak ${SUBPROTOCOL}?`,
        ),
      );
    });
  });
}

interface ErrorSeen {
  player: number;
  code: string;
  message: string;
}

/** What one move drew: the sockets that got a state, every error and on which socket, and any unknown frames. */
interface MoveResult {
  move: number;
  player: number;
  /** The mover's own socket got an `error`: the server refused this move. */
  refused: ErrorSeen | null;
  states: number[];
  errors: ErrorSeen[];
  unknown: number;
}

interface Summary {
  sessionId: string;
  /** What the sockets got on connect, before any move. */
  connect: Omit<MoveResult, "move" | "player" | "refused">;
  moves: MoveResult[];
  phase: string | null;
  outcome: unknown;
}

function errorOf(player: number, frame: Frame): ErrorSeen {
  const error = frame.body.error as { code?: string; message?: string } | undefined;
  return { player, code: error?.code ?? "unknown", message: error?.message ?? "" };
}

function tally(frames: { player: number; frame: Frame }[]): Omit<MoveResult, "move" | "player" | "refused"> {
  const states = new Set<number>();
  const errors: ErrorSeen[] = [];
  let unknown = 0;
  for (const { player, frame } of frames) {
    if (frame.kind === "state") states.add(player);
    else if (frame.kind === "error") errors.push(errorOf(player, frame));
    else unknown += 1;
  }
  return { states: [...states].sort((a, b) => a - b), errors, unknown };
}

async function playtest(options: Options): Promise<Summary> {
  const moves = await readMoves(options.moves, options.players);
  const credentials = await signIn(options);
  const players: Player[] = credentials.map((headers, index) => ({ index, headers }));
  const [host, ...guests] = players as [Player, ...Player[]];

  const created = await post(options, host, `/multiplayer/games/${encodeURIComponent(options.game)}`);
  const sessionId = String(created.sessionId);
  for (const guest of guests) await post(options, guest, `/multiplayer/sessions/${sessionId}/join`);

  // Each socket sends the caller's view on connect: let all of it land before the first move.
  const inbox = new Inbox();
  for (const player of players) await open(options, player, sessionId, inbox);
  const connect = tally(await inbox.settle(0, options));

  const results: MoveResult[] = [];
  for (const [at, move] of moves.entries()) {
    const from = inbox.frames.length;
    players[move.player]?.socket?.send(JSON.stringify({ type: "action", payload: move.payload }));
    const seen = tally(await inbox.settle(from, options));
    const refused = seen.errors.find((error) => error.player === move.player) ?? null;
    results.push({ move: at, player: move.player, refused, ...seen });
  }

  for (const player of players) player.socket?.close(1000, "playtest done");

  const finalState = inbox.frames.filter(({ frame }) => frame.kind === "state").at(-1)?.frame.body;
  return {
    sessionId,
    connect,
    moves: results,
    phase: typeof finalState?.phase === "string" ? finalState.phase : null,
    outcome: finalState?.outcome ?? null,
  };
}

function render(summary: Summary, players: number): string {
  const list = (indexes: number[]) => (indexes.length === players ? "all" : indexes.join(", ") || "none");
  const describe = (seen: Omit<MoveResult, "move" | "player" | "refused">): string => {
    const parts = [`state to ${list(seen.states)}`];
    for (const error of seen.errors) parts.push(`error ${error.code} to ${error.player}`);
    if (seen.unknown > 0) parts.push(`${seen.unknown} unknown`);
    return parts.join("; ");
  };
  const lines = [`Session ${summary.sessionId}.`, `Connect: ${describe(summary.connect)}.`];
  for (const move of summary.moves) {
    const head = `Move ${move.move}, player ${move.player}`;
    const silent = move.states.length === 0 && move.errors.length === 0 && move.unknown === 0;
    if (silent) lines.push(`${head}: no frame on any socket.`);
    else if (move.refused) {
      lines.push(`${head}: refused, ${move.refused.code}. ${move.refused.message}`.trim());
      const others = { ...move, errors: move.errors.filter((error) => error !== move.refused) };
      if (others.states.length > 0 || others.errors.length > 0 || others.unknown > 0) {
        lines.push(`  also: ${describe(others)}.`);
      }
    } else lines.push(`${head}: ${describe(move)}.`);
  }
  lines.push(`Phase: ${summary.phase ?? "unknown"}.`);
  lines.push(`Outcome: ${summary.outcome === null ? "none" : JSON.stringify(summary.outcome)}.`);
  return lines.join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const summary = await playtest(options);
  console.log(options.json ? JSON.stringify(summary) : render(summary, options.players));
} catch (error) {
  console.error(error instanceof Refusal ? error.message : `Playtest failed: ${String(error)}`);
  process.exit(1);
}
