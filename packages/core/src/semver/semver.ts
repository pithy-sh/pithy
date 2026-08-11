// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Semantic versions: one parse, one format, one order.
 *
 * Anything that has to *rank* versions needs semver §11.4 — order a release feed, decide what sits
 * between installed and latest, sort a prerelease against the stable it precedes. §11.4 is short and
 * every clause of it is a trap: numeric identifiers compare numerically and alphanumerics compare
 * lexically, a numeric identifier ranks *below* an alphanumeric one, a longer identifier set wins when
 * every shared identifier is equal, and a stable outranks every prerelease of the same core. Each of
 * those is one line to get wrong, and getting one wrong shows up as a feed in the wrong order rather
 * than as an error.
 *
 * So it lives here once. The kit's update notifier uses it and ignores the prerelease field, which is
 * the narrowness it wants rather than a second implementation.
 *
 * **The parse is a split, not a string.** A version held as one string compares as text, and text puts
 * `1.10.0` below `1.9.0`. Split into numbers, the core comparison is three integer comparisons — and
 * for an adopter storing versions in SQLite, three integer columns are a row-value predicate
 * (`(major, minor, patch) > (?, ?, ?)`) that the database orders correctly on its own. SQL cannot
 * express prerelease precedence in that predicate, so a query built that way over-selects a stable
 * against a prerelease of the same core and {@link compareSemver} settles it in app code.
 */

import { z } from "zod";

/** The largest version part that survives a round trip through a number. */
const MAX_PART = Number.MAX_SAFE_INTEGER;

/**
 * Semver's grammar, minus what carries no order. Build metadata (`+sha`) is matched so it can be
 * discarded: the spec excludes it from precedence, so keeping it would imply an ordering it does not
 * have. A leading `v` is tolerated because tags and changelogs carry one.
 */
const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const Semver = z
  .object({
    major: z.number().int().nonnegative().describe("The major version. A breaking change increments it."),
    minor: z.number().int().nonnegative().describe("The minor version. A backwards-compatible feature increments it."),
    patch: z.number().int().nonnegative().describe("The patch version. A backwards-compatible fix increments it."),
    prerelease: z
      .string()
      .nullable()
      .describe(
        "The prerelease tag without its leading hyphen (`rc.1`), or null for a stable release. Null sorts above any prerelease of the same core.",
      ),
  })
  .describe(
    "A semantic version split into its parts. Three numbers a database can compare as a row value, plus the prerelease tag that only `compareSemver` can order.",
  );
export type Semver = z.output<typeof Semver>;

/** How far behind a version is, in each place. */
export const SemverGap = z
  .object({
    major: z.number().int().nonnegative().describe("How many major versions have been published since."),
    minor: z.number().int().nonnegative().describe("How many minor versions have accrued within the current major."),
    patch: z.number().int().nonnegative().describe("How many patch versions have accrued within the current minor."),
  })
  .describe(
    "How far an installed version is behind the latest one, counted in version places. Three counts and nothing else, so two versions with the same core are zero apart here however their prereleases rank — that difference is precedence, and `compareSemver` is what answers it.",
  );
export type SemverGap = z.output<typeof SemverGap>;

/** Parse a version string into its parts. Returns null for anything that is not a version. */
export function parseSemver(value: string): Semver | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  const parts = [Number(major), Number(minor), Number(patch)] as const;
  // A part past a safe integer cannot round-trip, and silently truncating one would make the
  // comparison lie. Refuse it as unparseable instead.
  if (parts.some((part) => part > MAX_PART)) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2], prerelease: prerelease ?? null };
}

/** Render a parsed version back to its canonical string. */
export function formatSemver(version: Semver): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease === null ? core : `${core}-${version.prerelease}`;
}

/** Compare two dot-separated prerelease identifiers, per semver §11.4. */
function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  // Numeric identifiers compare numerically and always rank below alphanumeric ones. As digit strings
  // rather than through `Number`, because an identifier is not bounded the way `MAX_PART` bounds the
  // core: above 2^53 two distinct identifiers round to the same float and compare equal, which would
  // leave a `latest` decided by whatever order the rows arrived in. The grammar forbids a leading zero,
  // so more digits is a larger number and equal lengths order lexicographically.
  if (aNumeric && bNumeric) {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two prerelease tags. A larger set of identifiers wins when every shared one is equal. */
function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ordered = comparePrereleaseIdentifier(l, r);
    if (ordered !== 0) return ordered;
  }
  return 0;
}

/**
 * Compare two versions by semver precedence. Negative when `a` precedes `b`. Suitable as an
 * `Array.prototype.sort` comparator, so it accepts the nulls {@link parseSemver} returns — an
 * unparseable version sorts below every real one rather than throwing mid-sort.
 */
export function compareSemver(a: Semver | null, b: Semver | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  // Stable outranks any prerelease of the same core.
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * How far `installed` is behind `latest`, per place.
 *
 * Each place counts only what accrued while the places above it stayed put, which is what makes the
 * number mean something: `1.2.3` against `1.6.1` is four minors and one patch behind, not four minors
 * and *negative two* patches. Somebody running something newer than we know about is ahead, not behind,
 * so the gap floors at zero rather than going negative.
 *
 * **A zero gap is not a claim of being current.** Two versions with the same core sit zero places apart
 * whatever their prereleases say, so `1.2.3-rc.1` against `1.2.3` measures zero even though it precedes
 * it. That is the shape being honest about its limits rather than a bug to paper over: counting places
 * cannot express a prerelease, {@link compareSemver} is what ranks them, and inventing a phantom patch
 * here would put a number on screen that no release actually carries.
 */
export function semverGap(installed: Semver, latest: Semver): SemverGap {
  if (compareSemver(installed, latest) >= 0) return { major: 0, minor: 0, patch: 0 };
  const major = Math.max(0, latest.major - installed.major);
  const minor = major > 0 ? latest.minor : Math.max(0, latest.minor - installed.minor);
  const patch = major > 0 || minor > 0 ? latest.patch : Math.max(0, latest.patch - installed.patch);
  return { major, minor, patch };
}
