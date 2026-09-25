// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { HealthSummaryKey, standingOf } from "@pithy-sh/core/src/controlPlane/discovery/healthSummary";
import type { Context } from "hono";
import { describe, expect, test } from "vitest";
import { RotationStatus } from "../data/secretRotations";
import { defineSecretRegistry } from "../registry";
import {
  AtRestRotationOutcome,
  atRestOutcome,
  LAST_AT_REST_ROTATION,
  type LatestAtRestRotation,
  readAtRestRotationOutcome,
  SECRETS_DUE_FOR_ROTATION,
  secretsHealth,
} from "./health";
import type { SecretsStatusDb } from "./status";

/**
 * The declaration and the mapping, with no database in sight.
 *
 * `defineCapabilityHealth` parses its keys and touches no binding, so everything a client reads off the
 * manifest *about* the new key — its members, what it costs, which scope it is behind, and how each
 * member grades — is decidable here. `health.workers.test.ts` proves the other half: that real rows and
 * a real binding produce these members, and that nothing else comes with them.
 */

const registry = defineSecretRegistry({
  "auth-signing-key": { backend: "d1", scope: "environment", rotatable: true, valueType: "text", rotateEveryDays: 90 },
});

/** The cadence every case below is graded against — the default a project gets from `secrets()`. */
const INTERVAL_DAYS = 30;
const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-11T00:00:00.000Z");

function keyed(name: string): HealthSummaryKey {
  const declared = secretsHealth(() => registry, INTERVAL_DAYS).keys.find((key) => key.key === name);
  if (!declared) throw new Error(`the secrets capability declares no health key ${name}`);
  return HealthSummaryKey.parse(declared);
}

/** A closed pass, `msAgo` milliseconds before {@link NOW}. */
function closed(status: RotationStatus, msAgo: number): LatestAtRestRotation {
  return { state: "readable", status, completedAt: new Date(NOW.getTime() - msAgo) };
}

/** How that pass reads on the manifest, on the project's own cadence, at {@link NOW}. */
function outcomeOf(latest: LatestAtRestRotation, intervalDays = INTERVAL_DAYS): AtRestRotationOutcome {
  return atRestOutcome(latest, intervalDays, NOW);
}

/**
 * A request context carrying nothing but an env, which is all {@link readAtRestRotationOutcome}'s
 * master-key probe reads.
 *
 * The database is deliberately unusable. A probe that resolves would go on to query it and throw, so
 * every assertion made through this helper is one only the `masterKeyUnresolvable` path can satisfy.
 */
function contextWithEnv(env: Record<string, unknown>): Context<PithyHonoEnv> {
  return { env } as unknown as Context<PithyHonoEnv>;
}
const NO_DATABASE = undefined as unknown as SecretsStatusDb;

describe("the at-rest key's declaration", () => {
  test("is a state over the producer's own union, so the two cannot drift", () => {
    const key = keyed(LAST_AT_REST_ROTATION);
    expect(key.kind).toBe("state");
    expect(key.states).toEqual([...AtRestRotationOutcome.options]);
  });

  test("costs one indexed lookup, like the count beside it", () => {
    // One binding read for the master key, then a reverse seek into `(name, rowid)` returning at most
    // one row. `HealthValueCost` has no member for a scan, so a read that needed one could not be
    // declared at all — stating `indexed` is a claim about the plan, not a label.
    expect(keyed(LAST_AT_REST_ROTATION).cost).toBe("indexed");
  });

  test("is behind the status read scope, never the rotate scope", () => {
    // `secrets:rotate` gates a POST and is what a dashboard asks for when it wants to *act*. A read-only
    // connection would be told a value exists that it could never be shown, permanently.
    expect(keyed(LAST_AT_REST_ROTATION).scope).toBe("secrets:status:read");
  });

  test("names `succeeded` as its only nominal member", () => {
    expect(keyed(LAST_AT_REST_ROTATION).nominal).toEqual(["succeeded"]);
  });

  test("says in its own summary that a failure does not mean the store is untouched", () => {
    // The key cannot distinguish an abort before anything was re-encrypted from one part-way through,
    // and those have different remedies. The summary is where that is admitted rather than inferred.
    expect(keyed(LAST_AT_REST_ROTATION).summary).toContain("mid-rotation");
  });

  test("the count key grades zero as nominal, so a client can list what wants attention", () => {
    expect(keyed(SECRETS_DUE_FOR_ROTATION).nominal).toEqual({ atMost: 0 });
  });
});

