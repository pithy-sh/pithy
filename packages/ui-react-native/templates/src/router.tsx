import type { MessageCatalog } from "@pithy-sh/core/src/i18n/catalog";
import { useTranslator } from "@pithy-sh/i18n/src/react/translator";
import { useRead } from "@pithy-sh/ui-core/src/read";
import { Redirect as Navigate } from "@pithy-sh/ui-core/src/redirect";
import {
  buildRoutes,
  matchPath,
  type RedirectTarget,
  type RouteTable,
  type ScreenRole,
  screenPath,
} from "@pithy-sh/ui-core/src/routes";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import {
  createContext,
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { type StyleProp, Text, type TextStyle, View } from "react-native";
import { parseQuery, queryString } from "./platform";
import { appRoutes, paymentsModule, pithyRoutes, sessionModule } from "./route-modules";
import { useTheme } from "./theme";

/**
 * The router: which screen answers the current path, the guards in front of it, and how a screen goes elsewhere.
 *
 * Screens register in `route-modules.ts` and declare their own `path`, exactly as the React screens do, and the
 * route table, the matching rule and the roles come from `@pithy-sh/ui-core/src/routes`. What the app supplies is
 * a {@link RouterAdapter}: where it is, how to go somewhere, and when that changes. `expo-router` is the binding
 * this app is written with ({@link useExpoRouterAdapter}); React Navigation, or anything else, is another adapter.
 */

/** How the app navigates: the router a screen goes through, never `window`. */
export interface RouterAdapter {
  /** Where the app is now: the path and its query, such as `/otp?email=ada%40example.com`. */
  path(): string;
  /** Go to `to`, a path with an optional query. `replace` swaps the current entry rather than pushing one. */
  go(to: string, options: { replace: boolean }): void;
  /** Call `listener` whenever {@link RouterAdapter.path} changes. Answers the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** The query parameter `app/[...pithy].tsx` captures the path in, which is not part of the query a screen reads. */
export const CATCH_ALL_PARAM = "pithy";

/**
 * The adapter over `expo-router`. Its pathname and query arrive as hooks, so a navigation re-renders the caller and
 * hands back a new adapter; the router reads the new path from it.
 */
export function useExpoRouterAdapter(): RouterAdapter {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const router = useRouter();
  const search = queryString(
    Object.fromEntries(
      Object.entries(params).flatMap(([name, value]) => {
        if (name === CATCH_ALL_PARAM) return [];
        const first = Array.isArray(value) ? value[0] : value;
        return first === undefined ? [] : [[name, first]];
      }),
    ),
  );
  return useMemo<RouterAdapter>(
    () => ({
      path: () => `${pathname}${search}`,
      go: (to, options) => (options.replace ? router.replace(to) : router.push(to)),
      subscribe: () => () => undefined,
    }),
    [pathname, search, router],
  );
}

/** An adapter over a path held in memory: for a test, or an app that keeps no URL at all. */
export function createMemoryAdapter(initial = "/"): RouterAdapter & { readonly history: readonly string[] } {
  const history = [initial];
  const listeners = new Set<() => void>();
  return {
    history,
    path: () => history[history.length - 1] ?? "/",
    go(to, options) {
      if (options.replace) history[history.length - 1] = to;
      else history.push(to);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface RouterState {
  readonly adapter: RouterAdapter;
  /** Remount every screen, so nothing a screen held survives: what a document load does on the web. */
  readonly reload: () => void;
}

const RouterContext = createContext<RouterState | null>(null);

function useRouterState(): RouterState {
  const state = useContext(RouterContext);
  if (state === null) throw new Error("A screen rendered outside <Router>. Mount the router once, at the app's root.");
  return state;
}

let resolved: Promise<RouteTable> | null = null;

/**
 * The route table, resolved once, on first use. A function rather than a module constant, because resolving it
 * loads every screen, and importing this file for `Link` alone must not.
 */
export function routeTable(): Promise<RouteTable> {
  resolved ??= buildRoutes([...pithyRoutes, ...appRoutes]);
  return resolved;
}

/** The path of the screen claiming `role`, for a link that must go where a guard would. Suspends until the table resolves. */
export function useScreenPath(role: ScreenRole): string {
  return screenPath(use(routeTable()), role);
}

/** The same, `null` when no screen claims the role: a link that crosses a capability that may not be composed. */
export function useOptionalScreenPath(role: ScreenRole): string | null {
  return use(routeTable()).byRole.get(role) ?? null;
}

// ── location ─────────────────────────────────────────────────────────────────

function useLocation(): string {
  const { adapter } = useRouterState();
  return useSyncExternalStore(adapter.subscribe, adapter.path, adapter.path);
}

function splitPath(location: string): { pathname: string; search: string } {
  const at = location.indexOf("?");
  return at === -1
    ? { pathname: location, search: "" }
    : { pathname: location.slice(0, at), search: location.slice(at) };
}

/** The current pathname. Re-renders on every navigation. */
export function usePath(): string {
  return splitPath(useLocation()).pathname;
}

/** The current query string, verbatim: `"?email=ada"`, or `""`. Re-renders on every navigation. */
export function useSearch(): string {
  return splitPath(useLocation()).search;
}

/** One query parameter, decoded, or `null` when it is absent. A string from a stranger: validate what you need. */
export function useSearchParam(name: string): string | null {
  return parseQuery(useSearch())[name] ?? null;
}

/**
 * How a screen navigates after something a person did: `go(to)` pushes, `go(to, { replace: true })` swaps the
 * current entry for a correction the reader did not make. Going where the app already is does nothing.
 */
export function useGo(): (to: string, options?: { replace?: boolean }) => void {
  const { adapter } = useRouterState();
  return useCallback(
    (to: string, options?: { replace?: boolean }) => {
      if (to === adapter.path()) return;
      adapter.go(to, { replace: options?.replace ?? false });
    },
    [adapter],
  );
}

/**
 * Set or clear query parameters on the current path, leaving the rest alone. Pushes by default; pass
 * `{ replace: true }` for a correction.
 */
export function useUpdateSearch(): (patch: Record<string, string | null>, options?: { replace?: boolean }) => void {
  const { adapter } = useRouterState();
  const go = useGo();
  return useCallback(
    (patch: Record<string, string | null>, options?: { replace?: boolean }) => {
      const { pathname, search } = splitPath(adapter.path());
      const params = parseQuery(search);
      for (const [name, value] of Object.entries(patch)) {
        if (value === null) delete params[name];
        else params[name] = value;
      }
      go(`${pathname}${queryString(params)}`, options);
    },
    [adapter, go],
  );
}

/** An in-app link: text a reader presses to go to `to`. */
export function Link(props: {
  to: string;
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  testID?: string;
}): ReactNode {
  const go = useGo();
  const theme = useTheme();
  return (
    <Text
      role="link"
      testID={props.testID}
      style={[theme.type.body, { color: theme.colors.text, textDecorationLine: "underline" }, props.style]}
      onPress={() => go(props.to)}
    >
      {props.children}
    </Text>
  );
}

/** What {@link Redirect} takes. */
export type RedirectProps = RedirectTarget & {
  /** Replace the current entry rather than push one, for a correction the reader did not make. */
  readonly replace?: boolean;
  /**
   * Remount every screen as it goes, so nothing the previous screens held survives: a change of account, where the
   * last account's lists and headers must not linger.
   */
  readonly load?: boolean;
};

/**
 * Go somewhere else, as one of the states a screen renders. When an answer means "not here", render this the way
 * you render loading and failure. It navigates once and renders nothing.
 *
 * ```tsx
 * if (session.value === null) return <Redirect screen="sign-in" />;
 * ```
 */
export function Redirect(props: RedirectProps): ReactNode {
  if ("screen" in props) return <RedirectToScreen {...props} />;
  return <Go to={props.to} replace={props.replace} load={props.load} />;
}

function RedirectToScreen(props: Extract<RedirectTarget, { screen: ScreenRole }> & RedirectProps): ReactNode {
  const path = useScreenPath(props.screen);
  return <Go to={props.search ? `${path}?${props.search}` : path} replace={props.replace} load={props.load} />;
}

function Go(props: { to: string; replace?: boolean | undefined; load?: boolean | undefined }): ReactNode {
  const { adapter, reload } = useRouterState();
  const load = props.load ?? false;
  const go = useCallback(
    (to: string, options: { replace: boolean }) => {
      if (to !== adapter.path()) adapter.go(to, options);
      if (load) reload();
    },
    [adapter, reload, load],
  );
  return <Navigate to={props.to} replace={props.replace} go={go} />;
}

// ── guard ────────────────────────────────────────────────────────────────────

/** Is there a session? True when the session module was not written, so an app without auth renders everything. */
async function isSignedIn(): Promise<boolean> {
  if (!sessionModule) return true;
  return (await (await sessionModule()).getSession()) !== null;
}

/**
 * Whether there is a session: `null` while the read is in flight. For a public screen that draws something
 * different for a stranger, such as a pricing screen's buy button.
 */
export function useSignedIn(): boolean | null {
  return useRead("signed-in", isSignedIn).value ?? null;
}

/** The line every wait renders. */
function Waiting(): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  return (
    <View style={{ padding: theme.spacing.lg }}>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>{t.t("app/loading")}</Text>
    </View>
  );
}

/** Renders its children only for a signed-in visitor; everyone else is sent to the sign-in screen. */
export function RequireSignedIn(props: { children: ReactNode }): ReactNode {
  const table = use(routeTable());
  const signedIn = useSignedIn();
  if (signedIn === true) return props.children;
  if (signedIn === false) return <Redirect to={screenPath(table, "sign-in")} />;
  return <Waiting />;
}

/** Does the visitor hold `key`? True when the payments module was not written, so a guard cannot lock a screen shut. */
async function holdsEntitlement(key: string): Promise<boolean> {
  if (!paymentsModule) return true;
  return (await paymentsModule()).holdsEntitlement(key);
}

/**
 * Renders its children only for a visitor holding `entitlement`; everyone else is sent to the paywall. A courtesy,
 * never a boundary: the Worker's `requireEntitlement()` is the boundary.
 */
export function RequireEntitlement(props: { entitlement: string; children: ReactNode }): ReactNode {
  const table = use(routeTable());
  const held = useRead(`entitlement:${props.entitlement}`, () => holdsEntitlement(props.entitlement));
  if (held.value === true && !held.loading) return props.children;
  if (held.value === false && !held.loading) return <Redirect to={screenPath(table, "paywall")} />;
  return <Waiting />;
}

/** The router's own English, under `app/` because this is the app's shell rather than a capability's screen. */
const EN = {
  "app/loading": "One moment.",
  "app/not_found.title": "Not here.",
  "app/not_found.body": "Nothing answers {path}.",
  "app/not_found.home": "Go home",
} satisfies MessageCatalog;

// ── router ───────────────────────────────────────────────────────────────────

function NotFound(props: { path: string }): ReactNode {
  const t = useTranslator(EN);
  const theme = useTheme();
  return (
    <View
      style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.md, backgroundColor: theme.colors.background }}
    >
      <Text role="heading" style={[theme.type.title, { color: theme.colors.text }]}>
        {t.t("app/not_found.title")}
      </Text>
      <Text style={[theme.type.body, { color: theme.colors.muted }]}>
        {t.t("app/not_found.body", { path: props.path })}
      </Text>
      <Link to="/">{t.t("app/not_found.home")}</Link>
    </View>
  );
}

function Screen(): ReactNode {
  const table = use(routeTable());
  const path = usePath();
  const match = matchPath(table.patterns, path);
  const route = match ? table.byPattern.get(match.pattern) : undefined;
  if (!match || !route) return <NotFound path={path} />;

  const Component = route.component;
  // An entitlement belongs to somebody, so asking for one implies a session: session outside, entitlement inside.
  const screen = route.entitlement ? (
    <RequireEntitlement entitlement={route.entitlement}>
      <Component params={match.params} />
    </RequireEntitlement>
  ) : (
    <Component params={match.params} />
  );
  return route.session === "required" || route.entitlement ? <RequireSignedIn>{screen}</RequireSignedIn> : screen;
}

/** The router's context without its screens: for a screen rendered on its own, in a test or a modal. */
export function RouterProvider(props: { adapter: RouterAdapter; children: ReactNode }): ReactNode {
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((now) => now + 1), []);
  const state = useMemo(() => ({ adapter: props.adapter, reload }), [props.adapter, reload]);
  return (
    <RouterContext value={state}>
      <View key={generation} style={{ flex: 1 }}>
        {props.children}
      </View>
    </RouterContext>
  );
}

/** Mount this once, with the app's adapter. It resolves the route table, then renders the screen for the current path. */
export function Router(props: { adapter: RouterAdapter }): ReactNode {
  return (
    <RouterProvider adapter={props.adapter}>
      <Suspense fallback={<Waiting />}>
        <Screen />
      </Suspense>
    </RouterProvider>
  );
}
