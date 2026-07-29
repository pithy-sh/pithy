import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import type { CloudflareKVManager } from "@pithy-sh/cloudflare/src/kv/kvManager";
import type { CloudflareImageManager } from "@pithy-sh/cloudflare/src/media/imageManager";
import type { CloudflareStreamManager } from "@pithy-sh/cloudflare/src/media/streamManager";
import { R2Credentials } from "@pithy-sh/cloudflare/src/r2/r2Credentials";
import type { CloudflareR2Manager } from "@pithy-sh/cloudflare/src/r2/r2Manager";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { parse } from "comment-json";
import { Miniflare } from "miniflare";

/**
 * The seed driver resolves each backend a seed set touches to a live handle — the only thing that
 * differs between a local (`dev`) run and a live (`staging`/`production`) one, exactly as the migration
 * driver does for D1. `dev` resolves D1, KV, and R2 from the same Miniflare stores `wrangler dev` uses
 * under `.wrangler/state`; other environments resolve them from `@pithy-sh/cloudflare` REST managers,
 * with ids read from the target env's `wrangler.jsonc` block and credentials from `loadCloudflareEnv`.
 *
 * Images and Stream have no local emulation, so they are **always** remote: the driver builds them from
 * credentials regardless of `--env`, and only when a set actually has media (the clients are lazy, so a
 * `dev` run with no media never needs credentials).
 *
 * Every remote handle is built through an injectable factory seam (mirroring migrate's `remoteD1`), so
 * tests substitute in-memory or faked managers for the network clients.
 */

/** Test seam: build the remote D1 for a binding instead of the default REST-backed client. */
export type RemoteD1Factory = (args: { binding: string; databaseId: string }) => D1Database;

/** Test seam: build the remote KV manager for a binding instead of the default REST-backed client. */
export type RemoteKvFactory = (args: { binding: string; namespaceId: string }) => CloudflareKVManager;

/** Test seam: build the remote R2 manager for a binding instead of the default REST-backed client. */
export type RemoteR2Factory = (args: { binding: string; bucketName: string }) => CloudflareR2Manager;

/** Test seam: build the (always-remote) Images manager instead of the default account client. */
export type ImagesFactory = () => CloudflareImageManager;

/** Test seam: build the (always-remote) Stream manager instead of the default account client. */
export type StreamFactory = () => CloudflareStreamManager;

/**
 * A resolved KV target. Local runs get a live Miniflare {@link KVNamespace} (wrap it in `TypedKv`);
 * remote runs get the REST {@link CloudflareKVManager}, whose surface differs from a binding — the
 * caller writes through it directly. The `kind` tag lets the writer branch without a type assertion.
 */
export type KvSeedTarget =
  | { readonly kind: "local"; readonly namespace: KVNamespace }
  | { readonly kind: "remote"; readonly manager: CloudflareKVManager };

/**
 * A resolved R2 target. Local runs get a live Miniflare {@link R2Bucket}; remote runs get the REST
 * {@link CloudflareR2Manager} (S3-signed uploads). The `kind` tag lets the writer branch without a cast.
 */
export type R2SeedTarget =
  | { readonly kind: "local"; readonly bucket: R2Bucket }
  | { readonly kind: "remote"; readonly manager: CloudflareR2Manager };

/** A resolved set of backends to seed — the only thing that differs between local and remote — plus teardown. */
export interface SeedDriver {
  /** The D1 for a binding (Kysely-wrappable). Local Miniflare store, or the remote REST-backed database. */
  d1(binding: string): D1Database;
  /** The KV target for a binding — a local namespace or the remote manager. */
  kv(binding: string): KvSeedTarget;
  /** The R2 target for a binding — a local bucket or the remote manager. */
  r2(binding: string): R2SeedTarget;
  /** The always-remote Images manager. Built from credentials on first use. */
  images(): CloudflareImageManager;
  /** The always-remote Stream manager. Built from credentials on first use. */
  stream(): CloudflareStreamManager;
  /** Release the driver's resources (the Miniflare instance locally; a no-op remotely). */
  dispose(): Promise<void>;
}

