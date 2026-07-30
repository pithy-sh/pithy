// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { noopEmit } from "./audit/recorder";
import { BindingSpec } from "./capability/bindings";
import type {
  Capability,
  MergedDatabases,
  MergedKvNamespaces,
  MergedWorkflowParams,
  PithyHonoEnv,
  PithyVars,
} from "./capability/capability";
import { validateBindings } from "./capability/validateBindings";
import { buildDbRegistry, composeDatabases, type DbRegistry } from "./data/databases";
import { noEntitlementProvider } from "./entitlement/entitlement";
import { pithyErrorHandler } from "./error/http";
import { ValidationError } from "./error/pithyError";
import { buildKvRegistry, composeKv, type KvRegistry } from "./kv/namespaces";
import type { Logger } from "./logger/logger";
import { bindRequestContext, createWorkerLogger } from "./logger/worker";
import { buildWorkflowDispatcher, type WorkflowDispatcher } from "./workflow/dispatch";
import { composeWorkflows } from "./workflow/register";

/** Inputs to {@link createBackend}: the capabilities to assemble, plus the app's own capability. */
export interface CreateBackendOptions<Caps extends readonly Capability[], App extends Capability> {
  /** Library capabilities (core + each `@pithy-sh/*`), composed in order. */
  capabilities: Caps;
  /**
   * The app itself, as a `Capability` — principle 4: the app is just another capability. Its
   * databases, KV namespaces, middleware, routes, and bindings compose with the rest; routes last.
   */
  app?: App;
  /**
   * The base logger bound to `c.var.log`, set **once** here at assembly (the per-request `env`
   * constraint is honored: correlation fields are bound per request, not at module load). Defaults to
   * the CF-native Mode 2 worker logger (`info`, structured records to Workers Logs). Pass a configured
   * one to change the level or attach a tail/Logpush transport.
   */
  logger?: Logger;
  /**
   * Fallback environment name (`dev` | `staging` | `production`) for the log correlation `env` field.
   * The primary signal is the per-request `ENVIRONMENT` var (the convention `@pithy-sh/secrets` and
   * `@pithy-sh/email` already stamp into each deployed Worker); this is only used where that var is
   * absent — e.g. a non-provisioned local run. Falls through to `unknown` when neither is present.
   */
  env?: string;
}

/** The Hono env `createBackend` returns — `db`/`kv`/`workflows` typed precisely from the merged capabilities. */
type BackendEnv<Caps extends readonly Capability[]> = {
  Bindings: Record<string, unknown>;
  Variables: Omit<PithyVars, "db" | "kv" | "workflows"> & {
    db: DbRegistry<MergedDatabases<Caps>>;
    kv: KvRegistry<MergedKvNamespaces<Caps>>;
    workflows: WorkflowDispatcher<MergedWorkflowParams<Caps>>;
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
 * The deployed Worker version id, read from the `CF_VERSION_METADATA` version-metadata binding when the
 * adopter has wired one; `undefined` off-platform or when the binding is absent. Correlates every log
 * record to the exact deploy that produced it.
 */
function versionOf(env: Record<string, unknown>): string | undefined {
  const meta = env.CF_VERSION_METADATA;
  if (typeof meta === "object" && meta !== null && typeof (meta as { id?: unknown }).id === "string") {
    return (meta as { id: string }).id;
  }
  return undefined;
}

/**
 * The environment name for log correlation, resolved from context: the per-request `ENVIRONMENT` var
 * (the signal `@pithy-sh/secrets`/`@pithy-sh/email` stamp into each deployed Worker), else the explicit
 * `createBackend({ env })` fallback, else `unknown`. No caller effort where `ENVIRONMENT` is present.
 */
function envNameOf(env: Record<string, unknown>, fallback: string | undefined): string {
  return typeof env.ENVIRONMENT === "string" && env.ENVIRONMENT.length > 0 ? env.ENVIRONMENT : (fallback ?? "unknown");
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
  const workflows = composeWorkflows(all);

  // Each named database implies its D1 binding; each KV namespace implies its KV binding; each
  // registered job implies its Workflow binding. Derive them so the fail-fast check covers every
  // binding the request context will actually build or dispatch to.
  //
  // A job's `optional` rides through: `@pithy-sh/media` declares its enrichment Workflows optional
  // so an app still boots before `pithy media provision` has deployed the host, and `dedupeBindings`
  // ANDs `optional` across occurrences — deriving these as unconditionally required would override
  // that and break every project that has not provisioned yet.
  const required = dedupeBindings([
    ...all.flatMap((cap) => cap.requiredBindings),
    ...Object.values(databases).map((db) => BindingSpec.parse({ type: "d1", name: db.binding })),
    ...Object.values(namespaces).map((ns) => BindingSpec.parse({ type: "kv", name: ns.binding })),
    ...Object.values(workflows).map((entry) =>
      BindingSpec.parse({ type: "workflow", name: entry.spec.binding, optional: entry.spec.optional ?? false }),
    ),
  ]);

  // Build internally against the loose base env (db/kv are `unknown`, so `c.set` accepts the merged
  // registries); the precise types ride on the return below.
  const app = new Hono<PithyHonoEnv>();
  app.onError(pithyErrorHandler);

  // Set once at assembly (the per-request `env` constraint holds: correlation binds per request below,
  // not here). Defaults to the CF-native Mode 2 logger — structured records to Workers Logs, zero-config.
  const baseLogger = options.logger ?? createWorkerLogger();

  let validated = false;
  app.use("*", async (c, next) => {
    const env = c.env as Record<string, unknown>;
    if (!validated) {
      validateBindings(env, required);
      validated = true;
    }
    if (c.get("auth") === undefined) c.set("auth", null);
    // Its own variable, never folded into `auth`: a management client is not a user of this app, so a
    // control-plane call must not satisfy any capability's `requireAuth()`. Null until the seam's
    // middleware verifies a credential, which is what makes every control-plane route default-denied.
    if (c.get("controlPlane") === undefined) c.set("controlPlane", null);
    // Null unless the `controlplane()` capability's middleware publishes one. Every
    // `requireControlPlane()` gate in the tree denies while it is null, so an admin route in a Worker
    // that never composed the seam is closed rather than unguarded.
    if (c.get("controlPlaneVerifier") === undefined) c.set("controlPlaneVerifier", null);
    if (c.get("emit") === undefined) c.set("emit", noopEmit);
    // Fail closed: with no payments capability composed, nothing is held and every gate denies.
    if (c.get("entitlements") === undefined) c.set("entitlements", noEntitlementProvider);
    if (c.get("log") === undefined) {
      c.set(
        "log",
        bindRequestContext(baseLogger, {
          // The CF ray id correlates a request across Cloudflare's logs; fall back to a uuid off-platform.
          request: c.req.header("cf-ray") ?? crypto.randomUUID(),
          method: c.req.method,
          path: c.req.path,
          env: envNameOf(env, options.env),
          version: versionOf(env),
        }),
      );
    }
    if (c.get("db") === undefined) c.set("db", buildDbRegistry(env, databases));
    if (c.get("kv") === undefined) c.set("kv", buildKvRegistry(env, namespaces, c.var.log));
    if (c.get("workflows") === undefined) c.set("workflows", buildWorkflowDispatcher(env, workflows, c.var.log));

    // Auto access-log: one record per request carrying the response `status` and `elapsed`, resolved
    // from context with no caller effort — the completion of the request-correlation seam.
    const start = Date.now();
    await next();
    c.var.log.info("request", { status: c.res.status, elapsed: Date.now() - start });
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
