// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import type { AdminRoute } from "@pithy-sh/core/src/controlPlane/discovery/adminRoute";
import { z } from "zod";

/**
 * A declared admin route, in the form the reach statement matches a called path against (#828).
 *
 * The gate records the path as called — `/admin/users/u_8f2`, not `/admin/users/:userId` — so grouping a credential's
 * calls by what they did means matching each one back to the route that served it. That match runs in SQL, inside the
 * one statement, so the routes go in as one JSON parameter of these objects and SQLite compares each call against
 * them with `GLOB`.
 *
 * **A glob and a slash count, together.** A parameter becomes `*`, and `*` in a glob also matches `/`, so on its own
 * `/admin/users/*` would claim `/admin/users/u_8f2/sessions`. Requiring the called path to have exactly as many
 * slashes as the pattern closes that: the pattern's literal slashes already account for every one, so no `*` can
 * swallow another. A route ending in Hono's `*` wildcard matches any depth, and carries no count.
 */
export const ReachPattern = z
  .object({
    method: z.string().describe("The HTTP method the route answers on."),
    pattern: z.string().describe("The route as declared, with the capability's `basePath` applied."),
    glob: z.string().describe("The pattern as an SQLite `GLOB`: each parameter a `*`, each metacharacter escaped."),
    slashes: z
      .number()
      .int()
      .nullable()
      .describe("How many `/` a called path must hold to be this route, or null for a wildcard route of any depth."),
    params: z.number().int().describe("How many named parameters the route declares — the subjects it can name."),
    rank: z
      .number()
      .int()
      .describe("Which route wins when two match one path: the lower rank, so `/users/search` beats `/users/:id`."),
  })
  .describe("One declared admin route, ready for the reach statement to match called paths against.");
export type ReachPattern = z.infer<typeof ReachPattern>;

/** A segment that names a parameter, with Hono's optional `{regex}` and `?` after the name. */
const PARAM_SEGMENT = /^:([A-Za-z0-9_]+)(\{.*\})?\??$/;

/** One literal segment, with every `GLOB` metacharacter wrapped in a one-character class so it matches itself. */
function escapeGlob(segment: string): string {
  return segment.replace(/[*?[]/g, (char) => `[${char}]`);
}

/** How specific a route is: literal segments first, then fewer parameters, and a wildcard last. */
function specificity(path: string): [number, number, number] {
  const segments = path.split("/").slice(1);
  const params = segments.filter((segment) => PARAM_SEGMENT.test(segment)).length;
  const wildcard = segments.includes("*") ? 1 : 0;
  return [segments.length - params - wildcard, -params, -wildcard];
}

/**
 * Every declared route as a {@link ReachPattern}, most specific first, one per method and path.
 *
 * Ranked the way a router prefers a static segment to a parameter, so a call to `/admin/users/search` is the search
 * route and not a read of a user called `search`. Two routes of equal specificity cannot both match one path — they
 * differ in a literal segment — so the order between them never decides anything.
 */
export function reachPatterns(routes: readonly Pick<AdminRoute, "method" | "path">[]): ReachPattern[] {
  const unique = new Map<string, Pick<AdminRoute, "method" | "path">>();
  for (const route of routes) unique.set(`${route.method} ${route.path}`, route);
  const ordered = [...unique.values()].sort((a, b) => {
    const [x, y] = [specificity(a.path), specificity(b.path)];
    for (let i = 0; i < x.length; i++) {
      const difference = (y[i] as number) - (x[i] as number);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  return ordered.map((route, rank) => {
    const segments = route.path.split("/");
    const wildcard = segments.includes("*");
    return {
      method: route.method,
      pattern: route.path,
      glob: segments
        .map((segment) => (segment === "*" || PARAM_SEGMENT.test(segment) ? "*" : escapeGlob(segment)))
        .join("/"),
      slashes: wildcard ? null : segments.length - 1,
      params: segments.filter((segment) => PARAM_SEGMENT.test(segment)).length,
      rank,
    };
  });
}

/** One segment of a called path, decoded, or as called when it is not valid percent-encoding. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The value each of `pattern`'s parameters took in the called `path` — the subject ids a call touched.
 *
 * Read in the Worker rather than in SQL, and only for the rows a `subjects=true` read returns: the statement has
 * already narrowed them to one route, and splitting a path on `/` is not something SQLite does without a recursive
 * CTE per row. A path with a different number of segments names nothing.
 */
export function routeParams(pattern: string, path: string): Record<string, string> {
  const declared = pattern.split("/");
  const called = path.split("/");
  if (declared.length !== called.length) return {};
  const params: Record<string, string> = {};
  declared.forEach((segment, index) => {
    const name = PARAM_SEGMENT.exec(segment)?.[1];
    if (name !== undefined) params[name] = decodeSegment(called[index] as string);
  });
  return params;
}

/** A parameter name that names an id: `id` itself, or anything ending in `Id`. */
const ID_PARAM = /^id$|Id$/;

/**
 * The subject one call to `pattern` acted on, read from the called `path`.
 *
 * **The subject is the last parameter that names an id**, not the last parameter: on
 * `/accounts/:userId/:currency/transactions` the user is whose data was read, and the currency only narrows what was
 * read of them. A route none of whose parameters names an id falls back to its last one.
 *
 * **`key` tells subjects apart**: the values of the subject parameter and of every parameter before it. The same id
 * under another subject type or another organization is another subject — `/entitlements/user/s_1` and
 * `/entitlements/organization/s_1` are two holders — while the parameters after it are not part of who it is, so one
 * user's ledger read in two currencies is one subject. Both are null when the route declares no parameter, or the path
 * does not fit it.
 */
export function routeSubject(pattern: string, path: string): { subjectId: string | null; key: string | null } {
  const params = routeParams(pattern, path);
  const names = Object.keys(params);
  if (names.length === 0) return { subjectId: null, key: null };
  const ids = names.filter((name) => ID_PARAM.test(name));
  const subject = (ids[ids.length - 1] ?? names[names.length - 1]) as string;
  const qualifiers = names.slice(0, names.indexOf(subject) + 1);
  return { subjectId: params[subject] ?? null, key: JSON.stringify(qualifiers.map((name) => params[name])) };
}