/** Options for {@link openSeedDriver}. */
export interface SeedDriverOptions {
  /**
   * The Worker's directory — its `wrangler.jsonc` supplies the D1/KV/R2 bindings and their ids. Bindings
   * are per-Worker because a Worker's resources are declared on the Worker that uses them.
   */
  workerDir: string;
  /**
   * The project root — the owner of the `.wrangler/state` stores `wrangler dev` uses, and of the one
   * repo-wide `.dev.vars` the remote clients read their credentials from. Persistence is deliberately
   * project-scoped, not Worker-scoped: two Workers that declare the same binding share one local store,
   * which a per-Worker persistence directory would silently split in two.
   */
  persistRoot: string;
  /** Target environment. `dev` resolves locally via Miniflare; other environments resolve over REST. */
  env: string;
  /** Test seam for the remote D1 client. */
  remoteD1?: RemoteD1Factory;
  /** Test seam for the remote KV client. */
  remoteKv?: RemoteKvFactory;
  /** Test seam for the remote R2 client. */
  remoteR2?: RemoteR2Factory;
  /** Test seam for the (always-remote) Images client. */
  images?: ImagesFactory;
  /** Test seam for the (always-remote) Stream client. */
  stream?: StreamFactory;
}

/** One D1 binding entry in wrangler.jsonc. */
interface D1Binding {
  binding: string;
  database_name?: string;
  database_id?: string;
}

/** One KV namespace binding entry in wrangler.jsonc. */
interface KvBinding {
  binding: string;
  id?: string;
}

/** One R2 bucket binding entry in wrangler.jsonc. */
interface R2Binding {
  binding: string;
  bucket_name?: string;
}

/** The bindings block wrangler.jsonc carries at the top level and inside each `env`. */
interface WranglerBindings {
  d1_databases?: D1Binding[];
  kv_namespaces?: KvBinding[];
  r2_buckets?: R2Binding[];
}

/** The wrangler.jsonc slice the seed driver reads: the local (top-level) bindings and each env's bindings. */
interface WranglerSeedConfig extends WranglerBindings {
  env?: Record<string, WranglerBindings | undefined>;
}

/** Read and parse a Worker's wrangler.jsonc (comments allowed). A missing file yields an empty config. */
async function readWranglerConfig(workerDir: string): Promise<WranglerSeedConfig> {
  try {
    const raw = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
    return parse(raw) as unknown as WranglerSeedConfig;
  } catch {
    return {};
  }
}

/**
 * One Worker's backends, by binding, as the **identity of the store each binding resolves to** for an
 * environment — the same fallback chain the drivers themselves use (locally the id, else the name, else
 * the binding; remotely the target env stanza's id). It resolves ids only: no Miniflare instance, no REST
 * client, no credentials.
 *
 * The fan-out needs this before it opens anything. Workers share a resource by declaring the same
 * binding, so the same fixture composed into two Workers normally writes to one store and must run once —
 * but "same binding" is not "same store": two Workers can point one binding at two different databases,
 * a wiring `pithy migrate` supports and migrates separately. Deduping a seed set on its key alone would
 * then skip the second store and report it as already seeded. A binding with no id resolves to its own
 * name, which is exactly what the local driver persists under; remotely the driver raises the real
 * missing-id error at write time.
 */
export interface ResolvedStoreIds {
  /** D1 binding → resolved database identity. */
  d1: Map<string, string>;
  /** KV binding → resolved namespace identity. */
  kv: Map<string, string>;
  /** R2 binding → resolved bucket identity. */
  r2: Map<string, string>;
}

/** Read one Worker's `wrangler.jsonc` and resolve every D1/KV/R2 binding's store identity for `env`. */
export async function resolveStoreIds(options: { workerDir: string; env: string }): Promise<ResolvedStoreIds> {
  const config = await readWranglerConfig(options.workerDir);
  const bindings: WranglerBindings = options.env === "dev" ? config : (config.env?.[options.env] ?? {});

  const ids: ResolvedStoreIds = { d1: new Map(), kv: new Map(), r2: new Map() };
  for (const entry of bindings.d1_databases ?? []) {
    // Locally a store persists under id-else-name-else-binding; remotely only a real `database_id` counts.
    const local = entry.database_id ?? entry.database_name;
    ids.d1.set(entry.binding, (options.env === "dev" ? local : entry.database_id) ?? entry.binding);
  }
  for (const entry of bindings.kv_namespaces ?? []) ids.kv.set(entry.binding, entry.id ?? entry.binding);
  for (const entry of bindings.r2_buckets ?? []) ids.r2.set(entry.binding, entry.bucket_name ?? entry.binding);
  return ids;
}

