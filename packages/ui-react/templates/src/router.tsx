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
// importing it) is what lets this file be byte-identical in both templates.
const sessionModules = import.meta.glob<{ getSession: () => Promise<unknown> }>("./session.tsx");

/** Where the guard sends a signed-out visitor. */
const SIGN_IN_PATH = "/sign-in";

/** What a route module exports. `session` is the only opt-in: set it to guard the screen. */
export interface RouteModule {
  /** The path this screen answers, e.g. `/sign-in`. */
  path: string;
  /** The screen itself. */
  default: ComponentType;
  /** Set to `"required"` to send signed-out visitors to the sign-in screen. */
  session?: "required";
}

/** One resolved entry in the route table. */
interface Route {
  component: ComponentType;
  session?: "required" | undefined;
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
      table.set(module.path, { component: lazy(load), session: module.session });
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
  return route.session === "required" ? (
    <Guarded>
      <Component />
    </Guarded>
  ) : (
    <Component />
  );
}

/** Mount this once. It resolves the route table, then renders the screen for the current path. */
export function Router(): ReactNode {
  return (
    <Suspense fallback={<p className="muted">One moment.</p>}>
      <Screen />
    </Suspense>
  );
}