describe("how a client grades each member", () => {
  const key = keyed(LAST_AT_REST_ROTATION);

  test("`succeeded` is nominal", () => {
    expect(standingOf(key, "succeeded")).toBe("nominal");
  });

  /**
   * The six that are not, listed one by one because each is a decision rather than a leftover.
   *
   * `failed` and `unreadable` are obvious. `inProgress` is attention because an interrupted pass holds
   * its row open until the next cron opens a newer one — up to one `ROTATION_INTERVAL_DAYS`, which is
   * exactly the window this key exists to shorten. `neverRun` is attention because a manager Worker
   * whose cron was never wired reports it forever and a master key that has never rotated is a finding.
   * `masterKeyUnresolvable` is attention because it is the headline failure of #647, and `stale` because
   * it is that failure's other half: a cron that stopped firing, reported by a key that would otherwise
   * keep saying `succeeded` about a pass nobody has repeated.
   */
  test.each(["stale", "failed", "inProgress", "neverRun", "unreadable", "masterKeyUnresolvable"])(
    "`%s` wants attention",
    (member) => {
      expect(standingOf(key, member)).toBe("attention");
    },
  );
});

describe("the mapping", () => {
  test.each([
    ["success", "succeeded"],
    ["failed", "failed"],
    ["in_progress", "inProgress"],
  ] as const)("a `%s` row reports `%s`", (status, expected) => {
    // One day old, so the `success` case is well inside every cadence and the members below it are
    // unaffected by age at all.
    expect(outcomeOf(closed(status, DAY_MS))).toBe(expected);
  });

  test("no row at all is `neverRun`, and never `succeeded`", () => {
    // The distinction requirement in one line: a store nobody has ever rotated must not read as one
    // that rotated successfully.
    expect(outcomeOf({ state: "none" })).toBe("neverRun");
  });

  test("a row that will not decode is `unreadable`, which is not a failure either", () => {
    expect(outcomeOf({ state: "unreadable" })).toBe("unreadable");
  });

  test("an open pass has no completion instant, and still reports `inProgress`", () => {
    // `completedAt` is null while a row is open. Only `succeeded` is aged, so the absent instant is not
    // a reason to report anything else.
    expect(outcomeOf({ state: "readable", status: "in_progress", completedAt: null })).toBe("inProgress");
  });

  test("the three lifecycle states map onto three distinct members", () => {
    // A `Record<RotationStatus, …>` makes the mapping total at compile time; this makes it injective at
    // runtime, so a member cannot be folded into another one and lose a state a client acts on.
    const mapped = RotationStatus.options.map((status) => outcomeOf(closed(status, DAY_MS)));
    expect(new Set(mapped).size).toBe(RotationStatus.options.length);
  });

  test("there is no member for an abort — an abort and a failure are one outcome and two reasons", () => {
    // A decision, not an omission: `RotationStatus` has no `aborted`, and the only column that could
    // tell the two apart is `error_message` — the column #386 closed.
    expect(AtRestRotationOutcome.options).not.toContain("aborted");
  });
});

/**
 * A cron that stopped firing must not read as healthy — the second half of #647, one layer out.
 *
 * Every other member of this key reports how the last pass *ended*. None of them can see the pass that
 * never started: drop the cron trigger, remove the `AT_REST_ROTATION` binding, stop deploying the
 * manager Worker, and the newest ledger row stays `success` forever. These cases are the difference.
 */
