import { describe, expect, test } from "vitest";
import { isMatchmakingCapability, matchmaking } from "./capability";

const SNAPSHOT = { kind: "connect-n", rules: {} };

describe("matchmaking()", () => {
  test("resolves a valid config and exposes it on the capability", () => {
    const cap = matchmaking({ games: [{ key: "duel", snapshot: SNAPSHOT }] });
    expect(cap.name).toBe("matchmaking");
    expect(cap.matchmakingConfig.games[0]?.key).toBe("duel");
    expect(isMatchmakingCapability(cap)).toBe(true);
  });

  test("declares D1, KV, and the two Durable Object bindings", () => {
    const cap = matchmaking({ games: [{ key: "duel", snapshot: SNAPSHOT }] });
    const bindings = cap.requiredBindings.map((b) => `${b.type}:${b.name}`);
    expect(bindings).toContain("d1:DB");
    expect(bindings).toContain("kv:MATCHMAKING");
    expect(bindings).toContain("durable_object:QUEUE");
    expect(bindings).toContain("durable_object:PRESENCE");
  });

  test("rejects duplicate game keys at assembly", () => {
    expect(() =>
      matchmaking({
        games: [
          { key: "duel", snapshot: SNAPSHOT },
          { key: "duel", snapshot: SNAPSHOT },
        ],
      }),
    ).toThrow(/Duplicate game key/);
  });

  test("defaults friends on and abuse off", () => {
    const cap = matchmaking({ games: [{ key: "duel", snapshot: SNAPSHOT }] });
    expect(cap.matchmakingConfig.friends).toBe(true);
    expect(cap.matchmakingConfig.abuse.turnstile).toBe(false);
    expect(cap.matchmakingConfig.abuse.rateLimit).toBe(false);
  });
});
