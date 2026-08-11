// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Version comparison for the update notifier — the core semver primitive, deliberately narrowed.
 *
 * `@pithy-sh/core/src/semver/semver` parses and orders full semver, prereleases included. This module
 * keeps only `major.minor.patch`, because the notifier decides between "notify" and "stay quiet", not
 * which prerelease channel somebody is on: nagging a user on the stable channel about an `rc.1` is the
 * defect, and dropping the prerelease field is how it is prevented (docs/CLI.md §5).
 *
 * The narrowing is here rather than in the primitive, so the one place that wants it is the one place
 * that has it.
 */

import { compareSemver, parseSemver } from "@pithy-sh/core/src/semver/semver";

/** The kind of version gap between the installed CLI and the latest published one. */
export type Bump = "none" | "patch" | "minor" | "major";

/** A parsed semver triple; `null` when the string isn't a recognizable `x.y.z`. */
interface Parsed {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `x.y.z` (leading `v` and any `-prerelease`/`+build` suffix ignored). `null` when unparseable. */
export function parseVersion(version: string): Parsed | null {
  const parsed = parseSemver(version);
  if (!parsed) return null;
  // The prerelease is dropped here rather than carried and ignored downstream. A `Parsed` that held it
  // would be a `Parsed` some later caller compared, which is the nagging this module exists to avoid.
  return { major: parsed.major, minor: parsed.minor, patch: parsed.patch };
}

/** `-1 | 0 | 1` for `a` vs `b`. Unparseable versions sort as equal (the safe, quiet default). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const order = compareSemver({ ...pa, prerelease: null }, { ...pb, prerelease: null });
  return order === 0 ? 0 : order > 0 ? 1 : -1;
}

/**
 * Classify the gap from `installed` to `latest`. `none` when the installed version is at or ahead of the
 * latest (nothing to offer). Otherwise the highest-order component that changed: a new major is `major`,
 * a new minor within the same major is `minor`, anything else is `patch`. An unparseable pair is `none`.
 */
export function classifyBump(installed: string, latest: string): Bump {
  const from = parseVersion(installed);
  const to = parseVersion(latest);
  if (!from || !to) return "none";
  if (compareVersions(latest, installed) <= 0) return "none";
  if (to.major > from.major) return "major";
  if (to.minor > from.minor) return "minor";
  return "patch";
}
