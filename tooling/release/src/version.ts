// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * A published version, split into the components a comparison needs.
 *
 * The dashboard stores `major`, `minor` and `patch` as columns beside the version string, so "two major
 * and one patch behind" is one row-value predicate rather than semver logic in SQL. The release step has
 * just run `changeset version`, so it already holds the string — splitting it there is free, and it is
 * the only place the split is guaranteed to describe the version that was actually published.
 *
 * **A split that disagrees with its string is worse than no split**, because a client acts on it: it
 * would report a customer current against a version they are not running. So this is the strict half of
 * the contract — anything that is not a semver release version is refused rather than coerced, and
 * `records.test.ts` holds the split against the string it came from.
 */

/** The semver grammar, minus the ranges and wildcards npm accepts elsewhere. Leading zeroes refused. */
const SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** One version, as the string that was published and as the numbers a comparison keys on. */
export interface SplitVersion {
  /** The version exactly as published — the string an adopter's lockfile holds. */
  version: string;
  /** The major component. */
  major: number;
  /** The minor component. */
  minor: number;
  /** The patch component. */
  patch: number;
  /** The prerelease tag (`beta.3`), or `null` for a normal release. Build metadata is not part of it. */
  prerelease: string | null;
}

/** Split a published version string. Throws on anything that is not one. */
export function splitVersion(version: string): SplitVersion {
  const match = SEMVER.exec(version);
  if (!match?.groups) {
    throw new Error(`not a semver version: ${JSON.stringify(version)}`);
  }
  const { major, minor, patch, prerelease } = match.groups;
  return {
    version,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    // Build metadata is deliberately dropped from the components and kept out of `prerelease`: semver
    // says it takes no part in precedence, and a comparison is the only thing these fields serve.
    prerelease: prerelease ?? null,
  };
}
