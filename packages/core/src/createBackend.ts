import { Hono } from "hono";
import { noopEmit } from "./audit/recorder";
import { BindingSpec } from "./capability/bindings";
import type { Capability, MergedDatabases, MergedKvNamespaces, PithyHonoEnv, PithyVars } from "./capability/capability";
import { validateBindings } from "./capability/validateBindings";
import { buildDbRegistry, composeDatabases, type DbRegistry } from "./data/databases";
import { pithyErrorHandler } from "./error/http";
import { ValidationError } from "./error/pithyError";
import { buildKvRegistry, composeKv, type KvRegistry } from "./kv/namespaces";

/** Inputs to {@link createBackend}: the capabilities to assemble, plus the app's own capability. */
export interface CreateBackendOptions<Caps extends readonly Capability[], App extends Capability> {
  /** Library capabilities (core + each `@pithy-sh/*`), composed in order. */
  capabilities: Caps;
  /**
   * The app itself, as a `Capability` — principle 4: the app is just another capability. Its
   * databases, KV namespaces, middleware, routes, and bindings compose with the rest; routes last.
   */
  app?: App;
}

/** The Hono env `createBackend` returns — `db`/`kv` typed precisely from the merged capabilities. */
type BackendEnv<Caps extends readonly Capability[]> = {
  Bindings: Record<string, unknown>;
  Variables: Omit<PithyVars, "db" | "kv"> & {
    db: DbRegistry<MergedDatabases<Caps>>;
    kv: KvRegistry<MergedKvNamespaces<Caps>>;
  };
};

/**
 * Collapse duplicate bindings (same `type:name`) — capability and derived specs overlap. A binding
 * required by **any** source stays required: a derived database/namespace binding (structurally
 * required — the request context builds a handle on it) must not be masked by an author marking the
 * same binding `optional`. So `optional` is the AND of every occurrence.
 */
function dedupeBindings(specs: BindingSpec[]): BindingSpec[] {
  const byKey = new Map<string, BindingSpec>();
  for (const spec of specs) {
    const key = `${spec.type}:${spec.name}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { ...spec });
    else if (!spec.optional) existing.optional = false;
  }
  return [...byKey.values()];
}

/**
 * Assemble capabilities into a deployable Hono app — a valid Worker `fetch` handler.
 *
 * Serves `GET /health`; merges every capability's `databases` and `kvNamespaces` into registries
 * (tables/stores unioned per group); validates that every required binding is present; composes
 * each capability's middleware; and mounts the capability (then app) routes. On every request
 * `c.var.db` is the typed database registry — one `Kysely` per named database (`c.var.db.app`) —
 * and `c.var.kv` the typed namespace registry — one `TypedKv` per store (`c.var.kv.cms.pages`).
 * `PithyError`s become their declared HTTP status via {@link pithyErrorHandler}.
 *
 * Binding validation runs **once on the first request**, not at module load: in Workers `env` is
 * per-request, so there is no env to check until a request arrives. The result is memoized.
 *
 * The return is typed precisely from the capabilities array — `createBackend({ capabilities }).get(
 * "/x", (c) => c.var.db.app.selectFrom("…"))` gets autocomplete on every registered table.
 */
export function createBackend<
  const Caps extends readonly Capability[],
  const App extends Capability = Capability<Record<never, never>, Record<never, never>>,
>(options: CreateBackendOptions<Caps, App>): Hono<BackendEnv<readonly [...Caps, App]>> {
  // The app is just another capability, composed last so its routes mount after the libraries'.
  const all: Capability[] = options.app ? [...options.capabilities, options.app] : [...options.capabilities];

  // Fail fast on a missing peer capability: a capability that reads another's seam (e.g. turnstile
  // reading secrets) must be composed with it, or its requests would only fail one-by-one at runtime.
  const present = new Set(all.map((cap) => cap.name));
  for (const cap of all) {
    for (const dep of cap.dependsOn ?? []) {
      if (!present.has(dep)) {
        throw new ValidationError({
          message: `Capability "${cap.name}" requires the "${dep}" capability, which is not composed.`,
          action: `Add ${dep}() to createBackend's capabilities (run \`pithy add ${dep}\`).`,
        });
      }
    }
  }

  // Startup hooks: each capability may wire across the full composed set (e.g. @pithy-sh/secrets
  // aggregates every capability's secretRegistry into one combined registry). Runs once at assembly,
  // after dependsOn validation so a hook can rely on its peers being present.
  for (const cap of all) cap.compose?.({ capabilities: all });

  const databases = composeDatabases(all);
  const namespaces = composeKv(all);

  // Each named database implies its D1 binding; each KV namespace implies its KV binding. Derive
  // them so the fail-fast check covers every binding the request context will actually build.
  const required = dedupeBindings([
    ...all.flatMap((cap) => cap.requiredBindings),
    ...Object.values(databases).map((db) => BindingSpec.parse({ type: "d1", name: db.binding })),
    ...Object.values(namespaces).map((ns) => BindingSpec.parse({ type: "kv", name: ns.binding })),
  ]);

  // Build internally against the loose base env (db/kv are `unknown`, so `c.set` accepts the merged
  // registries); the precise types ride on the return below.
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);

  let validated = false;
  app.use("*", async (c, next) => {
    const env = c.env as Record<string, unknown>;
    if (!validated) {
      validateBindings(env, required);
      validated = true;
    }
    if (c.get("auth") === undefined) c.set("auth", null);
    if (c.get("emit") === undefined) c.set("emit", noopEmit);
    if (c.get("db") === undefined) c.set("db", buildDbRegistry(env, databases));
    if (c.get("kv") === undefined) c.set("kv", buildKvRegistry(env, namespaces));
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  for (const cap of all) {
    for (const middleware of cap.middleware ?? []) middleware(app);
  }
  for (const cap of all) {
    cap.routes?.(app);
  }

  return app as unknown as Hono<BackendEnv<readonly [...Caps, App]>>;
}
