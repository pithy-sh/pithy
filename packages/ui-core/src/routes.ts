// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type ComponentType, lazy } from "react";

/**
 * The jobs one screen has to be able to name another screen for.
 *
 * **A role is how a redirect target — or a link — stays one statement.** The guard needs somewhere to
 * send a signed-out visitor, and the only honest source for that is the screen itself: it claims the
 * job (`export const role = "sign-in"`) and everything pointing at it looks the path up, so renaming
 * `/sign-in` to `/login` moves every redirect and every link with it. A literal path in a guard or a
 * link would still typecheck and build after a rename, and land on the not-found screen.
 *
 * `consent` is the privacy-choices screen, so a "your privacy choices" link in a footer names the job and not
 * `/consent`.
 *
 * Claim one from the app's own screens to take the job over — the same shadowing rule as a path.
 */
export type ScreenRole =
  | "sign-in"
  | "paywall"
  | "subscription"
  | "account-suspended"
  | "account-deleted"
  | "organization-suspended"
  | "consent";

/**
 * The parameter names a pattern declares. `"/invitations/:token"` gives `"token"`; a pattern with no
 * parameter gives `never`, which is an empty `params`.
 *
 * A segment is a parameter when it begins with `:` and has a name after it. Nothing else is special —
 * no wildcards, no optional segments, no nesting. That is the whole grammar.
 */
type ParameterNames<Pattern extends string> = Pattern extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParameterNames<Rest>
  : Pattern extends `${string}:${infer Name}`
    ? Name
    : never;

/**
 * The parameters a pattern yields, all of them strings.
 *
 * The `string extends Pattern` arm is for the router's own plumbing, where the pattern is only known
 * to be *a* string: there are no names to check then, so it widens to a bag rather than collapsing to
 * an empty object and rejecting every value.
 */
export type PathParameters<Pattern extends string> = string extends Pattern
  ? Readonly<Record<string, string>>
  : Readonly<Record<ParameterNames<Pattern>, string>>;

/**
 * What a screen is rendered with. Declare it against the screen's own `path` and the names are
 * checked — `params.tokne` is a compile error, not an `undefined` at runtime:
 *
 * ```tsx
 * export const path = "/invitations/:token";
 *
 * export default function Invitation({ params }: ScreenProps<typeof path>) {
 *   return <Text>{params.token}</Text>;
 * }
 * ```
 *
 * `typeof path` is what carries the names across, so the `path` export has to stay a `const` string
 * literal — which it already is in every screen the kit writes.
 */
export interface ScreenProps<Pattern extends string = string> {
  /** The values matched out of the path, percent-decoded once, by the router. */
  readonly params: PathParameters<Pattern>;
}

/** What a route module exports. `session` and `entitlement` are the two opt-ins. */
export interface RouteModule {
  /** The pattern this screen answers, e.g. `/sign-in` or `/invitations/:token`. */
  path: string;
  /** The screen itself. */
  default: ComponentType<ScreenProps>;
  /** Set to `"required"` to send signed-out visitors to the sign-in screen. */
  session?: "required";
  /** Set to an entitlement key to send visitors who do not hold it to the paywall. */
  entitlement?: string;
  /** The job this screen does for a guard, if it does one. See {@link ScreenRole}. */
  role?: ScreenRole;
}

/** One resolved entry in the route table. */
export interface Route {
  /** The screen, loaded on first render. */
  readonly component: ComponentType<ScreenProps>;
  /** `"required"` when a signed-out visitor is sent to the sign-in screen instead. */
  readonly session?: "required" | undefined;
  /** The entitlement a visitor must hold, or nothing. */
  readonly entitlement?: string | undefined;
}

/** The resolved route table: every declared pattern, and the route each one names. */
export interface RouteTable {
  /**
   * Every declared pattern, in no significant order. {@link matchPath} does not depend on one — see
   * the note there about why the winner is chosen rather than stumbled into.
   */
  readonly patterns: readonly string[];
  /** The route each declared pattern names. */
  readonly byPattern: ReadonlyMap<string, Route>;
  /** The path of the screen claiming each {@link ScreenRole}. Read by {@link screenPath}. */
  readonly byRole: ReadonlyMap<ScreenRole, string>;
}

/** Where a router's `<Redirect>` goes: a path, or the path of the screen claiming a {@link ScreenRole}, with an optional query. */
export type RedirectTarget = { readonly to: string } | { readonly screen: ScreenRole; readonly search?: string };

/**
 * Where a guard sends a visitor for `role` — the path the screen claiming that job declares.
 *
 * **It throws rather than falling back.** A guard with nowhere to send someone is a screen that never
 * resolves, and that break must not be silent. The message names the export to add and the file to add it to.
 */
export function screenPath(table: RouteTable, role: ScreenRole): string {
  const path = table.byRole.get(role);
  if (path === undefined) {
    throw new Error(`No screen claims the "${role}" role. Add \`export const role = "${role}"\` to the one that does.`);
  }
  return path;
}

