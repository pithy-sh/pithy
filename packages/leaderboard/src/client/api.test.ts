// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  BoardList,
  BoardPage,
  HideResult,
  OwnRank,
  RemoveResult,
  SubmitResult,
  VisibilityResult,
} from "../http/responses";
import { BOOKMARK_HEADER } from "../session/bookmark";
import {
  hideEntry,
  LEADERBOARD_BASE_PATH,
  LEADERBOARD_BOOKMARK_HEADER,
  LEADERBOARD_CROSS_ORIGIN,
  LEADERBOARD_UNREACHABLE,
  LEADERBOARD_UNREADABLE,
  type LeaderboardFetch,
  type LeaderboardRequestInit,
  type LeaderboardResponse,
  type LeaderboardSession,
  listBoards,
  readAround,
  readOwnRank,
  readSegment,
  readTop,
  removeEntry,
  setVisibility,
  submitScore,
} from "./api";

/** A fetch that answers every call with `body`, and records what it was asked. */
function answering(body: unknown, status = 200, bookmark: string | null = null) {
  const calls: { url: string; init?: LeaderboardRequestInit }[] = [];
  const send: LeaderboardFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name === LEADERBOARD_BOOKMARK_HEADER ? bookmark : null) },
      json: async () => body,
    } satisfies LeaderboardResponse;
  };
  return { send, calls };
}

// Every fixture is parsed through the server's own response schema, so a field renamed on the wire fails
// here rather than in a player's client. The module under test imports nothing; this test is the one place
// the two halves are held together.
const BOARDS = BoardList.parse({
  boards: [
    {
      key: "b1",
      store: "d1",
      direction: "desc",
      aggregation: "best",
      window: null,
      tiers: [{ key: "gold", from: 100 }],
    },
  ],
});
const PAGE = BoardPage.parse({
  board: "b1",
  window: "all",
  entries: [{ userId: "u1", score: 10, achievedAt: "2026-07-25T10:00:00.000Z", rank: 1, tier: null }],
});
const ME = OwnRank.parse({
  board: "b1",
  window: "all",
  userId: "u1",
  score: 10,
  rank: null,
  tier: null,
  visible: true,
  rankStale: false,
});
const SUBMITTED = SubmitResult.parse({ window: "all" });
const VISIBLE = VisibilityResult.parse({ visible: false });
const HIDDEN = HideResult.parse({ hidden: true });
const REMOVED = RemoveResult.parse({ removed: true });

