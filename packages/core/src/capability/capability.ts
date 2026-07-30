import type { Hono } from "hono";
import type { z } from "zod";
import type { AuditEmit } from "../audit/recorder";
import type { DatabaseSpecMap } from "../data/databases";
import type { EntitlementResolver } from "../entitlement/entitlement";
import type { AuthContext } from "../http/authContext";
import type { KvNamespaceSpecMap } from "../kv/namespaces";
import type { Logger } from "../logger/logger";
import type { SeedSet } from "../seed/seed";
import type { WorkflowSpecMap } from "../workflow/spec";
import { BindingSpec, type BindingSpecInput } from "./bindings";
import type { ClientProjection, ClientProjectionContext } from "./client";

/** Hono `Variables` every capability's routes are typed against. `createBackend` seeds these per request. */
export interface PithyVars {
  /** The authenticated identity, populated by `@pithy-sh/auth`; `null` until a strategy sets it. */
  auth: AuthContext | null;
  /**
   * The audit recorder seam. Any capability records a security-relevant action with `c.var.emit(...)`
   * (CLAUDE.md §Security). `@pithy-sh/audit` replaces the default with a D1-backed recorder; with no
   * audit capability composed it is the no-op `noopEmit`. Non-fatal by contract — never throws — so
   * an audited action is never broken by an audit write.
   */
  emit: AuditEmit;
  /**
   * The entitlement resolver seam — every entitlement the current caller holds. A paid route gates on
   * it with `requireEntitlement("pro")`; `@pithy-sh/payments` replaces the default with a D1-backed
   * resolver over its materialized read model.
   *
   * **The default denies**, which is the one place this seam deliberately differs from `emit`: a
   * missing audit write cannot grant access, but a missing entitlement check can. With no provider
   * composed it is {@link noEntitlementProvider} — holds nothing, so every gate 403s.
   */
  entitlements: EntitlementResolver;
  /**
   * The logger seam (`c.var.log`). `createBackend` binds a per-request logger carrying request
   * correlation (`request`/`method`/`path`/`env`/`version`); capabilities log through it instead of
   * `console`, and derive a namespaced sub-logger with `c.var.log.child("<capability>")`. Zero-config:
   * a real logger is always present, so nothing null-checks it. Never wire it to a client surface — it
   * carries `PithyError` `detail`, the inverse of the HTTP codec.
   */
  log: Logger;
  /**
   * Per-request D1 database registry. Loosely `unknown` on this base seam so the contract stays
   * decoupled from any schema; `createBackend`'s return types it precisely as `DbRegistry`
   * (`c.var.db.<database>`). Inside a capability, cast to `DbRegistry<YourDatabases>`.
   */
  db: unknown;
  /**
   * Per-request KV namespace registry. Loosely `unknown` here; `createBackend`'s return types it as
   * the merged `KvRegistry` (`c.var.kv.<namespace>.<store>`). Inside a capability, cast to
   * `KvRegistry<YourNamespaces>`.
   */
  kv: unknown;
  /**
   * The durable-job dispatcher — `c.var.workflows.trigger("media/image-to-text", { id })`. Loosely
   * `unknown` on this base seam for the same reason as `db`/`kv`: the precise key and parameter
   * types depend on which capabilities are composed, and `createBackend`'s return narrows it.
   * Inside a capability, cast to `WorkflowDispatcher<YourParams>`.
   */
  workflows: unknown;
}

/** The Hono env. `Bindings` and `Variables` are the base seam; `createBackend` returns a precisely-typed env. */
export type PithyHonoEnv = { Bindings: Record<string, unknown>; Variables: PithyVars };

export type PithyMiddleware = (app: Hono<PithyHonoEnv>) => void;

/**
 * The structural seam for one capability's secret-registry slice — secret name → its declaration.
 * Core carries it on the {@link Capability} contract so a capability can declare which secrets it
 * reads (CLAUDE.md §secrets: every secret is declared in a registry), without core depending on
 * `@pithy-sh/secrets`. The concrete entry shape, the `defineSecretRegistry` authoring helper, the
 * `secretsStore` reader, and the startup aggregation all live in `@pithy-sh/secrets`; core only
 * needs the common axes (read, never interpreted here) so the seam stays a precise supertype of
 * that package's `SecretRegistry`.
 */
