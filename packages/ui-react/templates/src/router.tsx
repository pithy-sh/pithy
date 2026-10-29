import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { Redirect as Navigate } from "@pithy-sh/ui-core/src/redirect";
import {
  buildRoutes,
  matchPath,
  type RedirectTarget,
  type RouteModule,
  type RouteTable,
  type ScreenRole,
  screenPath,
} from "@pithy-sh/ui-core/src/routes";
import { type ReactNode, Suspense, use, useSyncExternalStore } from "react";

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
 * as a typed `params` prop. `ScreenProps` and the matching rule are `@pithy-sh/ui-core/src/routes`:
 *
 *   import type { ScreenProps } from "@pithy-sh/ui-core/src/routes";
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

/**
 * Go to `to`, replacing the current history entry rather than pushing one.
 *
 * **For a correction the reader did not make** — a selection clamped back to nothing, a record that is
 * no longer there. Pushing one of those puts a state nobody chose into the back stack, and Back then
 * lands on it and it is corrected again, forever. A place the reader *chose* to go is a push, which is
 * why `<Link>` has no `replace` and always goes through `navigate`.
 *
 * The identical-URL guard is `navigate`'s, for the same reason: swapping an entry for itself is a
 * re-render nothing asked for.
 */
export function replace(to: string): void {
  if (to === window.location.pathname + window.location.search) return;
  window.history.replaceState(null, "", to);
  notify();
}

/**
 * Set or clear query parameters on the current URL, leaving the rest of it alone. Pushes by default;
 * pass `{ replace: true }` for a correction, as {@link replace} describes.
 *
 * State that belongs in the address bar but not in the route is what this is for — which record a shell
 * has open, which filter a list is under. Back closes the record, and the URL is shareable, without any
 * of it being a pattern a screen module had to declare.
 *
 * **It exists because the hand-rolled version has a trap, and every call site meets it separately.**
 * Writing one parameter means reading the query, parsing it, setting a key, serialising it, and joining
 * it back onto the path — and the join is where it goes wrong. `window.location.search` is `""` and
 * never `"?"`, so a writer that appends a bare `?` after clearing its last parameter produces a URL
 * that never equals the current one: every repeat call pushes another entry, and Back then walks
 * through them one at a time without the page ever changing. Carrying the hash across is the other half
 * nobody remembers.
 *
 * The no-op check is on the query rather than on the whole URL, because the query is the part this
 * edits — and the guard downstream compares `pathname + search`, which a URL carrying a hash can never
 * equal.
 */
