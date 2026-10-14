// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ClientFrame,
  ErrorFrame,
  encodeErrorFrame,
  encodeStateFrame,
  MULTIPLAYER_SOCKET_VERSIONS,
  ServerFrame,
  StateFrame,
} from "./frames";
import { SessionView } from "./view";

const VIEW = SessionView.parse({
  sessionId: "abc",
  gameKey: "tic-tac-toe",
  kind: "connect-n",
  phase: "active",
  players: ["alice", "bob"],
  outcome: null,
  state: { turn: "alice", yourTurn: true, game: { board: [[null]], moves: 0 } },
  fairness: { seedHash: "hash", seed: null },
});

describe("the session socket's frames", () => {
  test("the current version is pithy.multiplayer.v1, and the one before it is unversioned", () => {
    expect(MULTIPLAYER_SOCKET_VERSIONS).toEqual({ current: "pithy.multiplayer.v1", previous: null });
  });

  test("a v1 state frame is the view with `type: state`, and parses to exactly itself", () => {
    const frame: unknown = JSON.parse(encodeStateFrame(VIEW, MULTIPLAYER_SOCKET_VERSIONS.current));
    expect(frame).toEqual({ type: "state", ...VIEW });
    expect(ServerFrame.parse(frame)).toEqual(frame);
    expect(StateFrame.parse(frame)).toEqual(frame);
  });

  test("an unversioned client gets the bare view, byte for byte what it got before versions existed", () => {
    const text = encodeStateFrame(VIEW, null);
    expect(text).toBe(JSON.stringify(VIEW));
    expect(Object.hasOwn(JSON.parse(text) as object, "type")).toBe(false);
  });

  test("an error frame carries the public payload and parses to exactly itself", () => {
    const frame: unknown = JSON.parse(
      encodeErrorFrame({ code: "multiplayer/invalid_move", status: 422, message: "That cell is already taken." }),
    );
    expect(ErrorFrame.parse(frame)).toEqual(frame);
    expect(ServerFrame.parse(frame)).toEqual(frame);
  });

  test("the client frames parse, and anything else is refused", () => {
    expect(ClientFrame.parse({ type: "action", payload: { row: 0, col: 0 } })).toEqual({
      type: "action",
      payload: { row: 0, col: 0 },
    });
    expect(ClientFrame.parse({ type: "state" })).toEqual({ type: "state" });
    // An action with no payload is still a frame; the game's own `action` schema judges what it carries.
    expect(ClientFrame.safeParse({ type: "action" }).success).toBe(true);
    expect(ClientFrame.safeParse({ type: "move", payload: {} }).success).toBe(false);
    expect(ClientFrame.safeParse({ payload: {} }).success).toBe(false);
    expect(ClientFrame.safeParse("state").success).toBe(false);
  });
});

describe("the frames module is pure", () => {
  test("it imports zod and core's leaf modules only — never the Workers runtime, Hono, or the Durable Object", () => {
    // A browser and an engine's client import this module, so its import list is the contract (#172).
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "frames.ts"), "utf8");
    const imports = [...source.matchAll(/^import\s.+from\s+"([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["@pithy-sh/core/src/error/wire", "@pithy-sh/core/src/http/subprotocol", "zod", "./view"]);
    const view = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "view.ts"), "utf8");
    expect([...view.matchAll(/^import\s.+from\s+"([^"]+)";$/gm)].map((match) => match[1])).toEqual(["zod"]);
  });
});
