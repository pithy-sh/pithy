import type { RouteModule } from "@pithy-sh/ui-core/src/routes";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The contexts below ARE the route registration. Do not edit them.
 *
 *   src/routes/pithy/   Pithy's screens. Pithy writes only here, and only files that do not exist.
 *   src/routes/app/     Yours. Pithy never writes here.
 *
 * Dropping a file in registers it: no manifest, no command to re-run. Each module declares its own path, so
 * filenames encode no routing rules:
 *
 *   export const path = "/sign-in";
 *   export default SignIn;
 *
 * `app/` wins on a conflict: override a Pithy screen by putting your own file at the same path.
 *
 * `require.context` is Metro's directory import, the one `expo-router` itself registers screens with. Its
 * arguments must be literals, because Metro reads them while it bundles. Both contexts read `src/routes/`, which
 * your home screen keeps on disk, and pick their folder by filter: a directory Metro cannot find fails the
 * bundle, and an app with no Pithy screens has no `src/routes/pithy/`. The filter also keeps co-located tests
 * out of the bundle: `home.test.tsx` beside `home.tsx` would otherwise ship, fixtures and stub tokens included.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** A directory Metro has read: its file names, and a module by name. */
interface ModuleContext {
  keys(): string[];
  (id: string): unknown;
}

declare const require: {
  context(path: string, recursive: boolean, filter: RegExp, mode: "sync"): ModuleContext;
};

/** One loader per file in `context`, in a stable order. */
export function contextLoaders<T>(context: ModuleContext): (() => Promise<T>)[] {
  return context
    .keys()
    .sort()
    .map((key) => async () => context(key) as T);
}

/** Pithy's screens. */
export const pithyRoutes = contextLoaders<RouteModule>(
  require.context("./routes", true, /^\.\/pithy\/(?!.*\.(?:test|spec)\.tsx$).*\.tsx$/, "sync"),
);

/** Your screens. Registered after Pithy's, so one at the same path takes it over. */
export const appRoutes = contextLoaders<RouteModule>(
  require.context("./routes", true, /^\.\/app\/(?!.*\.(?:test|spec)\.tsx$).*\.tsx$/, "sync"),
);

/**
 * The session module, when the auth screens were written: the router's sign-in guard asks it. Read through a
 * context rather than imported, so this file is the same with or without it.
 */
export const sessionModule: (() => Promise<{ getSession: () => Promise<unknown> }>) | undefined = contextLoaders<{
  getSession: () => Promise<unknown>;
}>(require.context("./", false, /^\.\/session\.tsx$/, "sync"))[0];

/** The payments module, when the payments screens were written: the router's entitlement guard asks it. */
export const paymentsModule: (() => Promise<{ holdsEntitlement: (key: string) => Promise<boolean> }>) | undefined =
  contextLoaders<{ holdsEntitlement: (key: string) => Promise<boolean> }>(
    require.context("./", false, /^\.\/payments\.tsx$/, "sync"),
  )[0];

/**
 * The store listener the payments screens ship, when they were written: the root layout mounts it for the whole
 * run. Read synchronously, because a hook has to be there on the first render.
 */
export const storeTransactions: (() => void) | undefined = (() => {
  const context = require.context("./", false, /^\.\/useStoreTransactions\.ts$/, "sync");
  const key = context.keys()[0];
  return key === undefined ? undefined : (context(key) as { useStoreTransactions: () => void }).useStoreTransactions;
})();