/** Return the cached handle for `binding`, or an actionable error naming the missing wrangler binding. */
function resolveLocal<T>(cache: Map<string, T>, binding: string, kind: string): T {
  const handle = cache.get(binding);
  if (!handle) {
    throw new ValidationError({
      message: `wrangler.jsonc declares no ${kind} binding "${binding}".`,
      action: `Add the "${binding}" ${kind} binding to wrangler.jsonc. Run pithy seed again.`,
    });
  }
  return handle;
}

/**
 * The local driver: the same D1/KV/R2 stores `wrangler dev` uses, under `.wrangler/state`, via
 * Miniflare. Every top-level binding is resolved up front so the driver's accessors stay synchronous
 * (Miniflare's `get*` are async). Images/Stream are still remote — resolved lazily by `assets`.
 */
async function openLocalDriver(options: SeedDriverOptions, assets: RemoteAssets): Promise<SeedDriver> {
  const config = await readWranglerConfig(options.workerDir);
  const d1Ids: Record<string, string> = {};
  for (const entry of config.d1_databases ?? []) {
    d1Ids[entry.binding] = entry.database_id ?? entry.database_name ?? entry.binding;
  }
  const kvIds: Record<string, string> = {};
  for (const entry of config.kv_namespaces ?? []) kvIds[entry.binding] = entry.id ?? entry.binding;
  const r2Ids: Record<string, string> = {};
  for (const entry of config.r2_buckets ?? []) r2Ids[entry.binding] = entry.bucket_name ?? entry.binding;

  const state = join(options.persistRoot, ".wrangler", "state", "v3");
  const miniflare = new Miniflare({
    modules: true,
    script: "export default {};",
    d1Databases: d1Ids,
    kvNamespaces: kvIds,
    r2Buckets: r2Ids,
    d1Persist: join(state, "d1"),
    kvPersist: join(state, "kv"),
    r2Persist: join(state, "r2"),
  });

  const d1Cache = new Map<string, D1Database>();
  for (const binding of Object.keys(d1Ids)) {
    d1Cache.set(binding, (await miniflare.getD1Database(binding)) as unknown as D1Database);
  }
  const kvCache = new Map<string, KVNamespace>();
  for (const binding of Object.keys(kvIds)) {
    kvCache.set(binding, (await miniflare.getKVNamespace(binding)) as unknown as KVNamespace);
  }
  const r2Cache = new Map<string, R2Bucket>();
  for (const binding of Object.keys(r2Ids)) {
    r2Cache.set(binding, (await miniflare.getR2Bucket(binding)) as unknown as R2Bucket);
  }

  return {
    d1: (binding) => resolveLocal(d1Cache, binding, "D1"),
    kv: (binding) => ({ kind: "local", namespace: resolveLocal(kvCache, binding, "KV") }),
    r2: (binding) => ({ kind: "local", bucket: resolveLocal(r2Cache, binding, "R2") }),
    images: assets.images,
    stream: assets.stream,
    dispose: () => miniflare.dispose(),
  };
}

/** Find one binding's id in a wrangler bindings block, or an actionable error naming the env and binding. */
function remoteId(
  entries: { binding: string }[] | undefined,
  binding: string,
  read: (entry: { binding: string }) => string | undefined,
  env: string,
  kind: string,
  idField: string,
): string {
  const entry = entries?.find((candidate) => candidate.binding === binding);
  const value = entry ? read(entry) : undefined;
  if (!value) {
    throw new ValidationError({
      message: `wrangler.jsonc env.${env} has no ${idField} for the "${binding}" ${kind} binding.`,
      action: `Provision the ${env} ${kind} and set its ${idField} on ${binding}. Run pithy seed --env ${env} again.`,
    });
  }
  return value;
}

/**
 * The remote driver: each backend resolved over REST through `@pithy-sh/cloudflare`. Ids come from the
 * target env's `wrangler.jsonc` block; the REST clients are the only thing that differs from local.
 * Every handle is built through a factory seam (the default wraps the shared, credential-lazy clients),
 * so tests substitute in-memory managers without touching the network or credentials.
 */