describe("a pass that succeeded too long ago", () => {
  test("is still `succeeded` while it is inside the cadence", () => {
    expect(outcomeOf(closed("success", 29 * DAY_MS))).toBe("succeeded");
  });

  /**
   * The lower bracket on the threshold, and the reason it is not one interval.
   *
   * At 45 days a 30-day rotation is due and has not run — which is the ordinary state of every healthy
   * project between a cron tick and a finished pass, and reporting it would mute the key inside a month.
   * This fails the moment the multiple drops to 1.
   */
  test("is still `succeeded` when it is merely due — a pass is not stale the instant it is late", () => {
    expect(outcomeOf(closed("success", 45 * DAY_MS))).toBe("succeeded");
  });

  /** The upper bracket. Two whole cadences with nothing succeeding is a schedule that is not running. */
  test("is `stale` at two intervals, which no running schedule can reach", () => {
    expect(outcomeOf(closed("success", 60 * DAY_MS))).toBe("stale");
  });

  test("is `succeeded` one millisecond earlier, so the boundary is the threshold and not an approximation", () => {
    expect(outcomeOf(closed("success", 60 * DAY_MS - 1))).toBe("succeeded");
  });

  test("is `stale` long past it — the dead-cron case a store sits in for months", () => {
    expect(outcomeOf(closed("success", 400 * DAY_MS))).toBe("stale");
  });

  /**
   * The cadence is the adopter's, not a constant in this file.
   *
   * A project on a 7-day cadence and a project on 30 disagree about the same 30-day-old pass, and the
   * number that decides is the one `secrets({ rotationIntervalDays })` declared. This fails if the
   * threshold is ever hard-coded rather than threaded.
   */
  test("is graded against the project's own interval, not a fixed number of days", () => {
    const pass = closed("success", 30 * DAY_MS);
    expect(outcomeOf(pass, 30)).toBe("succeeded");
    expect(outcomeOf(pass, 7)).toBe("stale");
  });

  test.each([Number.NaN, 0, -30, Number.POSITIVE_INFINITY])(
    "reports `stale` on an interval of %s, because the cron cannot start a pass under one either",
    (intervalDays) => {
      // `isRotationDue` refuses these, here and in `scheduled()` — where the refusal throws before the
      // Workflow is ever created. A project whose interval does not parse runs no rotation at all, so
      // its last successful pass is the last one there will be. `succeeded` would be the lie.
      expect(outcomeOf(closed("success", DAY_MS), intervalDays)).toBe("stale");
    },
  );

  test("a `succeeded` with no completion instant is `stale`, never nominal", () => {
    // `latestAtRestRotation` reports that row as `unreadable` and never builds this value, so this is
    // the hand-assembled case. A success nobody can date cannot be shown to be inside any cadence, and
    // the one answer this key must never give for it is the nominal one.
    expect(outcomeOf({ state: "readable", status: "success", completedAt: null })).toBe("stale");
  });
});

describe("staleness refines the nominal member and nothing else", () => {
  test("a store that never rotated is `neverRun`, not `stale` — two different conversations", () => {
    // Requirement four. A never-run environment is infinitely late by any arithmetic, and collapsing it
    // into `stale` would lose the distinction between a project whose rotation never started and one
    // whose rotation started and then stopped.
    expect(outcomeOf({ state: "none" })).toBe("neverRun");
  });

  test.each(["failed", "in_progress"] as const)(
    "an ancient `%s` row keeps its own member — the more actionable fact travels",
    (status) => {
      expect(outcomeOf(closed(status, 400 * DAY_MS))).toBe(status === "failed" ? "failed" : "inProgress");
    },
  );

  test("an ancient unreadable row is still `unreadable`", () => {
    expect(outcomeOf({ state: "unreadable" })).toBe("unreadable");
  });
});

describe("the master key is asked before the ledger (#647, D15)", () => {
  test("an unresolvable SECRETS_ENCRYPTION_KEYS is its own member, reached without touching the ledger", async () => {
    // No binding at all. If the probe were removed this would fall through to a database that is
    // `undefined` and throw, so the assertion is one only the short-circuit can satisfy.
    const outcome = await readAtRestRotationOutcome(contextWithEnv({}), NO_DATABASE, INTERVAL_DAYS, NOW);
    expect(outcome).toBe("masterKeyUnresolvable");
  });

  test("a binding that is not JSON is unresolvable too, and reports the same member", async () => {
    const outcome = await readAtRestRotationOutcome(
      contextWithEnv({ SECRETS_ENCRYPTION_KEYS: "not-json" }),
      NO_DATABASE,
      INTERVAL_DAYS,
      NOW,
    );
    expect(outcome).toBe("masterKeyUnresolvable");
  });

  test("a binding that is JSON but not an EncryptionConfig is unresolvable", async () => {
    const outcome = await readAtRestRotationOutcome(
      contextWithEnv({ SECRETS_ENCRYPTION_KEYS: JSON.stringify({ currentVersion: "1" }) }),
      NO_DATABASE,
      INTERVAL_DAYS,
      NOW,
    );
    expect(outcome).toBe("masterKeyUnresolvable");
  });
});

describe("the declaration advertises no member nothing can produce", () => {
  test("every declared state is reachable from a real input", async () => {
    const fromLedger = [
      ...RotationStatus.options.map((status) => outcomeOf(closed(status, DAY_MS))),
      outcomeOf(closed("success", 400 * DAY_MS)),
      outcomeOf({ state: "none" }),
      outcomeOf({ state: "unreadable" }),
    ];
    const fromProbe = await readAtRestRotationOutcome(contextWithEnv({}), NO_DATABASE, INTERVAL_DAYS, NOW);
    // A member added to the enum with no producer behind it — an `aborted` nothing computes — fails
    // here, which is the only thing standing between a client rendering a state and a Worker that can
    // never send it.
    expect(new Set([...fromLedger, fromProbe])).toEqual(new Set(AtRestRotationOutcome.options));
  });
});
