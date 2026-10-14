// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asyncApiDocument, undescribedAsyncFields } from "@pithy-sh/core/src/asyncapi/document";
import { describe, expect, test } from "vitest";
import { matchmaking } from "../capability";
import { inviteView } from "../http/views";
import { PRESENCE_PATH, presenceSocket } from "./channel";
import {
  PRESENCE_VERSIONS,
  PresenceClientFrame,
  PresenceEvent,
  PresenceInitFrame,
  PresencePong,
  PresenceServerFrame,
} from "./frames";

const INVITE = inviteView({
  id: "11111111-1111-4111-8111-111111111111",
  gameKey: "duel",
  inviterId: "ben",
  inviteeId: "ada",
  status: "pending",
  sessionId: null,
  createdAt: new Date("2026-07-25T10:00:00.000Z"),
  respondedAt: null,
});

const FRAMES = [
  { type: "init", pendingInvites: [INVITE], onlineFriends: ["grace"] },
  { type: "match_found", sessionId: "s1", gameKey: "duel" },
  { type: "invite", inviteId: INVITE.id, gameKey: "duel", from: "ben" },
  { type: "friend_request", from: "ben" },
  { type: "error", error: { code: "validation/invalid_input", status: 400, message: "Invalid input.", issues: [] } },
];

describe("the presence frames", () => {
  test.each(FRAMES.map((frame) => [frame.type, frame]))("a `%s` frame parses to itself", (_type, frame) => {
    expect(PresenceServerFrame.parse(frame)).toEqual(frame);
  });

  test("an event is one of the three `notify()` pushes, and never the connect payload", () => {
    expect(PresenceEvent.safeParse(FRAMES[1]).success).toBe(true);
    expect(PresenceEvent.safeParse(FRAMES[0]).success).toBe(false);
  });

  test("an invite on the init frame is the HTTP view, dates as ISO strings", () => {
    const init = PresenceInitFrame.parse(FRAMES[0]);
    expect(init.pendingInvites[0]?.createdAt).toBe("2026-07-25T10:00:00.000Z");
  });

  test("an unknown `type` is not a server frame", () => {
    expect(PresenceServerFrame.safeParse({ type: "state" }).success).toBe(false);
  });

  test("a client sends `ping` and nothing else", () => {
    expect(PresenceClientFrame.safeParse("ping").success).toBe(true);
    for (const frame of ["PING", " ping", "{}", '{"type":"ping"}', ""]) {
      expect(PresenceClientFrame.safeParse(frame).success).toBe(false);
    }
    expect(PresencePong.value).toBe("pong");
  });

  test("the module imports nothing a browser cannot load", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "frames.ts"), "utf8");
    const imports = (source.match(/^import\s.+$/gm) ?? []).map((line) => line.replace(/.*from\s+"([^"]+)".*/, "$1"));
    expect(imports).toEqual([
      "@pithy-sh/core/src/error/wire",
      "@pithy-sh/core/src/http/subprotocol",
      "zod",
      "../http/responses",
    ]);
  });
});

describe("the presence socket declaration", () => {
  test("mounts where the routes mounted the upgrade", () => {
    expect(presenceSocket().path).toBe(`/matchmaking${PRESENCE_PATH}`);
    expect(presenceSocket("/play").path).toBe(`/play${PRESENCE_PATH}`);
  });

  test("is what the capability declares, under its base path", () => {
    const cap = matchmaking({ games: [{ key: "duel", snapshot: { kind: "connect-n", rules: {} } }], basePath: "/mm" });
    expect(cap.sockets?.map((socket) => socket.path)).toEqual(["/mm/presence"]);
    expect(cap.sockets?.[0]?.versions).toEqual(PRESENCE_VERSIONS);
  });

  test("names every frame each side sends, `ping` and `pong` as the plain-text exception", () => {
    const socket = presenceSocket();
    expect(socket.send.map((message) => message.name)).toEqual([
      "init",
      "match_found",
      "invite",
      "friend_request",
      "error",
      "pong",
    ]);
    expect(socket.send.find((message) => message.name === "pong")).toMatchObject({ text: "pong" });
    expect(socket.receive).toEqual([{ name: "ping", summary: expect.any(String), text: "ping" }]);
  });

  test("becomes an AsyncAPI document with every field described", () => {
    const document = asyncApiDocument({ title: "Matchmaking", version: "1.0.0" }, [
      { tag: "matchmaking", sockets: [presenceSocket()] },
    ]);
    expect(undescribedAsyncFields(document)).toEqual([]);
    expect(Object.keys(document.channels)).toHaveLength(1);
  });
});