export interface SecretRegistryEntrySeam {
  /** Storage backend (`d1` | `cf-secrets-store`). */
  readonly backend: string;
  /** Whether the value differs per environment or is identical everywhere. */
  readonly scope: string;
  /** Whether a future value-rotator may manage the secret. */
  readonly rotatable: boolean;
  /** How a decrypted value is interpreted (`text` | `json`). */
  readonly valueType: string;
}

/** A capability's secret-registry slice: secret name → {@link SecretRegistryEntrySeam}. */
export type SecretRegistrySeam = Record<string, SecretRegistryEntrySeam>;

/**
 * The structural seam for one capability's token-profile slice — profile name → the scoped CF API
 * token that capability's code needs. Declared next to the code that uses it (alongside
 * {@link Capability.secretRegistry}), so a capability owns its token's least-privilege scope and where
 * the minted value lands. Core carries only the structural axes (never interpreted here); the concrete
 * `TokenProfile`, the permission catalog, `defineTokenProfile`, and the mint engine live in
 * `@pithy-sh/cloudflare`/the CLI. `pithy token` aggregates every capability's slice into one registry.
 */
export interface TokenProfileSeam {
  /** The CF permissions the token grants, as short catalog keys (`d1:read`, `secrets:write`). */
  readonly permissions: readonly string[];
  /** The resource scope: `"account"` (the whole account, the default) or an explicit CF resource map. */
  readonly resources?: "account" | Record<string, string>;
  /** The secret-registry name the minted value is stored under — its backend decides the destination. */
  readonly secret?: string;
  /** A built-in destination override (`dev-vars` | `ephemeral` | `secrets-store`) for a tooling profile. */
  readonly defaultStore?: string;
  /** Why the profile exists / what consumes it — surfaced in `pithy token` help and docs. */
  readonly description?: string;
}

/** A capability's token-profile slice: profile name → {@link TokenProfileSeam}. */
export type TokenProfileSeamMap = Record<string, TokenProfileSeam>;

/**
 * Context handed to a capability's {@link Capability.compose} hook at worker startup: every composed
 * capability (libraries + app), so a capability can perform cross-capability wiring it could not do
 * at construction time (when it sees only itself). `@pithy-sh/secrets` uses it to aggregate every
 * capability's {@link Capability.secretRegistry} slice into one combined registry for the shared
 * per-invocation secrets accessor.
 */
export interface CapabilityComposeContext {
  /** Every capability composed into this backend, in composition order (libraries first, app last). */
  capabilities: readonly Capability[];
}

/**
 * An inbound-email handler. A Worker has a single `email()` entry, so the Pithy entrypoint
 * (`createEntrypoint`) fans every incoming message out to each capability that declares one —
 * used for bounce/complaint processing (`@pithy-sh/email`) and any other inbound-mail concern.
 * `env` is the Worker's per-invocation bindings; the handler must consume, forward, or reject the
 * message (an untouched message is dropped by the runtime).
 */
export type CapabilityEmailHandler = (
  message: ForwardableEmailMessage,
  env: Record<string, unknown>,
  ctx: ExecutionContext,
) => void | Promise<void>;

/**
 * The single composition contract. `core`, each capability, and the app all implement it,
 * contributing any subset of {config, migrations, routes, middleware, workflows, databases,
 * kvNamespaces, bindings}. Capabilities depend on core seams (e.g. AuthContext), never on each
 * other's internals.
 *
 * `Databases`/`Namespaces` carry this capability's database and KV-namespace slices so
 * `createBackend` can infer the project-wide merged types. A bare `Capability` annotation widens
 * them; `defineCapability` infers the precise literals.
 */
export interface Capability<
  Databases extends DatabaseSpecMap = DatabaseSpecMap,
  Namespaces extends KvNamespaceSpecMap = KvNamespaceSpecMap,
  Name extends string = string,
  Workflows extends WorkflowSpecMap = WorkflowSpecMap,
