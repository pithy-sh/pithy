import type { z } from "zod";
import type { KvStoreSpec } from "../kv/namespaces";

/**
 * The seed contract: the pure, schema-bound shapes a capability (or the app) contributes to
 * `pithy seed`. A capability declares its fixtures as {@link SeedSet}s on `Capability.seeds`;
 * `composeSeeds` merges every capability's sets library-before-app, and the CLI writes them,
 * idempotently and non-destructively, into the environment named by `--env`.
 *
 * Rows and entries are authored as **app-shape values** (the decoded, `z.output` side). The
 * write-time `schema.encode(row)` in `seedD1Group` is the single Zod validation boundary — a bad
 * fixture fails there, before any write. Core defines only the types and the pure write/compose
 * logic; filesystem work (media bytes, UUID write-back) lives in the CLI.
 */

/**
 * An environment name a set may be seeded into (`dev`, `staging`, `production`, or any custom
 * environment). A set lists the environments it is allowed into on {@link SeedSet.environments};
 * `production` is only ever seeded when a set lists it explicitly.
 */
export type SeedEnv = string;

/**
 * One D1 seed group: a batch of app-shape rows for a single table in a single named database.
 * `database` and `table` match the names a capability declares in its `databases` map; the row
 * schema is resolved from the composed databases registry at write time (the fixture never
 * redeclares it). `rows` are `z.output` (app shape) values — re-encoded and validated on write.
 */
export interface D1SeedGroup<Table extends z.ZodType = z.ZodType> {
  /** The named database this table lives in (matches a `databases` key, e.g. "app", "analytics"). */
  database: string;
  /** The table name to seed (the un-prefixed logical name used in query code). */
  table: string;
  /** The rows to insert, as app-shape (`z.output`) values — encoded + validated at write time. */
  rows: readonly z.output<Table>[];
}

/**
 * One KV seed entry: an app-shape key/value (and optional metadata) for a store. The values are
 * the store's input shapes; {@link TypedKv.put} validates each on write.
 */
export interface KvSeedEntry<
  V extends z.ZodType = z.ZodType,
  K extends z.ZodObject = z.ZodObject,
  M extends z.ZodType = z.ZodType,
> {
  /** The structured key segments, validated by the store's key schema. */
  key: z.input<K>;
  /** The value to store, validated by the store's value schema. */
  value: z.input<V>;
  /** Optional metadata, validated by the store's metadata schema. */
  metadata?: z.input<M>;
}

/**
 * One KV seed group: a batch of entries for a single named store within a named namespace.
 * `namespace` and `store` match the names a capability declares in its `kvNamespaces` map.
 */
export interface KvSeedGroup<
  V extends z.ZodType = z.ZodType,
  K extends z.ZodObject = z.ZodObject,
  M extends z.ZodType = z.ZodType,
> {
  /** The named KV namespace this store lives in (matches a `kvNamespaces` key). */
  namespace: string;
  /** The store name within the namespace to seed. */
  store: string;
  /** The entries to write — each validated by the store on put. */
  entries: readonly KvSeedEntry<V, K, M>[];
}

/**
 * One R2 object to seed: raw bytes (or a string) under a key in a bound bucket. R2 has no schema
 * layer, so the payload is opaque; the CLI writes it via the bucket manager for the target env.
 */
export interface R2SeedItem {
  /** The R2 binding name in the Worker env this object lives in. */
  binding: string;
  /** The object key. */
  key: string;
  /** The object bytes, or a string body. */
  body: Uint8Array | string;
  /** The object's content type (e.g. "image/png"). */
  contentType: string;
  /** Optional custom metadata stored alongside the object. */
  metadata?: Record<string, string>;
}

/**
 * One media asset to seed into the shared Cloudflare Images or Stream store. Core defines only the
 * type — the filesystem read (`file`), the upload, and the UUID write-back (`ref`) run in the CLI.
 *
 * `once` (the default) uploads on the first run and records the minted UUID in the `ref` sidecar,
 * so later runs skip the upload and reference the recorded id. `always` re-uploads every run,
 * scoped by metadata, and never writes a UUID back.
 */
