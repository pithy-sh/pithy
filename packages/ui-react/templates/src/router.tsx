import { type ComponentType, lazy, type ReactNode, Suspense, use, useEffect, useState } from "react";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The two globs below ARE the route registration. Do not edit them.
 *
 *   src/routes/pithy/   Pithy's screens. Pithy writes only here, and only files that do not exist.
 *   src/routes/app/     Yours. Pithy never writes here.
 *
 * Dropping a file in registers it: no manifest, no command to re-run, HMR picks it up. Each module
 * declares its own path, so filenames encode no routing rules:
 *
 *   export const path = "/sign-in";
 *   export default SignIn;
 *
 * A segment may be a parameter — `export const path = "/invitations/:token"` — and the value arrives
 * as a typed `params` prop. See {@link ScreenProps} for how to declare it and {@link matchPattern} for
 * what matches.
 *
 * `app/` wins on a conflict — override a Pithy screen by putting your own file at the same path.
 *
 * The negations are not a preference. Tests are co-located here as everywhere else, so `home.test.tsx`
 * sits beside `home.tsx` — and without them that file is a route: bundled, served, and readable by
 * anyone, fixtures and stub tokens included. `.test.` and `.spec.` are the test runner's own names for
 * its own files, not a list this router invented. The runtime check on `path` below cannot stand in for
 * them: by the time it runs, the glob has already pulled the module into the bundle.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const pithyRoutes = import.meta.glob<RouteModule>([
  "./routes/pithy/**/*.tsx",
  "!./routes/pithy/**/*.test.tsx",
  "!./routes/pithy/**/*.spec.tsx",
]);
const appRoutes = import.meta.glob<RouteModule>([
  "./routes/app/**/*.tsx",
  "!./routes/app/**/*.test.tsx",
  "!./routes/app/**/*.spec.tsx",
]);

// The session module is optional: it exists only in the auth template. Globbing it (rather than
// importing it) is what lets this file be byte-identical in every template. The payments module is
// globbed for the same reason, and answers the entitlement guard below.
const sessionModules = import.meta.glob<{ getSession: () => Promise<unknown> }>("./session.tsx");
const paymentsModules = import.meta.glob<{ holdsEntitlement: (key: string) => Promise<boolean> }>("./payments.tsx");

/** Where the guard sends a signed-out visitor. */
const SIGN_IN_PATH = "/sign-in";

/** Where the entitlement guard sends a visitor who does not hold what a screen asks for. */
const PAYWALL_PATH = "/paywall";

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
 *   return <p>{params.token}</p>;
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
}

/** One resolved entry in the route table. */
interface Route {
  component: ComponentType<ScreenProps>;
  session?: "required" | undefined;
  entitlement?: string | undefined;
}

/** The resolved route table: every declared pattern, and the route each one names. */
interface RouteTable {
  /**
   * Every declared pattern, in no significant order. {@link matchPath} does not depend on one — see
   * the note there about why the winner is chosen rather than stumbled into.
   */
  readonly patterns: readonly string[];
  readonly byPattern: ReadonlyMap<string, Route>;
}

/**
 * The route table, resolved once. Each module is loaded to read its `path` export, then rendered
 * through `React.lazy` so the render path stays suspense-driven and HMR swaps a screen in place.
 * Pithy's routes are registered first and the app's second, so the app's overwrite on a conflict.
 *
 * Shadowing is by pattern equality, which is why the map is keyed on the declared string rather than
 * on anything derived: `/invitations/:token` in `app/` replaces `/invitations/:token` in `pithy/`,
 * and `/invitations/:id` is a different route that happens to match the same paths.
 */
async function buildRoutes(): Promise<RouteTable> {
  const byPattern = new Map<string, Route>();
  for (const group of [pithyRoutes, appRoutes]) {
    for (const load of Object.values(group)) {
      const module = await load();
      if (typeof module.path !== "string") continue;
      byPattern.set(module.path, { component: lazy(load), session: module.session, entitlement: module.entitlement });
    }
  }
  return { patterns: [...byPattern.keys()], byPattern };
}

const routes = buildRoutes();

// ── history ──────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

window.addEventListener("popstate", notify);

/** Go to `to` without a page load. */
export function navigate(to: string): void {
  if (to === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", to);
  notify();
}

/** The current pathname, re-rendering the subscriber on every navigation. */
export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const listener = () => setPath(window.location.pathname);
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return path;
}

/** An in-app link. Modifier-clicks and middle-clicks fall through to the browser, so a new tab works. */
export function Link(props: { to: string; className?: string; children: ReactNode }): ReactNode {
  return (
    <a
      href={props.to}
      className={props.className}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(props.to);
      }}
    >
      {props.children}
    </a>
  );
}