> {
  /**
   * The capability's identity: the `pithy add <name>` argument, the migration namespace, the
   * `pithy_<name>_*` table prefix, the error-code domain, and the first segment of every workflow
   * dispatch key. `defineCapability` captures it as a literal so those keys type precisely.
   */
  name: Name;
  /**
   * Other capabilities this one needs composed alongside it (by `name`) — the runtime mirror of the
   * manifest's `peerCapabilities`. `createBackend` fails fast at assembly if a listed peer is absent,
   * so a capability that reads another's seam (e.g. turnstile reading secrets) surfaces a missing
   * dependency at startup rather than as a per-request error.
   */
  dependsOn?: readonly string[];
  /** Validated env/config/secrets for this capability. */
  config?: z.ZodType;
  /**
   * The secrets this capability reads, as a registry slice (CLAUDE.md §secrets). Additive and
   * optional. `@pithy-sh/secrets` aggregates every capability's slice into one combined registry at
   * worker startup (via {@link Capability.compose}), so the shared per-invocation accessor resolves
   * every declared secret in one batch — and no capability needs to know another's secrets.
   */
  secretRegistry?: SecretRegistrySeam;
  /**
   * The scoped CF API tokens this capability's code needs, as a token-profile slice (profile name →
   * {@link TokenProfileSeam}). Additive and optional, and declared next to {@link Capability.secretRegistry}
   * — the value of a minted token lands in the secret the profile names. `pithy token` aggregates every
   * capability's slice with the built-in tooling profiles into one registry.
   */
  tokenProfiles?: TokenProfileSeamMap;
  /**
   * Extra CF permissions this capability needs the **CI system token** to hold, as short catalog keys
   * (e.g. `email:routing` for email provisioning, `kv:write` for a module that seeds KV in CI). They
   * union into the one `ci-system` token `pithy token mint ci-system` produces — so a new capability
   * extends what CI can do without the adopter hand-editing token scopes. Additive and optional.
   */
  ciPermissions?: readonly string[];
  /**
   * Optional startup hook, called once when {@link createBackend} assembles the backend, with every
   * composed capability. Runs after binding and `dependsOn` validation, before middleware and routes
   * mount. Lets a capability wire across capabilities at startup — `@pithy-sh/secrets` aggregates
   * every {@link Capability.secretRegistry} slice here into one combined registry.
   */
  compose?: (context: CapabilityComposeContext) => void;
  /** Mounts a Hono sub-router. */
  routes?: (app: Hono<PithyHonoEnv>) => void;
  /** Composable middleware (e.g. turnstile(), requireAuth()). */
  middleware?: PithyMiddleware[];
  /**
   * Whether this capability fills the entitlement seam — replaces `c.var.entitlements` with a real
   * resolver. `@pithy-sh/payments` declares it; nothing else does today.
   *
   * It exists so the **CLI** can answer a question no amount of runtime care can: a Worker whose routes
   * call `requireEntitlement()` while composing no provider is not broken, it is silently paywalled
   * shut. The seam already fails closed, so the runtime cannot tell that mistake from a legitimately
   * unentitled user. `pithy doctor` and `pithy dev` compare the gates in a Worker's source against this
   * flag and say so, which turns a fleet of production 403s into one line at startup.
   */
  providesEntitlements?: boolean;
  /**
   * This capability's client-safe projection — the **only** values of its config that may reach a
   * browser bundle. Resolved at build time against a {@link ClientProjectionContext} (the environment),
   * validated through {@link ClientProjection}, and inlined by the Vite plugin as `virtual:pithy/<name>`.
   * A capability with no browser surface declares none, and the front end reads `{ enabled: false }`.
   * Opt-in by construction: a new config field never ships to a browser unless it is projected here.
   */
  client?: (context: ClientProjectionContext) => ClientProjection;
  /**
   * Durable jobs this capability registers (job name → {@link WorkflowSpec}) — the peer of
   * `databases` and `kvNamespaces`. `createBackend` merges every capability's map into one registry
   * keyed `<capability>/<job>`, derives each job's Workflow binding so a missing one fails at boot,
   * and serves the typed dispatcher on `c.var.workflows`. The CLI reads the same specs to write the
   * host worker's `workflows` array and its cron triggers.
   */
  workflows?: Workflows;
  /**
   * Inbound-email handler. The entrypoint (`createEntrypoint`) fans every incoming message to each
   * capability that declares one (e.g. `@pithy-sh/email`'s bounce/complaint handler).
   */
  email?: CapabilityEmailHandler;
  /**
   * Named D1 databases this capability contributes tables to (database name → {@link DatabaseSpec}).
   * `createBackend` merges every capability's slices per database (via `composeDatabases`) and serves
   * one typed `Kysely` per database on `c.var.db.<name>`. Multiple databases (app, analytics, …)
   * coexist; no central schema file.
   */
  databases?: Databases;
  /**
   * Named KV namespaces this capability registers (namespace name → {@link KvNamespaceSpec}). Each
   * namespace is a binding holding named typed stores; `createBackend` merges them and serves each
   * store as a live `TypedKv` on `c.var.kv.<namespace>.<store>`. The peer of `databases`.
   */
  kvNamespaces?: Namespaces;
  /**
   * Seed sets this capability contributes to `pithy seed` (the peer of {@link Capability.databases}).
   * Additive and optional. `composeSeeds` merges every capability's sets library-before-app by
   * `order` and filters them by the target environment; the CLI writes them idempotently and
   * non-destructively. App-shape fixtures are re-encoded and Zod-validated at write time.
   */
  seeds?: readonly SeedSet[];
  /** Bindings this capability needs in the env (normalized — `optional` is always set). */
  requiredBindings: BindingSpec[];
}

