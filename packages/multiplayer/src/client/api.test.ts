// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SessionResult, SessionView } from "../http/responses";
import {
  act,
  closeSession,
  createSession,
  joinSession,
  leaveSession,
  MULTIPLAYER_BASE_PATH,
  MULTIPLAYER_CROSS_ORIGIN,
  MULTIPLAYER_UNREACHABLE,
  MULTIPLAYER_UNREADABLE,
  type MultiplayerFetch,
  type MultiplayerRequestInit,
  type MultiplayerResponse,
  readResult,
  readSession,
} from "./api";

/** A fetch that answers once, and records what it was asked. */
function answering(body: unknown, ok = true, status = ok ? 200 : 400) {
  const calls: { url: string; init?: MultiplayerRequestInit }[] = [];
  const send: MultiplayerFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body } satisfies MultiplayerResponse;
  };
  return { send, calls };
}

/** A session view, as the server's own schema says it is shaped. */
const VIEW = SessionView.parse({
  sessionId: "0123456789abcdef",
  gameKey: "tic-tac-toe",
  kind: "connect-n",
  phase: "resolved",
  players: ["alice", "bob"],
  outcome: { status: "resolved", scores: { alice: 1, bob: 0 }, winnerUserId: "alice", draw: false, resolvedAt: 1 },
  state: { turn: "bob", yourTurn: false, game: { board: [["alice"]], moves: 1 } },
  fairness: { seedHash: "hash", seed: "seed" },
});

const OPEN = SessionView.parse({
  ...VIEW,
  phase: "open",
  outcome: null,
  state: null,
  fairness: { seedHash: "h", seed: null },
});

const RESULT = SessionResult.parse({
  id: 1,
  sessionId: "0123456789abcdef",
  gameKey: "tic-tac-toe",
  status: "resolved",
  players: ["alice", "bob"],
  scores: { alice: 1, bob: 0 },
  winnerUserId: "alice",
  draw: false,
  createdAt: "2026-10-01T12:00:00.000Z",
  resolvedAt: "2026-10-01T12:05:00.000Z",
});

describe("the client reads what the server actually answers", () => {
  /*
    Every fixture is parsed through the server's own response schemas, so a field renamed on the wire fails
    here rather than in a player's app. The *module* stays free of the Worker's schema graph because it
    compiles into a bundle; the *test* has no such constraint, and is the place the two halves meet.
  */

  test("every session route calls its path, with its method, and narrows a view", async () => {
    const cases: [string, (send: MultiplayerFetch) => Promise<unknown>, string, string][] = [
      ["create", (send) => createSession("tic-tac-toe", { fetch: send }), "POST", "/games/tic-tac-toe"],
      ["join", (send) => joinSession("abc", { fetch: send }), "POST", "/sessions/abc/join"],
      ["act", (send) => act("abc", { row: 0, col: 0 }, { fetch: send }), "POST", "/sessions/abc/action"],
      ["leave", (send) => leaveSession("abc", { fetch: send }), "POST", "/sessions/abc/leave"],
      ["close", (send) => closeSession("abc", { fetch: send }), "POST", "/sessions/abc/close"],
      ["read", (send) => readSession("abc", { fetch: send }), "GET", "/sessions/abc"],
    ];
    for (const [name, call, method, path] of cases) {
      for (const view of [VIEW, OPEN]) {
        const { send, calls } = answering(view);
        expect(await call(send), name).toEqual({ ok: true, value: view });
        expect(calls[0]?.url, name).toBe(`${MULTIPLAYER_BASE_PATH}${path}`);
        expect(calls[0]?.init?.method, name).toBe(method);
        // The whole cookie story, asserted rather than assumed.
        expect(calls[0]?.init?.credentials, name).toBe("include");
      }
    }
  });

  test("an action is sent as its JSON body; no action sends no body", async () => {
    const { send, calls } = answering(VIEW);
    await act("abc", { offense: ["fire"] }, { fetch: send });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ offense: ["fire"] }));
    expect(calls[0]?.init?.headers?.["content-type"]).toBe("application/json");
    await act("abc", undefined, { fetch: send });
    expect(calls[1]?.init?.body).toBeUndefined();
  });

  test("the result is narrowed to the durable record", async () => {
    const { send, calls } = answering(RESULT);
    expect(await readResult("abc", { fetch: send })).toEqual({ ok: true, value: RESULT });
    expect(calls[0]?.url).toBe(`${MULTIPLAYER_BASE_PATH}/sessions/abc/result`);
    const abandoned = SessionResult.parse({ ...RESULT, status: "abandoned", scores: null, winnerUserId: null });
    expect(await readResult("abc", { fetch: answering(abandoned).send })).toEqual({ ok: true, value: abandoned });
  });

  test("a bearer client's headers ride every request; a cookie client sends none", async () => {
    const { send, calls } = answering(VIEW);
    await act("abc", { row: 1 }, { fetch: send, headers: { authorization: "Bearer t" } });
    expect(calls[0]?.init?.headers).toEqual({ authorization: "Bearer t", "content-type": "application/json" });
    await readSession("abc", { fetch: send });
    expect(calls[1]?.init?.headers).toEqual({});
  });

  test("an id and a game key stay one path segment", async () => {
    const { send, calls } = answering(VIEW);
    await readSession("a/../b", { fetch: send });
    expect(calls[0]?.url).toBe(`${MULTIPLAYER_BASE_PATH}/sessions/a%2F..%2Fb`);
  });

  test("a custom base path is honored", async () => {
    const { send, calls } = answering(VIEW);
    await readSession("abc", { fetch: send, basePath: "/play" });
    expect(calls[0]?.url).toBe("/play/sessions/abc");
  });
});