function openRemoteDriver(options: SeedDriverOptions, clients: LazyClients, assets: RemoteAssets): SeedDriver {
  const config = clients.config;
  const stanza = (): WranglerBindings => config.env?.[options.env] ?? {};

  const d1: RemoteD1Factory =
    options.remoteD1 ?? (({ databaseId }) => clients.get().d1(databaseId) as unknown as D1Database);
  const kv: RemoteKvFactory = options.remoteKv ?? (({ namespaceId }) => clients.get().kv(namespaceId));
  const r2: RemoteR2Factory =
    options.remoteR2 ?? (({ bucketName }) => clients.get().r2({ bucketName, ...clients.r2Credentials() }));

  return {
    d1: (binding) => {
      const databaseId = remoteId(
        stanza().d1_databases,
        binding,
        (e) => (e as D1Binding).database_id,
        options.env,
        "D1",
        "database_id",
      );
      return d1({ binding, databaseId });
    },
    kv: (binding) => {
      const namespaceId = remoteId(
        stanza().kv_namespaces,
        binding,
        (e) => (e as KvBinding).id,
        options.env,
        "KV",
        "id",
      );
      return { kind: "remote", manager: kv({ binding, namespaceId }) };
    },
    r2: (binding) => {
      const bucketName = remoteId(
        stanza().r2_buckets,
        binding,
        (e) => (e as R2Binding).bucket_name,
        options.env,
        "R2",
        "bucket_name",
      );
      return { kind: "remote", manager: r2({ binding, bucketName }) };
    },
    images: assets.images,
    stream: assets.stream,
    dispose: async () => {},
  };
}

/** A lazily-built, credential-checked {@link CloudflareClients} plus the parsed wrangler config it shares. */
interface LazyClients {
  /** The parsed wrangler.jsonc (read once). */
  config: WranglerSeedConfig;
  /** Build (or return the memoized) clients, failing with an actionable error if credentials are missing. */
  get(): CloudflareClients;
  /** Parse the R2 S3 credential pair from the environment, failing clearly if absent or malformed. */
  r2Credentials(): R2Credentials;
}

/** Build the credential-lazy clients accessor shared by the remote resources and the always-remote assets. */
function lazyClients(persistRoot: string, config: WranglerSeedConfig): LazyClients {
  let clients: CloudflareClients | undefined;
  let vars: Record<string, string> | undefined;
  const env = (): Record<string, string> => {
    vars ??= loadCloudflareEnv(persistRoot);
    return vars;
  };
  return {
    config,
    get() {
      if (clients) return clients;
      const accountId = env().CLOUDFLARE_ACCOUNT_ID ?? "";
      const apiToken = env().CLOUDFLARE_API_TOKEN ?? "";
      if (!accountId || !apiToken) {
        throw new ValidationError({
          message: "Cloudflare credentials are missing.",
          action: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to seed a live environment.",
        });
      }
      clients = new CloudflareClients({ accountId, apiToken });
      return clients;
    },
    r2Credentials() {
      const raw = env().R2_CREDENTIALS;
      if (!raw) {
        throw new ValidationError({
          message: "R2 credentials are missing.",
          action: "Set R2_CREDENTIALS (the S3 access-key/secret-key pair) to seed R2 objects.",
        });
      }
      try {
        return R2Credentials.parse(JSON.parse(raw));
      } catch {
        throw new ValidationError({
          message: "R2_CREDENTIALS is not a valid access-key/secret-key pair.",
          action: "Set R2_CREDENTIALS to a JSON object with accessKeyId and secretAccessKey.",
        });
      }
    },
  };
}

/** The always-remote asset accessors — Images and Stream, built from credentials (or a test seam). */
interface RemoteAssets {
  images: () => CloudflareImageManager;
  stream: () => CloudflareStreamManager;
}

/** Build the always-remote Images/Stream accessors: a test seam if given, else the credential-lazy client. */
function remoteAssets(options: SeedDriverOptions, clients: LazyClients): RemoteAssets {
  return {
    images: options.images ?? (() => clients.get().images()),
    stream: options.stream ?? (() => clients.get().stream()),
  };
}

/**
 * Open the seed driver for a project and environment — the backend-resolution seam behind `pithy seed`.
 * `dev` resolves D1/KV/R2 from local Miniflare stores; other environments resolve them over the REST
 * managers keyed by the env's `wrangler.jsonc` ids. Images and Stream are always remote, built lazily
 * from credentials so a local run with no media never needs them.
 */
export async function openSeedDriver(options: SeedDriverOptions): Promise<SeedDriver> {
  const config = await readWranglerConfig(options.workerDir);
  const clients = lazyClients(options.persistRoot, config);
  const assets = remoteAssets(options, clients);
  return options.env === "dev" ? openLocalDriver(options, assets) : openRemoteDriver(options, clients, assets);
}