/**
 * The route table, built from the loaders a router binding registers. Each module is loaded to read its `path`
 * export, then rendered through `React.lazy` so the render path stays suspense-driven and a screen can be swapped
 * in place. Later loaders overwrite earlier ones on a conflict, so a binding lists the kit's screens first and the
 * app's second.
 *
 * Shadowing is by pattern equality, which is why the map is keyed on the declared string rather than
 * on anything derived: `/invitations/:token` from the app replaces `/invitations/:token` from the kit,
 * and `/invitations/:id` is a different route that happens to match the same paths.
 *
 * **The loaders are a parameter, so the table does not care how they were found** — a Vite glob, a list a
 * bundler without one has written out, or a list a test names.
 */
export async function buildRoutes(loaders: Iterable<() => Promise<RouteModule>>): Promise<RouteTable> {
  const byPattern = new Map<string, Route>();
  const byRole = new Map<ScreenRole, string>();
  for (const load of loaders) {
    const module = await load();
    if (typeof module.path !== "string") continue;
    byPattern.set(module.path, { component: lazy(load), session: module.session, entitlement: module.entitlement });
    // A role is registered against the path the module declares, in the same order as the patterns, so
    // a screen of the app's takes the job over exactly as it takes a pattern over.
    if (module.role) byRole.set(module.role, module.path);
  }
  return { patterns: [...byPattern.keys()], byPattern, byRole };
}

/** Is `segment` a parameter? A bare `":"` names nothing, so it is a literal like any other. */
function isParameter(segment: string): boolean {
  return segment.startsWith(":") && segment.length > 1;
}

/**
 * Match `path` against `pattern`, returning the decoded parameters — or `null` when it does not match.
 *
 * Both sides are split on `/` and compared segment for segment, so a pattern only ever matches a path
 * with the same number of segments. That is what keeps this one level deep: there is no wildcard to
 * swallow a tail with, and `/a` therefore does not answer `/a/b`.
 *
 * Three decisions live here, and each one is a decision rather than a consequence.
 *
 * **A parameter captures at least one character.** `/invitations/` has an empty last segment, so
 * `/invitations/:token` does not match it and the visitor gets the not-found screen rather than a
 * screen holding an empty token. The same rule makes `//` inert.
 *
 * **Decoding happens once, here.** A path keeps its percent-encoding, so the value is decoded on the
 * way out and no screen has to remember to. Splitting before decoding is what makes `%2F` a slash
 * *inside* one value rather than a segment boundary — an id containing a slash survives the round trip.
 *
 * **A segment that will not decode does not match.** `%zz` throws in `decodeURIComponent`, and the
 * alternatives are worse: handing the screen the raw text moves the check into every screen, and
 * handing it an empty string invents a value nobody sent. A malformed encoding is not an identifier,
 * so the route simply does not answer and the not-found screen does.
 */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const declared = pattern.split("/");
  const actual = path.split("/");
  if (declared.length !== actual.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < declared.length; index++) {
    const segment = declared[index] ?? "";
    const value = actual[index] ?? "";
    if (!isParameter(segment)) {
      if (segment !== value) return null;
      continue;
    }
    if (value === "") return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return null;
    }
    params[segment.slice(1)] = decoded;
  }
  return params;
}

/**
 * Order two patterns by how specific they are, most specific first.
 *
 * **The rule: at the leftmost segment where two patterns differ in kind, the static one wins.** So
 * `/invitations/new` beats `/invitations/:token`, and `/orders/:id/receipt` beats `/orders/:id/:view`.
 * It is a comparison rather than a registration order because those are the two ways to answer the
 * question and only one of them can be written down: an adopter can read this rule, but nobody can
 * read the iteration order of two globs.
 *
 * The tail is a plain string comparison, which only matters for two patterns of the *same* shape —
 * `/a/:x` and `/a/:y`. Those are one route written twice, and no rule can pick the one that was meant;
 * this picks the same one every time instead of picking by whichever file was registered first.
 */
export function comparePatterns(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    const kind = Number(isParameter(left[index] ?? "")) - Number(isParameter(right[index] ?? ""));
    if (kind !== 0) return kind;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The pattern that answers `path`, with its decoded parameters — or `null` when nothing does.
 *
 * Every pattern is tried and the most specific match is kept, rather than the first match being
 * returned from a pre-sorted list. Both give the same answer; this one cannot stop giving it. A sorted
 * list has an invariant somebody has to maintain, and the failure when it lapses is a screen quietly
 * answering a path that belongs to another screen.
 */
export function matchPath(
  patterns: readonly string[],
  path: string,
): { pattern: string; params: Record<string, string> } | null {
  let best: { pattern: string; params: Record<string, string> } | null = null;
  for (const pattern of patterns) {
    const params = matchPattern(pattern, path);
    if (!params) continue;
    if (best === null || comparePatterns(pattern, best.pattern) < 0) best = { pattern, params };
  }
  return best;
}