describe("nothing throws, and every failure is renderable", () => {
  test("a refusal arrives as the server's own code and message", async () => {
    const { send } = answering(
      { error: { code: "multiplayer/not_a_member", status: 403, message: "You are not a member of this session." } },
      false,
      403,
    );
    const result = await act("abc", { row: 0 }, { fetch: send });
    expect(result).toEqual({
      ok: false,
      failure: { code: "multiplayer/not_a_member", message: "You are not a member of this session.", action: null },
    });
  });

  test("an unreachable worker is a failure, not a rejection", async () => {
    const send: MultiplayerFetch = async () => {
      throw new Error("offline");
    };
    await expect(readSession("abc", { fetch: send })).resolves.toEqual({ ok: false, failure: MULTIPLAYER_UNREACHABLE });
  });

  test("a lone surrogate in an id or a game key is replaced, not a thrown URIError", async () => {
    const { send, calls } = answering(VIEW);
    await expect(readSession("a\uD800b", { fetch: send })).resolves.toEqual({ ok: true, value: VIEW });
    await expect(joinSession("\uDC00", { fetch: send })).resolves.toEqual({ ok: true, value: VIEW });
    await expect(createSession("g\uD83D", { fetch: send })).resolves.toEqual({ ok: true, value: VIEW });
    expect(calls.map((call) => call.url)).toEqual([
      `${MULTIPLAYER_BASE_PATH}/sessions/a%EF%BF%BDb`,
      `${MULTIPLAYER_BASE_PATH}/sessions/%EF%BF%BD/join`,
      `${MULTIPLAYER_BASE_PATH}/games/g%EF%BF%BD`,
    ]);
  });

  test("a whole surrogate pair is kept, encoded as itself", async () => {
    const { send, calls } = answering(VIEW);
    await readSession("🎲", { fetch: send });
    expect(calls[0]?.url).toBe(`${MULTIPLAYER_BASE_PATH}/sessions/%F0%9F%8E%B2`);
  });

  test("a program with no fetch at all is the same failure", async () => {
    await expect(readSession("abc", { global: {} })).resolves.toEqual({ ok: false, failure: MULTIPLAYER_UNREACHABLE });
  });

  test("a proxy's HTML page is unreadable rather than a crash", async () => {
    const send: MultiplayerFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(readSession("abc", { fetch: send })).resolves.toEqual({ ok: false, failure: MULTIPLAYER_UNREADABLE });
  });

  test("an error status with no readable body names its status", async () => {
    const send: MultiplayerFetch = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    const result = await readSession("abc", { fetch: send });
    expect(!result.ok && result.failure.code).toBe("client/http_502");
  });

  test("an answer of the wrong shape is unreadable rather than handed on", async () => {
    const { phase: _phase, ...noPhase } = VIEW;
    await expect(readSession("abc", { fetch: answering(noPhase).send })).resolves.toEqual({
      ok: false,
      failure: MULTIPLAYER_UNREADABLE,
    });
    await expect(readResult("abc", { fetch: answering(VIEW).send })).resolves.toEqual({
      ok: false,
      failure: MULTIPLAYER_UNREADABLE,
    });
    await expect(readSession("abc", { fetch: answering(RESULT).send })).resolves.toEqual({
      ok: false,
      failure: MULTIPLAYER_UNREADABLE,
    });
  });
});

describe("the request never leaves this origin", () => {
  test.each([
    ["//evil.example.com", "a protocol-relative authority"],
    ["/\\evil.example.com", "the backslash form a URL parser reads as one"],
    ["https://evil.example.com/multiplayer", "an absolute URL"],
    ["multiplayer", "an unrooted path"],
  ])("%s is refused before anything is sent — %s", async (basePath) => {
    const { send, calls } = answering(VIEW);
    const result = await readSession("abc", { basePath, fetch: send });
    expect(result).toEqual({ ok: false, failure: MULTIPLAYER_CROSS_ORIGIN });
    // Never sent, rather than sent and ignored. The session is ambient; the request is the disclosure.
    expect(calls).toEqual([]);
  });
});

describe("the module compiles into a client bundle", () => {
  test("and imports nothing, so the Worker's schema graph does not come with it", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "api.ts"), "utf8");
    const imports = source.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toEqual([]);
  });
});
