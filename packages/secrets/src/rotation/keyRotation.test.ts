// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import type { EncryptionConfig } from "../crypto/envelope";
import {
  generateKeyB64,
  highestVersion,
  isRotationDue,
  promoteStagedKey,
  pruneRetiredKeys,
  retiredVersions,
  type StagedKey,
  stageNextKey,
} from "./keyRotation";

/** A fixed pass instant, so every stamp assertion below names a value and not a moment. */
const PASS_INSTANT = new Date("2026-02-01T00:00:00.000Z");

function config(currentVersion: string, versions: Record<string, string>): EncryptionConfig {
  return { currentVersion, versions, lastRotatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("generateKeyB64", () => {
  test("produces a 32-byte (AES-256) key", async () => {
    expect(atob(await generateKeyB64()).length).toBe(32);
  });
});

describe("highestVersion", () => {
  test("answers the numeric maximum of the key set, not its last-inserted key", () => {
    // Insertion order puts "9" last and lexical order sorts it above "10". Both are wrong answers, and
    // both produce a key set whose newest key is not the one a promotion would point at.
    expect(highestVersion(config("10", { "1": "k1", "10": "k10", "9": "k9" }))).toBe(10);
  });

  test("counts the pointer too, so a key set missing its current version never reissues it", () => {
    // `#647`'s reportable state (D9): the pointer moved and the key it names is gone. Allocating from the
    // key set alone would hand the next pass version 3 while the pointer says 5 — a promotion that moves
    // the pointer *backwards* over rows sealed under 5.
    expect(highestVersion(config("5", { "1": "k1", "2": "k2" }))).toBe(5);
  });

  test("a version key that is not an integer is refused rather than sorted", () => {
    expect(() => highestVersion(config("1", { "1": "k1", latest: "k2" }))).toThrowError(/version/);
  });

  test("the refusal names no part of the malformed entry", () => {
    // The branch that throws is exactly the malformed-config branch, where a base64 key may be sitting in
    // the key position — the config is by definition not the shape anything reasoned about. An earlier
    // draft interpolated the offending version key into `detail`, which is a log; this is what fails if
    // that comes back.
    const planted = "c2tfbGl2ZV9QTEFOVEVEX0tFWV9NQVRFUklBTA==";
    let thrown: unknown;
    try {
      highestVersion(config("1", { "1": "k1", [planted]: "k2" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PithyError);
    const raised = thrown as PithyError;
    // Every channel the throw has: the payload (message, action, detail, params) and the Error's own text.
    expect(JSON.stringify(raised.payload)).not.toContain(planted);
    expect(`${raised.message}${raised.stack ?? ""}`).not.toContain(planted);
  });
});

describe("stageNextKey", () => {
  test("adds the next version and moves neither the pointer nor the cadence clock", async () => {
    const before = config("1", { "1": "k1" });

    const staged = await stageNextKey(before, PASS_INSTANT);

    expect(staged.nextVersion).toBe("2");
    expect(staged.staged.currentVersion).toBe("1");
    expect(Object.keys(staged.staged.versions).sort()).toEqual(["1", "2"]);
    expect(staged.staged.versions["1"]).toBe("k1");
    expect(atob(staged.staged.versions["2"] ?? "").length).toBe(32);
    // `lastRotatedAt` is the cadence clock `isRotationDue` reads. A staged write that touched it would let
    // a pass which aborted before promoting report itself rotated, and the cron would not ask for a month.
    expect(staged.staged.lastRotatedAt).toBe(before.lastRotatedAt);
    // The pass instant travels on the struct instead, for the promotion to stamp.
    expect(staged.at).toBe(PASS_INSTANT.toISOString());
  });

  test("allocates above the highest key, never over one an abandoned stage already wrote", async () => {
    // What a pass that staged and never promoted leaves behind. Rows may already be sealed under 2.
    const abandoned = config("1", { "1": "k1", "2": "k2" });

    const staged = await stageNextKey(abandoned, PASS_INSTANT);

    expect(staged.nextVersion).toBe("3");
    expect(staged.staged.versions["2"]).toBe("k2");
  });

  test("a pointer the key set does not hold is staged over, not crashed on", async () => {
    // D9: that state is a reportable finding, not a crash — the rotation is the thing that repairs it.
    const staged = await stageNextKey(config("5", { "1": "k1" }), PASS_INSTANT);

    expect(staged.nextVersion).toBe("6");
    expect(staged.staged.currentVersion).toBe("5");
  });
});

describe("promoteStagedKey", () => {
  test("moves the pointer to the staged version and stamps the pass instant", async () => {
    const staged = await stageNextKey(config("1", { "1": "k1" }), PASS_INSTANT);

    const promoted = promoteStagedKey(staged);

    expect(promoted.currentVersion).toBe("2");
    expect(promoted.versions).toEqual(staged.staged.versions);
    expect(promoted.lastRotatedAt).toBe(PASS_INSTANT.toISOString());
    // And the staged envelope is untouched: the promotion is a second value, not an edit of the first.
    expect(staged.staged.currentVersion).toBe("1");
  });

  test("refuses to promote a version the staged key set does not hold", () => {
    const staged: StagedKey = {
      staged: config("1", { "1": "k1" }),
      nextVersion: "2",
      at: PASS_INSTANT.toISOString(),
    };

    expect(() => promoteStagedKey(staged)).toThrowError(/key set/);
  });

  test("refuses an empty key just as firmly as an absent one", () => {
    const staged: StagedKey = {
      staged: config("1", { "1": "k1", "2": "" }),
      nextVersion: "2",
      at: PASS_INSTANT.toISOString(),
    };

    // A blank key decrypts nothing, so a pointer at it is the same outage as a pointer at nothing.
    expect(() => promoteStagedKey(staged)).toThrowError(/key set/);
  });
});

describe("retiredVersions", () => {
  test("nothing retires in the pass that created the successor", () => {
    // Superseded pointer 1, promoted to 2. Key 1 is exactly the key a row that failed to re-encrypt is
    // still sitting on, and this pass is the worst moment to find that out.
    expect(retiredVersions(config("2", { "1": "k1", "2": "k2" }), "1")).toEqual([]);
    expect(pruneRetiredKeys(config("2", { "1": "k1", "2": "k2" }), "1")).toBeNull();
  });

  test("the generation before the superseded one goes, and the superseded one stays", () => {
    const promoted = config("3", { "1": "k1", "2": "k2", "3": "k3" });

    expect(retiredVersions(promoted, "2")).toEqual(["1"]);
    expect(pruneRetiredKeys(promoted, "2")).toEqual({
      currentVersion: "3",
      versions: { "2": "k2", "3": "k3" },
      lastRotatedAt: promoted.lastRotatedAt,
    });
  });

  test("a key abandoned by an earlier stage does not age the generation still in use", () => {
    // D10, and the whole reason the floor is a parameter. Pass one staged key 2 and aborted before
    // promoting, leaving `{ currentVersion: "1", versions: { 1, 2 } }` with every row on key 1. Pass two
    // stages 3, promotes to 3, and supersedes pointer **1**. A floor read off the key set would call 2 the
    // predecessor and retire key 1 in the very pass that superseded it — the invariant `#647` states.
    expect(retiredVersions(config("3", { "1": "k1", "2": "k2", "3": "k3" }), "1")).toEqual([]);
  });

  test("the current key is never retired, whatever floor it is handed", () => {
    // A floor at or above the pointer can only be a caller's bug, and the cost of honoring it is every
    // row in the store. `["1"]` and not `["1","2"]`.
    expect(retiredVersions(config("2", { "1": "k1", "2": "k2" }), "5")).toEqual(["1"]);
  });

  test("a key above the pointer is never retired", () => {
    // One exists whenever an earlier pass staged a key and did not promote it, and rows may hold it.
    expect(retiredVersions(config("2", { "1": "k1", "2": "k2", "3": "k3" }), "9")).toEqual(["1"]);
  });

  test("a pointer that is not an integer retires nothing, whatever floor arrives", () => {
    // **The branch the clamp exists for.** A readable floor with an unreadable pointer is precisely where
    // the old `Number.isInteger(current) ? Math.min(floor, current) : floor` skipped the clamp and retired
    // against the bare floor. Restore that ternary and this goes red: key 1 and key 2 both fall below 3.
    expect(retiredVersions(config("two", { "1": "k1", "2": "k2" }), "3")).toEqual([]);
  });

  test("a floor that is not an integer retires nothing", () => {
    // Stated rather than proved: `NaN < ceiling` is already false for every version, so this cannot go red
    // on the floor's own guard alone. It is here because the *answer* is load-bearing wherever a caller
    // hands this a superseded pointer it could not read, and a regression that changed the answer — an
    // `isNaN` branch that fell back to the pointer, say — would be caught here.
    expect(retiredVersions(config("3", { "1": "k1", "2": "k2", "3": "k3" }), "two")).toEqual([]);
  });

  test("pruneRetiredKeys drops exactly the retired versions and keeps the pointer and the clock", () => {
    const promoted = config("4", { "1": "k1", "2": "k2", "3": "k3", "4": "k4" });

    expect(pruneRetiredKeys(promoted, "3")).toEqual({
      currentVersion: "4",
      versions: { "3": "k3", "4": "k4" },
      lastRotatedAt: promoted.lastRotatedAt,
    });
  });
});

describe("stage, promote, retire across three generations", () => {
  test("a key survives the pass that replaced it and goes in the one after", async () => {
    const first = config("1", { "1": "k1" });

    // Generation one. Nothing to retire: there is no generation before the one being superseded.
    const stagedTwo = await stageNextKey(first, new Date("2026-02-01T00:00:00.000Z"));
    const two = promoteStagedKey(stagedTwo);
    expect(two.currentVersion).toBe("2");
    expect(retiredVersions(two, stagedTwo.staged.currentVersion)).toEqual([]);

    // Generation two. Key 1 — superseded a whole pass ago — goes now, and key 2 stays.
    const stagedThree = await stageNextKey(two, new Date("2026-03-01T00:00:00.000Z"));
    const three = promoteStagedKey(stagedThree);
    expect(Object.keys(three.versions).sort()).toEqual(["1", "2", "3"]);
    expect(retiredVersions(three, stagedThree.staged.currentVersion)).toEqual(["1"]);
    const prunedThree = pruneRetiredKeys(three, stagedThree.staged.currentVersion);
    expect(prunedThree).not.toBeNull();
    expect(Object.keys(prunedThree?.versions ?? {}).sort()).toEqual(["2", "3"]);
    expect(prunedThree?.versions["2"]).toBe(two.versions["2"]);
    expect(prunedThree?.currentVersion).toBe("3");

    // Generation three, over the pruned set. A store holds three keys at its widest and never more.
    const stagedFour = await stageNextKey(prunedThree ?? three, new Date("2026-04-01T00:00:00.000Z"));
    const four = promoteStagedKey(stagedFour);
    expect(Object.keys(four.versions).sort()).toEqual(["2", "3", "4"]);
    const prunedFour = pruneRetiredKeys(four, stagedFour.staged.currentVersion);
    expect(Object.keys(prunedFour?.versions ?? {}).sort()).toEqual(["3", "4"]);
    expect(prunedFour?.versions["3"]).toBe(three.versions["3"]);
    expect(prunedFour?.lastRotatedAt).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("isRotationDue", () => {
  test("is due once the interval has elapsed since the last rotation", () => {
    expect(isRotationDue("2026-01-01T00:00:00.000Z", 30, new Date("2026-02-15T00:00:00.000Z"))).toBe(true);
  });

  test("is not due before the interval elapses", () => {
    expect(isRotationDue("2026-01-01T00:00:00.000Z", 30, new Date("2026-01-15T00:00:00.000Z"))).toBe(false);
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["a negative interval", -30],
  ])("refuses an interval of %s rather than answering it", (_label, intervalDays) => {
    // The cron computes this as `Number(env.ROTATION_INTERVAL_DAYS)`, so `"30 days"` is `NaN` — and
    // `now >= NaN` is false, which means at-rest rotation of the master key never comes due, on every tick,
    // forever, with no error and no line in the log. Zero and a negative are the opposite failure: due on
    // every tick. Neither has a safe number to clamp to.
    expect(() =>
      isRotationDue("2026-01-01T00:00:00.000Z", intervalDays as number, new Date("2027-01-01T00:00:00.000Z")),
    ).toThrowError(/misconfigured/);
  });

  test("a rotation a decade overdue is still answered true once the interval is a number", () => {
    // The half that keeps the cases above about the interval rather than about the dates.
    expect(isRotationDue("2016-01-01T00:00:00.000Z", 30, new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
  });
});
