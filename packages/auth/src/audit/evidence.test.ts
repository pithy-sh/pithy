// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **What `surveyDeleteHooks` is able to catch, driven against hooks objects written here.**
 *
 * The gate itself points at the composed instance (`../instance/auth.workers.test.ts`), and an instance
 * that satisfies its own checker proves only that two copies of one value agree. So the checker's reach
 * is established from outside: each shape below is one a future wiring could plausibly take, and the one
 * that must pass is built by `claimedDelete` rather than described.
 *
 * `claimedDelete` needs a Kysely only for the claim, which nothing here reaches — every case asserts what
 * the survey *saw*, never what a hook did.
 */

import { describe, expect, test } from "vitest";
import type { AuthDatabase } from "../data/tables";
import { claimedDelete, surveyDeleteHooks } from "./evidence";

/** A Kysely that is never used: the survey reads functions, and no case here calls one. */
const UNREACHED_DB = {} as AuthDatabase;

/** The protected pair, built the only way it can be built. */
function protectedPair() {
  return claimedDelete<{ id: unknown }, unknown>({
    db: UNREACHED_DB,
    table: "pithyAuthAccounts",
    after: async () => {},
  });
}

describe("surveyDeleteHooks", () => {
  test("names a delete.after wired with no before at all", () => {
    const survey = surveyDeleteHooks({ session: { delete: { after: async () => {} } } });

    expect(survey.wired).toEqual(["session"]);
    expect(survey.unclaimed).toEqual(["session"]);
  });

  test("names a delete.after whose before is some other hook", () => {
    // **The shape a structural check alone would pass**, and the reason the brand exists: a `before`
    // beside an `after` says nothing about whether it claimed the removal. This one logs.
    const survey = surveyDeleteHooks({
      session: { delete: { before: async () => {}, after: async () => {} } },
    });

    expect(survey.unclaimed).toEqual(["session"]);
  });

  test("names a delete.after that borrowed a claimed before from elsewhere", () => {
    // Half a pair is not the pair. The claim and the gate are carried by one closure, so an `after`
    // written by hand beside a claimed `before` has no access to what that `before` won.
    const survey = surveyDeleteHooks({
      account: { delete: { before: protectedPair().before, after: async () => {} } },
    });

    expect(survey.unclaimed).toEqual(["account"]);
  });

  test("names a delete.after that declares the flag rather than earning it", () => {
    // The brand is a private symbol, so this is the closest an impostor can get from outside.
    const after = async () => {};
    Object.defineProperty(after, Symbol("pithy.auth.claimsItsRemovals"), { value: true });
    const survey = surveyDeleteHooks({ account: { delete: { before: async () => {}, after } } });

    expect(survey.unclaimed).toEqual(["account"]);
  });

  test("passes a pair that came out of claimedDelete", () => {
    const survey = surveyDeleteHooks({ account: { delete: protectedPair() } });

    expect(survey.wired).toEqual(["account"]);
    expect(survey.unclaimed).toEqual([]);
  });

  test("reads whatever models are there, having no list of its own", () => {
    // The rule is about `delete.after`, not about the two models that have one today. A third is caught
    // the day it lands, which is the whole reason this is a survey rather than two assertions.
    const survey = surveyDeleteHooks({
      account: { delete: protectedPair() },
      session: { delete: protectedPair() },
      verification: { delete: { after: async () => {} } },
    });

    expect(survey.wired).toEqual(["account", "session", "verification"]);
    expect(survey.unclaimed).toEqual(["verification"]);
  });

  test("a create or update hook is not its business", () => {
    const survey = surveyDeleteHooks({
      user: { create: { before: async () => {}, after: async () => {} }, update: { before: async () => {} } },
    });

    expect(survey.wired).toEqual([]);
    expect(survey.unclaimed).toEqual([]);
  });

  test("reports nothing wired when there is nothing to walk", () => {
    // Not a pass — a caller that cannot find its subject has to say so, which is why `wired` is reported
    // beside `unclaimed` and why the gate asserts both.
    for (const absent of [undefined, null, "databaseHooks", 42]) {
      expect(surveyDeleteHooks(absent)).toEqual({ wired: [], unclaimed: [] });
    }
  });
});