describe("every route, with what it sends and what it reads back", () => {
  test("listBoards", async () => {
    const { send, calls } = answering(BOARDS);
    expect(await listBoards({ fetch: send })).toEqual({ ok: true, value: BOARDS.boards });
    expect(calls[0]?.url).toBe(LEADERBOARD_BASE_PATH);
    expect(calls[0]?.init?.credentials).toBe("include");
  });

  test("submitScore posts the score and answers its window", async () => {
    const { send, calls } = answering(SUBMITTED, 201);
    expect(await submitScore("b1", 42, { fetch: send })).toEqual({ ok: true, value: "all" });
    expect(calls[0]?.url).toBe(`${LEADERBOARD_BASE_PATH}/b1`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ score: 42 }));
    expect(calls[0]?.init?.headers?.["content-type"]).toBe("application/json");
  });

  test("readTop sends only the query values that are set", async () => {
    const { send, calls } = answering(PAGE);
    expect(await readTop("b1", {}, { fetch: send })).toEqual({ ok: true, value: PAGE });
    expect(await readTop("b1", { limit: 5, offset: 10, window: "2026-07-20" }, { fetch: send })).toEqual({
      ok: true,
      value: PAGE,
    });
    expect(calls.map((call) => call.url)).toEqual([
      `${LEADERBOARD_BASE_PATH}/b1/top`,
      `${LEADERBOARD_BASE_PATH}/b1/top?window=2026-07-20&limit=5&offset=10`,
    ]);
  });

  test("readSegment posts the players to rank among", async () => {
    const { send, calls } = answering(PAGE);
    expect(await readSegment("b1", { userIds: ["u1", "u2"], limit: 5 }, { fetch: send })).toEqual({
      ok: true,
      value: PAGE,
    });
    expect(calls[0]?.url).toBe(`${LEADERBOARD_BASE_PATH}/b1/segment`);
    expect(JSON.parse(calls[0]?.init?.body ?? "")).toEqual({ userIds: ["u1", "u2"], limit: 5 });
  });

  test("readOwnRank and readAround", async () => {
    const me = answering(ME);
    expect(await readOwnRank("b1", { window: "w" }, { fetch: me.send })).toEqual({ ok: true, value: ME });
    expect(me.calls[0]?.url).toBe(`${LEADERBOARD_BASE_PATH}/b1/me?window=w`);
    const around = answering(PAGE);
    expect(await readAround("b1", { radius: 3 }, { fetch: around.send })).toEqual({ ok: true, value: PAGE });
    expect(around.calls[0]?.url).toBe(`${LEADERBOARD_BASE_PATH}/b1/around?radius=3`);
  });

  test("setVisibility, hideEntry and removeEntry answer the state they set", async () => {
    const visibility = answering(VISIBLE);
    expect(await setVisibility("b1", false, {}, { fetch: visibility.send })).toEqual({ ok: true, value: false });
    expect(visibility.calls[0]?.url).toBe(`${LEADERBOARD_BASE_PATH}/b1/me/visibility`);
    expect(visibility.calls[0]?.init?.method).toBe("PUT");
    expect(visibility.calls[0]?.init?.body).toBe(JSON.stringify({ visible: false }));

    const hide = answering(HIDDEN);
    expect(await hideEntry("b1", "u 2", true, { window: "w" }, { fetch: hide.send })).toEqual({
      ok: true,
      value: true,
    });
    expect(hide.calls[0]?.url).toBe(`${LEADERBOARD_BASE_PATH}/b1/entries/u%202/hidden?window=w`);
    expect(hide.calls[0]?.init?.method).toBe("PUT");

    const remove = answering(REMOVED);
    expect(await removeEntry("b1", "u2", {}, { fetch: remove.send })).toEqual({ ok: true, value: true });
    expect(remove.calls[0]?.url).toBe(`${LEADERBOARD_BASE_PATH}/b1/entries/u2`);
    expect(remove.calls[0]?.init?.method).toBe("DELETE");
  });

  test("a bearer client's headers ride every request", async () => {
    const { send, calls } = answering(PAGE);
    await readTop("b1", {}, { fetch: send, headers: { authorization: "Bearer t" } });
    expect(calls[0]?.init?.headers).toEqual({ authorization: "Bearer t" });
  });

  test("a session keeps the newest bookmark and sends it on the next call", async () => {
    expect(LEADERBOARD_BOOKMARK_HEADER).toBe(BOOKMARK_HEADER);
    const session: LeaderboardSession = { bookmark: null };
    const write = answering(SUBMITTED, 201, "bm-1");
    await submitScore("b1", 1, { fetch: write.send, session });
    expect(write.calls[0]?.init?.headers).not.toHaveProperty(LEADERBOARD_BOOKMARK_HEADER);
    expect(session.bookmark).toBe("bm-1");

    const readBack = answering(ME);
    await readOwnRank("b1", {}, { fetch: readBack.send, session });
    expect(readBack.calls[0]?.init?.headers?.[LEADERBOARD_BOOKMARK_HEADER]).toBe("bm-1");
    // An answer without one keeps the bookmark it had.
    expect(session.bookmark).toBe("bm-1");
  });

  test("a path value cannot add a segment of its own", async () => {
    const { send, calls } = answering(PAGE);
    await readTop("../b1", {}, { fetch: send });
    expect(calls[0]?.url).toBe(`${LEADERBOARD_BASE_PATH}/..%2Fb1/top`);
    await expect(readTop("\uD800", {}, { fetch: send })).resolves.toMatchObject({ ok: true });
  });
});

describe("nothing throws, and every failure is renderable", () => {
  test("a refusal arrives as the server's own code and message", async () => {
    const { send } = answering(
      { error: { code: "leaderboard/submit_forbidden", status: 403, message: "Scores come from the server." } },
      403,
    );
    expect(await submitScore("b1", 1, { fetch: send })).toEqual({
      ok: false,
      failure: { code: "leaderboard/submit_forbidden", message: "Scores come from the server.", action: null },
    });
  });

  test("an unreachable worker is a failure, not a rejection", async () => {
    const send: LeaderboardFetch = async () => {
      throw new Error("offline");
    };
    await expect(listBoards({ fetch: send })).resolves.toEqual({ ok: false, failure: LEADERBOARD_UNREACHABLE });
  });

  test("a program with no fetch at all is the same failure", async () => {
    await expect(listBoards({ global: {} })).resolves.toEqual({ ok: false, failure: LEADERBOARD_UNREACHABLE });
  });

  test("a proxy's HTML page is unreadable rather than a crash", async () => {
    const send: LeaderboardFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(listBoards({ fetch: send })).resolves.toEqual({ ok: false, failure: LEADERBOARD_UNREADABLE });
  });

  test("an answer of the wrong shape is unreadable rather than handed on", async () => {
    const { send } = answering({ board: "b1", window: "all", entries: [{ userId: "u1" }] });
    await expect(readTop("b1", {}, { fetch: send })).resolves.toEqual({ ok: false, failure: LEADERBOARD_UNREADABLE });
    const me = answering({ ...ME, visible: "yes" });
    await expect(readOwnRank("b1", {}, { fetch: me.send })).resolves.toEqual({
      ok: false,
      failure: LEADERBOARD_UNREADABLE,
    });
  });
});

describe("the request never leaves this origin", () => {
  test.each([
    ["//evil.example.com", "a protocol-relative authority"],
    ["/\\evil.example.com", "the backslash form a URL parser reads as one"],
    ["https://evil.example.com/leaderboard", "an absolute URL"],
    ["leaderboard", "an unrooted path"],
  ])("%s is refused before anything is sent — %s", async (basePath) => {
    const { send, calls } = answering(BOARDS);
    expect(await listBoards({ basePath, fetch: send })).toEqual({ ok: false, failure: LEADERBOARD_CROSS_ORIGIN });
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