export interface MediaSeedItem {
  /** Which shared asset store to upload to. */
  store: "images" | "stream";
  /** Upload policy: `once` (upload + record the UUID) or `always` (re-upload each run). */
  mode: "once" | "always";
  /**
   * Path to the asset bytes. Resolved against the set's {@link SeedSet.baseDir} (the seed module's own
   * directory, set with `import.meta.dirname`), or the project root when the set declares none. Read by
   * the CLI. An absolute path is used as-is.
   */
  file: string;
  /**
   * Path to the JSON sidecar that records the minted UUID (for `once`). Resolved the same way as
   * {@link MediaSeedItem.file} — against the set's {@link SeedSet.baseDir} or the project root.
   * Read/written by the CLI. An absolute path is used as-is.
   */
  ref: string;
  /** Optional custom metadata merged with the standard asset metadata block on upload. */
  metadata?: Record<string, string>;
  /**
   * Optional D1 asset row (in `database`.`table`) that references the minted UUID. Only valid with
   * `mode: "once"`: the row is keyed by the stable, recorded UUID, so an `always` asset — which mints
   * a fresh UUID every run — cannot own a stable record. The CLI rejects `always` + `record`.
   */
  record?: {
    /** The named database the asset row lives in. */
    database: string;
    /** The table the asset row is written to. */
    table: string;
    /** The app-shape row — the CLI fills in the minted UUID before writing it. */
    row: unknown;
  };
}

/**
 * One named, ordered batch of fixtures a capability contributes to `pithy seed`. Sets are composed
 * library-before-app by `order` (like migrations) and each declares the environments it may be
 * seeded into — the first layer of the env-safety model. `production` is seeded only when a set
 * lists it explicitly.
 */
export interface SeedSet {
  /** Stable, unique-per-capability name. Namespaced by capability name when composed. */
  name: string;
  /** Sort order across capabilities (libraries low, app high). Ties break on the namespaced key. */
  order: number;
  /** The environments this set may be seeded into. A set is skipped for any env it does not list. */
  environments: readonly SeedEnv[];
  /**
   * The directory the set's relative media paths (`MediaSeedItem.file` / `.ref`) resolve against —
   * the seed module's own directory, so fixture bytes sit next to the module that declares them.
   * Author it as `baseDir: import.meta.dirname`. When omitted, media paths resolve against the
   * project root instead (a legacy fallback, rarely what you want once a set ships media).
   */
  baseDir?: string;
  /** Whether this is an example/demo set — composed only when the project enables `includeExamples`. */
  example?: boolean;
  /** D1 row groups. */
  d1?: readonly D1SeedGroup[];
  /** KV entry groups. */
  kv?: readonly KvSeedGroup[];
  /** R2 objects. */
  r2?: readonly R2SeedItem[];
  /** Media assets (Images/Stream), uploaded by the CLI. */
  media?: readonly MediaSeedItem[];
}

/**
 * Author a seed set. A pass-through that anchors the {@link SeedSet} type at the author site (the
 * peer of `defineCapability`); the real invariant checks (namespacing, ordering, env filtering)
 * run in `composeSeeds`, and the write-time validation runs in `seedD1Group`. Use {@link d1SeedGroup}
 * and {@link kvSeedGroup} to bind rows/entries to their schemas at compile time.
 */
export function defineSeed(input: SeedSet): SeedSet {
  return input;
}

/**
 * Author a typed D1 seed group. `schema` is a compile-time carrier only — it binds `rows` to the
 * table's `z.output` (app) shape so a mistyped fixture fails to compile; it is not stored on the
 * group (the writer resolves the schema from the composed databases registry). Mirrors
 * `createDatabase`'s type-only `map` argument.
 */
export function d1SeedGroup<Table extends z.ZodType>(
  database: string,
  table: string,
  schema: Table,
  rows: readonly z.output<Table>[],
): D1SeedGroup<Table> {
  void schema; // type-only carrier; see doc comment
  return { database, table, rows };
}

/**
 * Author a typed KV seed group. `spec` is a compile-time carrier only — it binds each entry's
 * `key`/`value`/`metadata` to the store's schemas so a mistyped fixture fails to compile; it is not
 * stored on the group (the writer supplies the live store).
 */
export function kvSeedGroup<V extends z.ZodType, K extends z.ZodObject, M extends z.ZodType>(
  namespace: string,
  store: string,
  spec: KvStoreSpec<V, K, M>,
  entries: readonly KvSeedEntry<V, K, M>[],
): KvSeedGroup<V, K, M> {
  void spec; // type-only carrier; see doc comment
  return { namespace, store, entries };
}
