import type { Hono } from "hono";
import type { z } from "zod";
import type { AuditEmit } from "../audit/recorder";
import type { DatabaseSpecMap } from "../data/databases";
import type { AuthContext } from "../http/authContext";
import type { KvNamespaceSpecMap } from "../kv/namespaces";
import { BindingSpec, type BindingSpecInput } from "./bindings";

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
}

/** The Hono env. `Bindings` and `Variables` are the base seam; `createBackend` returns a precisely-typed env. */
export type PithyHonoEnv = { Bindings: Record<string, unknown>; Variables: PithyVars };

export type PithyMiddleware = (app: Hono<PithyHonoEnv>) => void;

/** A registered durable job (Cloudflare Workflow) — wired fully in a later phase. */
export interface WorkflowSpec {
  name: string;
  /** The binding name of the Workflow in the Worker env. */
  binding: string;
}

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
> {
  name: string;
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
  /** Durable jobs this capability registers. */
  workflows?: WorkflowSpec[];
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
  /** Bindings this capability needs in the env (normalized — `optional` is always set). */
  requiredBindings: BindingSpec[];
}

/** Authoring shape: `requiredBindings` may omit `optional`; `defineCapability` normalizes them. */
export type CapabilityInput<
  Databases extends DatabaseSpecMap = Record<never, never>,
  Namespaces extends KvNamespaceSpecMap = Record<never, never>,
> = Omit<Capability<Databases, Namespaces>, "requiredBindings"> & {
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
>(input: CapabilityInput<Databases, Namespaces>): Capability<Databases, Namespaces> {
  return {
    ...input,
    requiredBindings: input.requiredBindings.map((binding) => BindingSpec.parse(binding)),
  };
}

/** Distribute a union into an intersection — merges each capability's slice into one combined map. */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** This capability's database specs (or `never` when it isn't a `Capability`). */
type DatabasesOf<C> = C extends Capability<infer D, KvNamespaceSpecMap> ? D : never;

/** This capability's KV namespace specs (or `never` when it isn't a `Capability`). */
type NamespacesOf<C> = C extends Capability<DatabaseSpecMap, infer N> ? N : never;

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
