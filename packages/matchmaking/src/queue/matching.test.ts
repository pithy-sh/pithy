import { describe, expect, test } from "vitest";
import { MatchmakingQueueSettings, MatchmakingSnapshot } from "../config/config";
import { formMatches, type WaitingTicket } from "./matching";

// A minted-session snapshot is irrelevant to pairing — a fixed valid one keeps every ticket well-formed.
const SNAPSHOT = MatchmakingSnapshot.parse({ kind: "connect-n", rules: {} });

type SettingsInput = Partial<{
  initialBand: number;
  widenPerSecond: number;
  maxWaitSeconds: number;
  sweepSeconds: number;
}>;

function mkSettings(over: SettingsInput = {}) {
  return MatchmakingQueueSettings.parse({ initialBand: 100, widenPerSecond: 50, maxWaitSeconds: 120, ...over });
}

const T0 = 1_000_000;

function ticket(over: Partial<WaitingTicket> & { userId: string }): WaitingTicket {
  return {
    skill: 1000,
    region: "na",
    players: 2,
    snapshot: SNAPSHOT,
    settings: mkSettings(),
    enqueuedAt: T0,
    ...over,
  };
}

function rosterSet(groups: { roster: string[] }[], index: number): Set<string> {
  return new Set(groups[index]?.roster ?? []);
}

describe("formMatches (the open-queue pairing rule)", () => {
  test("two same-region players within the initial band pair immediately", () => {
    const a = ticket({ userId: "a", skill: 1000 });
    const b = ticket({ userId: "b", skill: 1050 }); // gap 50 ≤ initialBand 100

    const groups = formMatches([a, b], T0);

    expect(groups).toHaveLength(1);
    expect(rosterSet(groups, 0)).toEqual(new Set(["a", "b"]));
  });

  test("a gap outside the band does not pair until a later `now` widens it", () => {
    const a = ticket({ userId: "a", skill: 0, enqueuedAt: T0 });
    const b = ticket({ userId: "b", skill: 500, enqueuedAt: T0 }); // gap 500

    // At enqueue the band is 100 — far too tight.
    expect(formMatches([a, b], T0)).toEqual([]);
    // 7s later the band is 100 + 50·7 = 450 — still short of 500.
    expect(formMatches([a, b], T0 + 7_000)).toEqual([]);
    // 8s later the band is 500 — the gap now fits and they pair.
    const widened = formMatches([a, b], T0 + 8_000);
    expect(widened).toHaveLength(1);
    expect(rosterSet(widened, 0)).toEqual(new Set(["a", "b"]));
  });

  test("players in different regions never pair, however long they wait", () => {
    const a = ticket({ userId: "a", skill: 1000, region: "na" });
    const b = ticket({ userId: "b", skill: 1000, region: "eu" });

    expect(formMatches([a, b], T0)).toEqual([]);
    // Even far past maxWaitSeconds — unbounded band — the region wall holds.
    expect(formMatches([a, b], T0 + 10_000_000)).toEqual([]);
  });

  test("an unrated (null-skill) player pairs with anyone in region, whatever the gap", () => {
    const a = ticket({ userId: "a", skill: null });
    // A huge skill and a zero, non-widening band — only the null rule can bridge this.
    const b = ticket({ userId: "b", skill: 999_999, settings: mkSettings({ initialBand: 0, widenPerSecond: 0 }) });

    const groups = formMatches([a, b], T0);

    expect(groups).toHaveLength(1);
    expect(rosterSet(groups, 0)).toEqual(new Set(["a", "b"]));
  });

  test("a 4-player game forms only when four compatible players are present", () => {
    const four = ["a", "b", "c", "d"].map((userId, i) =>
      ticket({ userId, skill: 1000 + i * 10, players: 4, enqueuedAt: T0 + i }),
    );

    const formed = formMatches(four, T0 + 100);
    expect(formed).toHaveLength(1);
    expect(rosterSet(formed, 0)).toEqual(new Set(["a", "b", "c", "d"]));

    // Drop to three compatible plus one far outlier (tight, non-widening band): no full roster forms.
    const tight = mkSettings({ initialBand: 50, widenPerSecond: 0, maxWaitSeconds: 100_000 });
    const near = ["a", "b", "c"].map((userId, i) =>
      ticket({ userId, skill: 1000 + i * 10, players: 4, enqueuedAt: T0 + i, settings: tight }),
    );
    const far = ticket({ userId: "z", skill: 5000, players: 4, enqueuedAt: T0 + 3, settings: tight });

    expect(formMatches([...near, far], T0 + 10)).toEqual([]);
  });
});