// ── guard ────────────────────────────────────────────────────────────────────

/** Is there a session? True when no session module exists, so the bare template renders everything. */
async function isSignedIn(): Promise<boolean> {
  const load = Object.values(sessionModules)[0];
  if (!load) return true;
  return (await (await load()).getSession()) !== null;
}

/** Renders its children only for a signed-in visitor; everyone else is sent to the sign-in screen. */
function Guarded(props: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<"checking" | "in" | "out">("checking");

  useEffect(() => {
    let live = true;
    void isSignedIn().then((signedIn) => {
      if (live) setState(signedIn ? "in" : "out");
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (state === "out") navigate(SIGN_IN_PATH);
  }, [state]);

  if (state === "in") return props.children;
  return <p className="muted">One moment.</p>;
}

/** Does the visitor hold `key`? True when no payments module exists, so a guard cannot lock a screen shut. */
async function holdsEntitlement(key: string): Promise<boolean> {
  const load = Object.values(paymentsModules)[0];
  if (!load) return true;
  return (await load()).holdsEntitlement(key);
}

/**
 * Renders its children only for a visitor holding `entitlement`; everyone else is sent to the paywall.
 *
 * **A UX affordance, never a security boundary.** The server's `requireEntitlement()` is the boundary —
 * every paid route checks it, and no answer here can change that. This exists so a visitor without `pro`
 * arrives at the paywall instead of watching a screen fill with 403s.
 */
function Entitled(props: { entitlement: string; children: ReactNode }): ReactNode {
  const [state, setState] = useState<"checking" | "in" | "out">("checking");

  useEffect(() => {
    let live = true;
    void holdsEntitlement(props.entitlement).then((held) => {
      if (live) setState(held ? "in" : "out");
    });
    return () => {
      live = false;
    };
  }, [props.entitlement]);

  useEffect(() => {
    if (state === "out") navigate(PAYWALL_PATH);
  }, [state]);

  if (state === "in") return props.children;
  return <p className="muted">One moment.</p>;
}

// ── matching ─────────────────────────────────────────────────────────────────

/** Is `segment` a parameter? A bare `":"` names nothing, so it is a literal like any other. */
function isParameter(segment: string): boolean {
  return segment.startsWith(":") && segment.length > 1;
}

/**
 * Match `path` against `pattern`, returning the decoded parameters — or `null` when it does not match.
 *
 * Both sides are split on `/` and compared segment for segment, so a pattern only ever matches a path
 * with the same number of segments. That is what keeps this one level deep: there is no wildcard to
 * swallow a tail with, and `/a` therefore does not answer `/a/b` any more than it did before.
 *
 * Three decisions live here, and each one is a decision rather than a consequence.
 *
 * **A parameter captures at least one character.** `/invitations/` has an empty last segment, so
 * `/invitations/:token` does not match it and the visitor gets the not-found screen rather than a
 * screen holding an empty token. The same rule makes `//` inert.
 *
 * **Decoding happens once, here.** `window.location.pathname` keeps its percent-encoding, so the value
 * is decoded on the way out and no screen has to remember to. Splitting before decoding is what makes
 * `%2F` a slash *inside* one value rather than a segment boundary — an id containing a slash survives
 * the round trip.
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
 * this picks the same one every time instead of picking by whichever file the glob reached first.
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

// ── router ───────────────────────────────────────────────────────────────────

function Screen(): ReactNode {
  const table = use(routes);
  const path = usePath();
  const match = matchPath(table.patterns, path);
  const route = match ? table.byPattern.get(match.pattern) : undefined;

  if (!match || !route) {
    return (
      <main className="screen">
        <h1>Not here.</h1>
        <p className="muted">
          Nothing answers {path}. <Link to="/">Go home</Link>.
        </p>
      </main>
    );
  }

  const Component = route.component;
  const params = match.params;
  // An entitlement belongs to somebody, so asking for one implies a session — the same order the server
  // declares it in, `requireAuth()` then `requireEntitlement()`. Session outside, entitlement inside.
  const screen = route.entitlement ? (
    <Entitled entitlement={route.entitlement}>
      <Component params={params} />
    </Entitled>
  ) : (
    <Component params={params} />
  );
  return route.session === "required" || route.entitlement ? <Guarded>{screen}</Guarded> : screen;
}

/** Mount this once. It resolves the route table, then renders the screen for the current path. */
export function Router(): ReactNode {
  return (
    <Suspense fallback={<p className="muted">One moment.</p>}>
      <Screen />
    </Suspense>
  );
}
