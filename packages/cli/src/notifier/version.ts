// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * Semver comparison for the update notifier — hand-rolled so the CLI adds no dependency for a three-number
 * compare (docs/CLI.md §5). Only `major.minor.patch` is significant here: a prerelease or build suffix is
 * dropped before comparing, because the notifier decides between "notify" and "stay quiet", not which
 * prerelease channel a user is on.
 */

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
  const core = version.trim().replace(/^v/, "").split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  const [major, minor, patch] = parts.map((part) => Number(part));
  if (major === undefined || minor === undefined || patch === undefined) return null;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return null;
  return { major, minor, patch };
}

/** `-1 | 0 | 1` for `a` vs `b`. Unparseable versions sort as equal (the safe, quiet default). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] > pb[key]) return 1;
    if (pa[key] < pb[key]) return -1;
  }
  return 0;
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
