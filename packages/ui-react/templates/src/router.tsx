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
 * `app/` wins on a conflict — override a Pithy screen by putting your own file at the same path.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const pithyRoutes = import.meta.glob<RouteModule>("./routes/pithy/**/*.tsx");
const appRoutes = import.meta.glob<RouteModule>("./routes/app/**/*.tsx");

// The session module is optional: it exists only in the auth template. Globbing it (rather than
// importing it) is what lets this file be byte-identical in every template. The payments module is
// globbed for the same reason, and answers the entitlement guard below.
const sessionModules = import.meta.glob<{ getSession: () => Promise<unknown> }>("./session.tsx");
const paymentsModules = import.meta.glob<{ holdsEntitlement: (key: string) => Promise<boolean> }>("./payments.tsx");

/** Where the guard sends a signed-out visitor. */
const SIGN_IN_PATH = "/sign-in";

/** Where the entitlement guard sends a visitor who does not hold what a screen asks for. */
const PAYWALL_PATH = "/paywall";

/** What a route module exports. `session` and `entitlement` are the two opt-ins. */
export interface RouteModule {
  /** The path this screen answers, e.g. `/sign-in`. */
  path: string;
  /** The screen itself. */
  default: ComponentType;
  /** Set to `"required"` to send signed-out visitors to the sign-in screen. */
  session?: "required";
  /** Set to an entitlement key to send visitors who do not hold it to the paywall. */
  entitlement?: string;
}

/** One resolved entry in the route table. */
interface Route {
  component: ComponentType;
  session?: "required" | undefined;
  entitlement?: string | undefined;
}

/**
 * The route table, resolved once. Each module is loaded to read its `path` export, then rendered
 * through `React.lazy` so the render path stays suspense-driven and HMR swaps a screen in place.
 * Pithy's routes are registered first and the app's second, so the app's overwrite on a conflict.
 */
async function buildRoutes(): Promise<Map<string, Route>> {
  const table = new Map<string, Route>();
  for (const group of [pithyRoutes, appRoutes]) {
    for (const load of Object.values(group)) {
      const module = await load();
      if (typeof module.path !== "string") continue;
      table.set(module.path, { component: lazy(load), session: module.session, entitlement: module.entitlement });
    }
  }
  return table;
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

// ── router ───────────────────────────────────────────────────────────────────

function Screen(): ReactNode {
  const table = use(routes);
  const path = usePath();
  const route = table.get(path);

  if (!route) {
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
  // An entitlement belongs to somebody, so asking for one implies a session — the same order the server
  // declares it in, `requireAuth()` then `requireEntitlement()`. Session outside, entitlement inside.
  const screen = route.entitlement ? (
    <Entitled entitlement={route.entitlement}>
      <Component />
    </Entitled>
  ) : (
    <Component />
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
