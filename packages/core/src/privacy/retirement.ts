// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * **The retirement guard's verdict, apart from the counts that feed it** (#390).
 *
 * Its own module, and a leaf, so a browser may import it: the manifest's posture block names
 * {@link RetirementVerdict}, and the management client validates that block in a browser. The counts are read by
 * `./fieldRotation`, which reaches D1 and the Workers types; it imports this, never the other way.
 */

/** Why the guard is not clean: what holds a version that is due to leave. */
export const RetirementReason = z
  .enum(["unrotatable", "incomplete-coverage", "stale"])
  .describe(
    "`unrotatable` — an encrypted field rests outside D1, so nothing can prove it re-sealed. `incomplete-coverage` — a schema source the guard derives from was not read. `stale` — a row still holds an envelope or an index under a version due to leave.",
  );
export type RetirementReason = z.output<typeof RetirementReason>;

/** The guard's verdict, as the manifest's posture block reports it. */
export const RetirementVerdict = z
  .object({
    blocked: z.boolean().describe("Whether a version due to leave the window is being held live by one of `reasons`."),
    reasons: z
      .array(RetirementReason)
      .describe("Every reason the guard is not clean now, empty when it is. Read directly: never inferred."),
    liveVersions: z
      .number()
      .int()
      .nonnegative()
      .describe("How many field-key versions are live. Two is the normal state: current and previous."),
  })
  .describe("Whether the field key's oldest live version can be retired, and if not, why.");
export type RetirementVerdict = z.output<typeof RetirementVerdict>;

/** What the guard reads. */
export interface RetirementInput {
  /** Every live version, newest first. */
  versions: readonly number[];
  /** Rows still under any version due to leave, summed over every stamped envelope and index column. */
  stale: number;
  /** Whether every schema source the stamp derives from was read. */
  coverageComplete: boolean;
  /** How many encrypted fields rest outside D1. */
  unrotatable: number;
}

/**
 * The versions due to leave the window: every live version older than the newest two. Current and previous are the
 * normal state, and the previous version is still sealing rows lazily, so only an older one is due.
 */
export function versionsDue(versions: readonly number[]): number[] {
  return [...versions].sort((left, right) => right - left).slice(2);
}

/**
 * **The retirement guard.** Clean only when all three hold: the stale count is zero across every stamped envelope
 * and index column, coverage is complete, and no unrotatable field was observed. `blocked` is whether a version is
 * due and the guard is not clean. Retiring a version is the one irreversible act in the feature — every ciphertext
 * still under it becomes unopenable — so nothing short of clean retires one, and nothing implies it.
 */
export function retirementVerdict(input: RetirementInput): RetirementVerdict {
  const reasons: RetirementReason[] = [];
  if (input.unrotatable > 0) reasons.push("unrotatable");
  if (!input.coverageComplete) reasons.push("incomplete-coverage");
  if (input.stale > 0) reasons.push("stale");
  return {
    blocked: versionsDue(input.versions).length > 0 && reasons.length > 0,
    reasons,
    liveVersions: input.versions.length,
  };
}

/** Whether a verdict lets the rotator retire: nothing at all holds a version. */
export function guardIsClean(verdict: RetirementVerdict): boolean {
  return verdict.reasons.length === 0;
}
