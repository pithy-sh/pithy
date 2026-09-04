// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { Bump, SnapshotEntry } from "./changesets";
import { splitVersion } from "./version";

/**
 * What a release *was*, as data — the record the dashboard answers "am I exposed" from.
 *
 * A Changeset carries a semver bump and a prose summary, and neither says whether a release **matters**.
 * A patch closing a token-reuse hole and a patch fixing a log typo are both `patch`. This is the shape
 * that keeps the difference, recorded at the one moment it is cheap: while the release is being written,
 * rather than reconstructed under pressure two years later when a customer asks.
 *
 * ## Why the version arrives already split
 *
 * `major`, `minor` and `patch` are columns beside the string, so `pithy-sh/dashboard#2` compares with one
 * row-value predicate instead of parsing semver in SQL, and "two major and one patch behind" needs the
 * components anyway. The release step has just run `changeset version` and already holds the string, so
 * splitting it there is free — and it is the only place the split is guaranteed to describe the version
 * that was actually published. The schema refuses a record whose components contradict its own string,
 * because a client acts on those columns: a drifted split reports a customer current against a version
 * they are not running.
 *
 * ## Keyed on the package, because that is what makes the answer honest
 *
 * A project composes some capabilities and not others. Compared project-wide, an adopter is told they
 * are five versions behind counting packages they never installed — and worse, told they are exposed to
 * a fix in code they do not run. Two of those and the warning is noise. So a record is per package, the
 * manifest in #89 is per package, and the join between them is the package name.
 *
 * That same key answers the reverse question, which is the one that matters to us: *which customers are
 * exposed to what we just fixed* is a lookup of one package across connected manifests. An aggregate
 * version makes it unanswerable.
 *
 * ## What `null` means, in each of the three places it appears
 *
 * `prerelease: null` — a normal release. `exposure: null` — nothing was flagged. `note: null` — the
 * package moved because something it depends on moved, and carries no note of its own. That last one is
 * a release an adopter can still be behind, so it is recorded rather than dropped; dropping it would
 * under-report the gap, which is the failure this record exists to prevent.
 *
 * **Absence is never safety.** Releases cut before this convention existed carry no flag, and the
 * dashboard says exactly that rather than implying they were clean.
 */

/** The semver level a release turned out to be, derived from the versions rather than the request. */
const BumpLevel = z
  .enum(["major", "minor", "patch"])
  .describe("The semver level this release turned out to be, derived from the published versions.");

/** One package's release, in the shape `pithy-sh/dashboard#2` stores. */
export const ReleaseRecord = z
  .object({
    package: z.string().min(1).describe("The npm package name this release belongs to, e.g. `@pithy-sh/auth`."),
    version: z.string().min(1).describe("The version exactly as published — the string an adopter's lockfile holds."),
    major: z.number().int().min(0).describe("The major component, so a comparison is a column predicate."),
    minor: z.number().int().min(0).describe("The minor component, so a comparison is a column predicate."),
    patch: z.number().int().min(0).describe("The patch component, so a comparison is a column predicate."),
    prerelease: z.string().min(1).nullable().describe("The prerelease tag (`beta.3`), or null for a normal release."),
    bump: BumpLevel,
    published: z.iso.datetime().describe("When the release was published, ISO-8601 in UTC."),
    note: z
      .string()
      .min(1)
      .nullable()
      .describe("The release note as it reads in the changelog, or null when the package moved only with its deps."),
    security: z.boolean().describe("Whether this release closed something security-relevant."),
    exposure: z
      .string()
      .min(1)
      .nullable()
      .describe("What the exposure was before this release — the sentence a customer decides on. Null when unflagged."),
  })
  .refine((record) => splitVersion(record.version).major === record.major, {
    error: "major does not match the published version",
    path: ["major"],
  })
  .refine((record) => splitVersion(record.version).minor === record.minor, {
    error: "minor does not match the published version",
    path: ["minor"],
  })
  .refine((record) => splitVersion(record.version).patch === record.patch, {
    error: "patch does not match the published version",
    path: ["patch"],
  })
  .refine((record) => splitVersion(record.version).prerelease === record.prerelease, {
    error: "prerelease does not match the published version",
    path: ["prerelease"],
  })
  // An exposure without a flag is a record nobody would find by asking the question it answers.
  .refine((record) => record.security || record.exposure === null, {
    error: "an exposure belongs to a flagged release",
    path: ["exposure"],
  })
  .describe("One package's release, as the data a dashboard answers `am I exposed` from.");

