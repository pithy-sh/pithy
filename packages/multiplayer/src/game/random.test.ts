import { describe, expect, test } from "vitest";
import { createRngState, type RngState, randomSource } from "./random";

const state = (cursor = 0): RngState => ({ seed: "0123456789abcdef0123456789abcdef", seedHash: "unused", cursor });

describe("randomSource — determinism", () => {
  test("the same seed and cursor produce the same stream", () => {
    const a = randomSource(state());
    const b = randomSource(state());
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  test("a different seed produces a different stream", () => {
    const a = randomSource({ seed: "aaaa", seedHash: "x", cursor: 0 });
    const b = randomSource({ seed: "bbbb", seedHash: "x", cursor: 0 });
    expect(a.next()).not.toEqual(b.next());
  });

  test("resuming from a persisted cursor continues the stream (no repeats)", () => {
    const first = randomSource(state(0));
    const v0 = first.next();
    const v1 = first.next();
    expect(first.spent()).toBe(2);
    // A fresh source resumed at cursor 2 yields the NEXT values, never a repeat of v0/v1.
    const resumed = randomSource(state(2));
    const v2 = resumed.next();
    expect([v0, v1, v2].length).toBe(new Set([v0, v1, v2]).size);
    // And a source resumed at cursor 0 replays exactly (provably fair — an auditor reproduces the stream).
    const replay = randomSource(state(0));
    expect([replay.next(), replay.next()]).toEqual([v0, v1]);
  });

  test("int stays within its inclusive bounds and covers the range over many draws", () => {
    const r = randomSource(state());
    const seen = new Set<number>();
    for (let i = 0; i < 600; i++) {
      const v = r.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([1, 2, 3, 4, 5, 6])); // every face appears
  });

  test("pick returns an element of the array", () => {
    const r = randomSource(state());
    const items = ["a", "b", "c"] as const;
    for (let i = 0; i < 20; i++) expect(items).toContain(r.pick(items));
  });
});

describe("createRngState — provably-fair commitment", () => {
  test("mints a seed, its SHA-256 commitment, and a zero cursor", async () => {
    const s = await createRngState();
    expect(s.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(s.seedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.cursor).toBe(0);
  });

  test("the commitment verifies against the seed (what an auditor checks)", async () => {
    const s = await createRngState();
    const seedBytes = Uint8Array.from((s.seed.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", seedBytes));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(s.seedHash);
  });

  test("two mints differ (real entropy)", async () => {
    const [a, b] = [await createRngState(), await createRngState()];
    expect(a.seed).not.toBe(b.seed);
  });
});