/** Authoring shape: `requiredBindings` may omit `optional`; `defineCapability` normalizes them. */
export type CapabilityInput<
  Databases extends DatabaseSpecMap = Record<never, never>,
  Namespaces extends KvNamespaceSpecMap = Record<never, never>,
  Name extends string = string,
  Workflows extends WorkflowSpecMap = Record<never, never>,
> = Omit<Capability<Databases, Namespaces, Name, Workflows>, "requiredBindings"> & {
  requiredBindings: BindingSpecInput[];
};

/**
 * Author a capability. Parses each binding through `BindingSpec` — normalizing `optional`
 * and validating at define time, so an invalid binding fails here (attributed to this
 * capability) rather than deep in backend assembly. The `const` type params capture the precise
 * `databases`/`kvNamespaces` literals so `createBackend` can infer the merged registries.
 */
export function defineCapability<
  const Databases extends DatabaseSpecMap = Record<never, never>,
  const Namespaces extends KvNamespaceSpecMap = Record<never, never>,
  const Name extends string = string,
  const Workflows extends WorkflowSpecMap = Record<never, never>,
>(input: CapabilityInput<Databases, Namespaces, Name, Workflows>): Capability<Databases, Namespaces, Name, Workflows> {
  return {
    ...input,
    requiredBindings: input.requiredBindings.map((binding) => BindingSpec.parse(binding)),
  };
}

/** Distribute a union into an intersection — merges each capability's slice into one combined map. */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** This capability's database specs (or `never` when it isn't a `Capability`). */
type DatabasesOf<C> = C extends Capability<infer D, KvNamespaceSpecMap, string, WorkflowSpecMap> ? D : never;

/** This capability's KV namespace specs (or `never` when it isn't a `Capability`). */
type NamespacesOf<C> = C extends Capability<DatabaseSpecMap, infer N, string, WorkflowSpecMap> ? N : never;

/**
 * This capability's jobs as a dispatch-key map: `<capability>/<job>` → that job's parameter type
 * (the schema's **input** side, since the caller supplies pre-parse values). Re-keying here is what
 * lets `trigger` accept a flat, namespaced key while a capability still declares its jobs by bare
 * name.
 */
type WorkflowParamsOf<C> =
  C extends Capability<DatabaseSpecMap, KvNamespaceSpecMap, infer Name, infer W>
    ? { [Job in keyof W & string as `${Name}/${Job}`]: z.input<W[Job]["params"]> }
    : never;

/**
 * Merge a union of per-capability slices into one combined map, clamped to `Bound` so it is always
 * usable: an empty capability set merges to `unknown`, which falls back to the empty map. The
 * intersection unions same-named groups (table union per database, store union per namespace).
 */
type MergeClamped<Slices, Bound> =
  UnionToIntersection<Slices> extends infer Merged ? (Merged extends Bound ? Merged : Record<never, never>) : never;

/** The project-wide databases: every capability's `databases` merged into one map. */
export type MergedDatabases<Caps extends readonly Capability[]> = MergeClamped<
  DatabasesOf<Caps[number]>,
  DatabaseSpecMap
>;

/** The project-wide KV namespaces: every capability's `kvNamespaces` merged into one map. */
export type MergedKvNamespaces<Caps extends readonly Capability[]> = MergeClamped<
  NamespacesOf<Caps[number]>,
  KvNamespaceSpecMap
>;

/**
 * The project-wide workflow parameter map: dispatch key → parameter type, across every composed
 * capability. `createBackend` uses it to type `c.var.workflows.trigger`, so an unregistered key or a
 * payload that does not match the declaring capability's schema is a compile error, not a 500.
 */
export type MergedWorkflowParams<Caps extends readonly Capability[]> = MergeClamped<
  WorkflowParamsOf<Caps[number]>,
  Record<string, unknown>
>;