/** One package's release. */
export type ReleaseRecord = z.infer<typeof ReleaseRecord>;

/** What {@link joinRecords} needs: the changesets as they were, and the versions either side of them. */
export interface JoinOptions {
  /** Every changeset, read **before** `changeset version` consumed them. */
  snapshot: SnapshotEntry[];
  /** Package name → version, as the manifests read before `changeset version`. */
  before: Map<string, string>;
  /** Package name → version, as the manifests read after it. */
  after: Map<string, string>;
  /** When the release was published. */
  published: Date;
}

/**
 * Which level a release turned out to be.
 *
 * Derived from the versions, never from the bumps the changesets asked for, because the two genuinely
 * disagree: a `fixed` group promotes a member's patch to the group's minor, and only the published
 * version is what an adopter's lockfile will hold. Deriving it also means the field cannot contradict
 * the components beside it.
 */
function bumpBetween(before: string | undefined, after: string): Bump {
  const to = splitVersion(after);
  // A package with no previous version is its first publish. `0.1.0` from nothing reads as the minor
  // it is; treating it as major would report every package in a first release as a breaking change.
  const from = before === undefined ? { major: 0, minor: 0, patch: 0 } : splitVersion(before);
  if (to.major !== from.major) return "major";
  if (to.minor !== from.minor) return "minor";
  return "patch";
}

/**
 * Join a paragraph list into one field.
 *
 * **Sorted**, and that is what makes a replayed record byte-identical to the live one. A release with
 * several changesets has several notes, and the two paths meet them in different orders — this one in
 * filename order, `changelog.ts` in whatever order Changesets wrote the sections. Neither order means
 * anything (Changesets' is map iteration order), so ordering them the same way costs nothing and buys
 * the property #92 asks for by name: what replay recovers equals what the live write would have sent.
 */
function paragraphs(values: string[]): string | null {
  return values.length === 0 ? null : [...values].sort().join("\n\n");
}

/**
 * Join the snapshot to the versions, into one record per package that was actually released.
 *
 * **Both halves, and in this order.** The changeset summaries live only in `.changeset/*.md`, which
 * `changeset version` deletes; the versions exist only after it has run. So the caller snapshots, then
 * versions, then reads back, then calls this. Parsing the CHANGELOG diff instead would avoid the
 * ordering dance and be fragile — that path exists, in `changelog.ts`, and it is the recovery path
 * rather than this one.
 */
export function joinRecords(options: JoinOptions): ReleaseRecord[] {
  const published = options.published.toISOString();

  // A package can be named by any number of changesets, and they all describe the one version that
  // ships. So the notes are gathered per package rather than per changeset — which is also what makes
  // a record idempotent under the replay in `changelog.ts`, keyed on package and version.
  const notes = new Map<string, string[]>();
  const exposures = new Map<string, string[]>();
  for (const entry of options.snapshot) {
    for (const { name } of entry.bumps) {
      notes.set(name, [...(notes.get(name) ?? []), entry.note]);
      if (entry.exposure !== null) {
        exposures.set(name, [...(exposures.get(name) ?? []), entry.exposure]);
      }
    }
  }

  const records: ReleaseRecord[] = [];
  for (const name of [...options.after.keys()].sort()) {
    const after = options.after.get(name) as string;
    const before = options.before.get(name);
    // Nothing moved, nothing released. A run over the whole workspace sees every package; only the
    // ones whose version actually changed have a release to record.
    if (before === after) continue;

    let split: ReturnType<typeof splitVersion>;
    try {
      split = splitVersion(after);
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const exposure = paragraphs(exposures.get(name) ?? []);
    records.push({
      package: name,
      ...split,
      bump: bumpBetween(before, after),
      published,
      note: paragraphs(notes.get(name) ?? []),
      security: exposure !== null,
      exposure,
    });
  }
  return records;
}
