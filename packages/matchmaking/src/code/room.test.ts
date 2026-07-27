import type { KVNamespace } from "@cloudflare/workers-types";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, it } from "vitest";
import { MatchmakingGame } from "../config/config";
import type { SessionMinter } from "../session/minter";
import { createRoom, normalizeCode } from "./room";

describe("normalizeCode", () => {
  it("accepts the canonical form unchanged", () => {
    expect(normalizeCode("WXYZ-1234")).toBe("WXYZ-1234");
  });

  it("uppercases and strips spaces", () => {
    expect(normalizeCode(" wxyz-1234 ")).toBe("WXYZ-1234");
    expect(normalizeCode("wx yz-12 34")).toBe("WXYZ-1234");
  });

  it("inserts a missing dash", () => {
    expect(normalizeCode("WXYZ1234")).toBe("WXYZ-1234");
    expect(normalizeCode("wxyz1234")).toBe("WXYZ-1234");
  });

  it("throws matchmaking/invalid_code on a malformed code", () => {
    const bad = ["", "WXYZ", "1234", "WXY-1234", "WXYZ-123", "WXYZ-12345", "12WXYZ34", "WX!Z-1234"];
    for (const raw of bad) {
      try {
        normalizeCode(raw);
        throw new Error(`expected "${raw}" to throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(PithyError);
        expect((error as PithyError).payload.code).toBe("matchmaking/invalid_code");
      }
    }
  });
});

/** A minimal in-memory KV good enough for TypedKv.get/put — no Miniflare needed for the generator test. */
function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(name: string) {
      return store.get(name) ?? null;
    },
    async put(name: string, value: string) {
      store.set(name, value);
    },
    async delete(name: string) {
      store.delete(name);
    },
  } as unknown as KVNamespace;
}

const fakeMinter: SessionMinter = {
  async mint() {
    return "session-x";
  },
  async join() {},
};

const game = MatchmakingGame.parse({
  key: "chess",
  players: 2,
  snapshot: { kind: "chess", rules: {} },
});

describe("generated room codes", () => {
  it("match WXYZ-1234 and exclude ambiguous characters (I, O, 0, 1)", async () => {
    const canonical = /^[A-Z]{4}-[0-9]{4}$/;
    const codes: string[] = [];
    for (let i = 0; i < 100; i++) {
      const { code } = await createRoom(memoryKv(), game, fakeMinter, "host", new Date());
      codes.push(code);
    }
    for (const code of codes) {
      expect(code).toMatch(canonical);
      const [letters, digits] = code.split("-");
      expect(letters).not.toMatch(/[IO]/);
      expect(digits).not.toMatch(/[01]/);
      // round-trips through the validator unchanged
      expect(normalizeCode(code)).toBe(code);
    }
  });
});
