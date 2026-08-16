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

/**
 * The jobs one screen has to be able to name another screen for.
 *
 * **A role is how a redirect target — or a link — stays one statement.** The guard needs somewhere to
 * send a signed-out visitor, and the only honest source for that is the screen itself: it claims the
 * job (`export const role = "sign-in"`) and everything pointing at it looks the path up. Renaming
 * `/sign-in` to `/login` is an ordinary rebrand, and before this the router kept its own copy of the
 * old string — it typechecked, it built, and it redirected to the not-found screen (#393).
 *
 * A `<Link to="/paywall">` in another screen was the same defect with a quieter symptom, so the same
 * three names cover both.
 *
 * Claim one from `src/routes/app/` to take the job over — the same shadowing rule as a path.
 */
export type ScreenRole = "sign-in" | "paywall" | "subscription";

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
  /** The job this screen does for a guard, if it does one. See {@link ScreenRole}. */
  role?: ScreenRole;
}

/** One resolved entry in the route table. */
interface Route {
  component: ComponentType<ScreenProps>;
  session?: "required" | undefined;
  entitlement?: string | undefined;
}

/** The resolved route table: every declared pattern, and the route each one names. */
export interface RouteTable {
  /**
   * Every declared pattern, in no significant order. {@link matchPath} does not depend on one — see
   * the note there about why the winner is chosen rather than stumbled into.
   */
  readonly patterns: readonly string[];
  readonly byPattern: ReadonlyMap<string, Route>;
  /** The path of the screen claiming each {@link ScreenRole}. Read by {@link screenPath}. */
  readonly byRole: ReadonlyMap<ScreenRole, string>;
}

/**
 * Where a guard sends a visitor for `role` — the path the screen claiming that job declares.
 *
 * **It throws rather than falling back.** A guard with nowhere to send someone is a screen that never
 * resolves, and the whole point of #393 is that this class of break must not be silent. The message
 * names the export to add and the file to add it to.
 */
export function screenPath(table: RouteTable, role: ScreenRole): string {
  const path = table.byRole.get(role);
  if (path === undefined) {
    throw new Error(`No screen claims the "${role}" role. Add \`export const role = "${role}"\` to the one that does.`);
  }
  return path;
}

/**
 * The route table, resolved once. Each module is loaded to read its `path` export, then rendered
 * through `React.lazy` so the render path stays suspense-driven and HMR swaps a screen in place.
 * Pithy's routes are registered first and the app's second, so the app's overwrite on a conflict.
 *
 * Shadowing is by pattern equality, which is why the map is keyed on the declared string rather than
 * on anything derived: `/invitations/:token` in `app/` replaces `/invitations/:token` in `pithy/`,
 * and `/invitations/:id` is a different route that happens to match the same paths.
 *
 * **The loaders are a parameter rather than the two globs read directly, so a gate can drive this with
 * a screen it names.** That is the whole of what `src/router.test.tsx` needs to prove a redirect target
 * comes from the screen and not from a copy the router keeps.
 */
export async function buildRoutes(loaders: Iterable<() => Promise<RouteModule>>): Promise<RouteTable> {
  const byPattern = new Map<string, Route>();
  const byRole = new Map<ScreenRole, string>();
  for (const load of loaders) {
    const module = await load();
    if (typeof module.path !== "string") continue;
    byPattern.set(module.path, { component: lazy(load), session: module.session, entitlement: module.entitlement });
    // A role is registered against the path the module declares, in the same order as the patterns, so
    // a screen in `app/` takes the job over exactly as it takes a pattern over.
    if (module.role) byRole.set(module.role, module.path);
  }
  return { patterns: [...byPattern.keys()], byPattern, byRole };
}

let resolved: Promise<RouteTable> | null = null;

/**
 * The route table, resolved once, on first use.
 *
 * **A function rather than a module-scope constant, because resolving it loads every screen.** As a
 * constant, importing this file for `navigate` alone pulled the whole route graph in and started a
 * promise nothing was awaiting yet — a screen that failed to load became an unhandled rejection at
 * page load, outside any error boundary, rather than an error `use()` hands to React. It also made a
 * co-located test of the router drag every screen in the project into its own module graph.
 *
 * Exported so a gate can read what the guards read, rather than restating it. `screenPath` is the
 * whole of what a guard asks of it.
 */
export function routeTable(): Promise<RouteTable> {
  resolved ??= buildRoutes([...Object.values(pithyRoutes), ...Object.values(appRoutes)]);
  return resolved;
}

/**
 * The path of the screen claiming `role`, for a screen that has to point at the same place a guard
 * would send someone — a "sign in to buy" link, a "see what else there is" link.
 *
 * Suspends until the route table resolves, which inside `Router` it already has. A `<Link to="…">`
 * written as a literal is the same defect as a redirect written as one: it survives the rename and
 * lands on the not-found screen.
 */
export function useScreenPath(role: ScreenRole): string {
  return screenPath(use(routeTable()), role);
}

/**
 * The same, for a link that crosses a capability boundary — `null` when no screen claims the role.
 *
 * The pricing screen is the case: it ships in a payments-only project, where there is no sign-in screen
 * to offer a stranger and nothing to link to. Throwing there would be wrong, and a literal `/sign-in`
 * would point at nothing. So the link is rendered when there is somewhere for it to go.
 */
export function useOptionalScreenPath(role: ScreenRole): string | null {
  return use(routeTable()).byRole.get(role) ?? null;
}

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

/**
 * Whether there is a session — `null` while the read is in flight.
 *
 * Exported because a *public* screen can need the same answer without being guarded by it. A pricing
 * page is the case: anyone may read a price, and only an account may buy, so the screen has to know
 * which visitor it is drawing a button for. Reading it here rather than importing `./session` is what
 * lets such a screen ship in a payments-only scaffold, where that module does not exist — the glob
 * above answers "no auth composed" as signed in, and the screen renders as it did before auth was a
 * question.
 *
 * Three states, not two. `null` is "we have not asked yet", and collapsing it into `false` would flash
 * a signed-out affordance at every returning customer for one frame.
 */
export function useSignedIn(): boolean | null {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void isSignedIn().then((answer) => {
      if (live) setSignedIn(answer);
    });
    return () => {
      live = false;
    };
  }, []);

  return signedIn;
}

/** Renders its children only for a signed-in visitor; everyone else is sent to the sign-in screen. */
function Guarded(props: { children: ReactNode }): ReactNode {
  const table = use(routeTable());
  const signedIn = useSignedIn();

  useEffect(() => {
    if (signedIn === false) navigate(screenPath(table, "sign-in"));
  }, [signedIn, table]);

  if (signedIn === true) return props.children;
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
  const table = use(routeTable());
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
    if (state === "out") navigate(screenPath(table, "paywall"));
  }, [state, table]);

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
  const table = use(routeTable());
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