export function updateSearch(patch: Record<string, string | null>, options?: { replace?: boolean }): void {
  const params = new URLSearchParams(window.location.search);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  const query = params.toString();
  const search = query === "" ? "" : `?${query}`;
  if (search === window.location.search) return;
  const to = window.location.pathname + search + window.location.hash;
  if (options?.replace) replace(to);
  else navigate(to);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * One string out of `window.location`, re-read on every navigation. Every reader wakes on the same `notify()`,
 * which is what makes `navigate`, `replace`, `updateSearch` and the browser's own Back one event rather than four.
 */
function useLocationValue(read: () => string): string {
  return useSyncExternalStore(subscribe, read);
}

const readPathname = (): string => window.location.pathname;
const readSearch = (): string => window.location.search;

/** The current pathname, re-rendering the subscriber on every navigation. */
export function usePath(): string {
  return useLocationValue(readPathname);
}

/**
 * The current query string, verbatim — `"?email=ada"`, or `""` when there is none. Re-renders the
 * subscriber on every navigation.
 *
 * The raw string rather than a `URLSearchParams`, and that is the decision: a params object is a new
 * object every render, so every `useMemo` and `useCallback` downstream of one re-runs forever. This hands back what `window.location.search` is, and a screen wanting one value asks
 * {@link useSearchParam} for it.
 */
export function useSearch(): string {
  return useLocationValue(readSearch);
}

/**
 * One query parameter, decoded — `null` when the key is absent. Re-renders on every navigation.
 *
 * A value is what call sites actually ask for: the OTP screen wants `email`, a shell wants which record
 * is open. It is a string from a stranger, exactly like a path parameter, so a screen wanting a number
 * or a member of a set validates it — this router types neither.
 */
export function useSearchParam(name: string): string | null {
  const search = useSearch();
  return new URLSearchParams(search).get(name);
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

/** What {@link Redirect} takes. */
export type RedirectProps = RedirectTarget & {
  /** Replace the current history entry rather than push one, for a correction the reader did not make. */
  readonly replace?: boolean;
  /**
   * Leave by a document load rather than a route change: for an address that is the Worker's rather than a
   * screen's, or a change of account that nothing already on the page may survive.
   */
  readonly load?: boolean;
};

function inApp(to: string, options: { replace: boolean }): void {
  if (options.replace) replace(to);
  else navigate(to);
}

function byDocument(to: string, options: { replace: boolean }): void {
  if (options.replace) window.location.replace(to);
  else window.location.assign(to);
}

/**
 * Go somewhere else, as one of the states a screen renders. When an answer means "not here" — signed out, no
 * entitlement, a one-time code that has done its work — render this the way you render loading and failure. It
 * navigates once and renders nothing.
 *
 * ```tsx
 * if (session.value === null) return <Redirect screen="sign-in" />;
 * ```
 */
export function Redirect(props: RedirectProps): ReactNode {
  if ("screen" in props) return <RedirectToScreen {...props} />;
  return <Navigate to={props.to} replace={props.replace} go={props.load ? byDocument : inApp} />;
}

function RedirectToScreen(props: Extract<RedirectTarget, { screen: ScreenRole }> & RedirectProps): ReactNode {
  const path = useScreenPath(props.screen);
  const to = props.search ? `${path}?${props.search}` : path;
  return <Navigate to={to} replace={props.replace} go={props.load ? byDocument : inApp} />;
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
  return useRead("signed-in", isSignedIn).value ?? null;
}

/** Renders its children only for a signed-in visitor; everyone else is sent to the sign-in screen. */
export function RequireSignedIn(props: { children: ReactNode }): ReactNode {
  const t = useTranslator(EN);
  const table = use(routeTable());
  const signedIn = useSignedIn();
  if (signedIn === true) return props.children;
  if (signedIn === false) return <Redirect to={screenPath(table, "sign-in")} />;
  return <p className="muted">{t.t("app/loading")}</p>;
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
export function RequireEntitlement(props: { entitlement: string; children: ReactNode }): ReactNode {
  const t = useTranslator(EN);
  const table = use(routeTable());
  const held = useRead(`entitlement:${props.entitlement}`, () => holdsEntitlement(props.entitlement));
  if (held.value === true && !held.loading) return props.children;
  if (held.value === false && !held.loading) return <Redirect to={screenPath(table, "paywall")} />;
  return <p className="muted">{t.t("app/loading")}</p>;
}

/**
 * The router's own English, baked in — the only catalog that survives being copied into your repository.
 *
 * Keyed under `app/` rather than a capability name because that is what this file is: the shell of
 * *your* application, not a screen a kit capability ships. A capability may only declare keys under its
 * own name, and nothing named `router` is composed.
 *
 * One waiting line for all three places that wait — a guard reading the session, a guard reading an
 * entitlement, and the suspense boundary over the route table. They are one sentence to a reader, so
 * they are one key: three would be three chances for a translation to disagree with itself on screen.
 */
const EN = {
  "app/loading": "One moment.",
  "app/not_found.title": "Not here.",
  "app/not_found.body": "Nothing answers {path}.",
  "app/not_found.home": "Go home",
} satisfies MessageCatalog;

// ── router ───────────────────────────────────────────────────────────────────

function Screen(): ReactNode {
  const t = useTranslator(EN);
  const table = use(routeTable());
  const path = usePath();
  const match = matchPath(table.patterns, path);
  const route = match ? table.byPattern.get(match.pattern) : undefined;

  if (!match || !route) {
    return (
      <main className="screen">
        <h1>{t.t("app/not_found.title")}</h1>
        <p className="muted">
          {t.t("app/not_found.body", { path })} <Link to="/">{t.t("app/not_found.home")}</Link>.
        </p>
      </main>
    );
  }

  const Component = route.component;
  const params = match.params;
  // An entitlement belongs to somebody, so asking for one implies a session — the same order the server
  // declares it in, `requireAuth()` then `requireEntitlement()`. Session outside, entitlement inside.
  const screen = route.entitlement ? (
    <RequireEntitlement entitlement={route.entitlement}>
      <Component params={params} />
    </RequireEntitlement>
  ) : (
    <Component params={params} />
  );
  return route.session === "required" || route.entitlement ? <RequireSignedIn>{screen}</RequireSignedIn> : screen;
}

/** Mount this once. It resolves the route table, then renders the screen for the current path. */
export function Router(): ReactNode {
  const t = useTranslator(EN);
  return (
    <Suspense fallback={<p className="muted">{t.t("app/loading")}</p>}>
      <Screen />
    </Suspense>
  );
}
