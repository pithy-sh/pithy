import type { KVNamespace } from "@cloudflare/workers-types";
import { uploadImageBytes, uploadStreamBytes } from "@pithy-sh/cloudflare/src/media/assetSeeder";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { composeDatabases, type MergedDatabases } from "@pithy-sh/core/src/data/databases";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import { InternalError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { TypedKv } from "@pithy-sh/core/src/kv/kv";
import { composeKv } from "@pithy-sh/core/src/kv/namespaces";
import type { MediaSeedItem, R2SeedItem } from "@pithy-sh/core/src/seed/seed";
import { seedD1Group } from "@pithy-sh/core/src/seed/writeD1";
import { seedKvGroup } from "@pithy-sh/core/src/seed/writeKv";
import type { ZodType } from "zod";
import type { CliAuditEmit } from "../audit/cliAudit";
import { previewReset, type ResetPreviewEntry, resetProject } from "../migrations/run";
import {
  type ImagesFactory,
  openSeedDriver,
  type R2SeedTarget,
  type RemoteD1Factory,
  type RemoteKvFactory,
  type RemoteR2Factory,
  type SeedDriver,
  type StreamFactory,
} from "./drivers";
import { type MediaFs, type MediaUploader, type SeedMediaResult, seedMediaItem } from "./media";
import { buildDryRunPlan, type SeedPlanMediaAction, type SeedPlanSet } from "./plan";
import { buildSeedPlan } from "./registry";
import { assertResetConfirmed, assertSeedConfirmed, assertSetAllowedForEnv } from "./safety";

/**
 * The orchestrator behind `pithy seed`: compose every capability's seed sets for one environment, pass
 * the layered env-safety gate, then write each set in order — D1 rows (encoded + validated through
 * Kysely with `CamelCasePlugin`), KV entries (validated through the store's `TypedKv`), R2 objects, and
 * media assets (uploaded, with the minted UUID recorded). Every write is idempotent and never
 * destructive: D1 is `INSERT OR IGNORE`, KV `put` is by-key, `once` media skips a recorded upload.
 *
 * The structure mirrors `migrations/run.ts`: one plan, a driver that resolves each backend to a live
 * handle (local Miniflare for `dev`, REST managers otherwise), and injectable factory seams so tests
 * substitute in-memory D1/KV, a fake minter, and a fake filesystem for the network and the disk.
 */

/** Options for {@link seedProject}. */
export interface SeedProjectOptions {
  /** The project's composed capabilities (libraries plus the app). */
  capabilities: Capability[];
  /** The project root — where wrangler.jsonc, .wrangler/ state, and fixture files live. */
  projectDir: string;
  /** Target environment. `dev` runs locally via Miniflare; other environments run over the REST managers. */
  env: string;
  /** Whether `example` sets are composed in (the project's `seed.includeExamples`; default off). */
  includeExamples?: boolean;
  /** Plan only: compute the write plan and read media sidecars, but perform no write and no upload. */
  dryRun?: boolean;
  /**
   * The `--redo` flag: fully reset the schema (every migration's `down`, then every `up`) before
   * seeding, instead of the ordinary non-destructive merge. **Destructive** — every row in every table
   * the migration registry owns is gone, hand-inserted data included, not just what a fixture wrote.
   * Because the schema comes back empty, the normal `INSERT OR IGNORE` / KV skip-if-exists writes just
   * work afterward. Gated by the same escalating confirmation as a plain seed — never weaker.
   */
  redo?: boolean;
  /**
   * The `--confirm-reset` phrase — the non-interactive unlock for a `--redo` schema reset on any non-`dev`
   * environment. Must equal `resetConfirmPhrase(env)` exactly. Stricter than `--yes` on purpose: a reset
   * destroys every row, so the flag that authorizes an additive seed must not also authorize a drop.
   */
  confirmReset?: string;
  /** Interactive confirm seam for the reset phrase (an `@clack/prompts` text prompt). */
  promptReset?: () => Promise<string>;
  /** Audit emitter, so a schema reset is always recorded. Defaults to recording nothing. */
  audit?: CliAuditEmit;
  /** The `--yes` flag — required for any non-`dev` environment (safety layer 2). */
  yes?: boolean;
  /** Non-interactive mode (set by `--json` or CI): no prompt is shown; production needs the confirm flag. */
  json?: boolean;
  /** The `--confirm-production` phrase — the non-interactive unlock for a production seed. */
  confirmProduction?: string;
  /**
   * Environment names the project classifies as production beyond the built-in `production`/`prod`
   * (from `pithy.config.ts` `seed.productionEnvironments`). An env named here requires the hard confirm
   * phrase, not just `--yes`.
   */
  productionEnvironments?: readonly string[];
  /** Interactive confirm seam: prompt for the production phrase (an `@clack/prompts` text prompt). */
  prompt?: () => Promise<string>;
  /** Test seam: build the remote D1 for a binding instead of the default REST-backed client. */
  remoteD1?: RemoteD1Factory;
  /** Test seam: build the remote KV manager for a binding instead of the default REST-backed client. */
  remoteKv?: RemoteKvFactory;
  /** Test seam: build the remote R2 manager for a binding instead of the default REST-backed client. */
  remoteR2?: RemoteR2Factory;
  /** Test seam: build the (always-remote) Images manager instead of the default account client. */
  images?: ImagesFactory;
  /** Test seam: build the (always-remote) Stream manager instead of the default account client. */
  stream?: StreamFactory;
  /** Test seam: the filesystem media seeding reads bytes and writes the UUID sidecar through. */
  mediaFs?: MediaFs;
  /** Test seam: the byte uploader media seeding mints through, overriding the driver-built default. */
  mediaUploader?: MediaUploader;
}

/** The structured outcome of a seed run — the `--json` payload and the source of the human summary. */
export interface SeedRunReport {
  /** The command that produced the report. */
  command: "seed";
  /** The environment seeded. */
  env: string;
  /** Whether this was a dry run (nothing written). */
  dryRun: boolean;
  /** The per-set outcome, in run order. */
  sets: SeedPlanSet[];
  /** Namespaced keys of sets present but disallowed for `env` — surfaced, never silently dropped. */
  skippedByEnv: string[];
  /**
   * Present only when `--redo` was passed: the databases whose schema was (a real run) or would be (a
   * dry run) fully reset — every migration rolled back, then reapplied — before seeding.
   */
  reset?: ResetPreviewEntry[];
}

/** The slice of `CloudflareKVManager` the seed adapter bridges — a read (existence check) and a write. */
interface KvManagerSlice {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { expirationTtl?: number; metadata?: Record<string, unknown> },
  ): Promise<void>;
}

/**
 * Adapt a remote `CloudflareKVManager` to the `KVNamespace` surface `TypedKv` reads and writes through,
 * so both local and remote KV seed through the **same** validated `TypedKv` path. Seeding puts, and
 * reads once per entry for the non-destructive existence check, so `put` (→ `manager.set`) and `get`
 * (→ `manager.get`) are bridged; a list/delete would throw, which never happens here.
 */
function kvNamespaceFromManager(manager: KvManagerSlice): KVNamespace {
  return {
    get: (key: string) => manager.get(key),
    put: (key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }) =>
      manager.set(key, value, {
        ...(options?.expirationTtl !== undefined ? { expirationTtl: options.expirationTtl } : {}),
        ...(options?.metadata !== undefined ? { metadata: options.metadata as Record<string, unknown> } : {}),
      }),
  } as unknown as KVNamespace;
}

/**
 * Whether an R2 object already exists at `key` — used to keep the write non-destructive. Locally a
 * `head` answers directly; remotely a presigned range GET does (200/206 exist, 404 absent). An
 * ambiguous remote status surfaces as an error rather than risking an overwrite.
 */
async function r2ObjectExists(target: R2SeedTarget, key: string): Promise<boolean> {
  if (target.kind === "local") {
    return (await target.bucket.head(key)) !== null;
  }
  const url = await target.manager.createDownloadUrl(key);
  const response = await fetch(url, { method: "GET", headers: { range: "bytes=0-0" } });
  await response.body?.cancel().catch(() => {});
  if (response.status === 404) return false;
  if (response.ok || response.status === 206) return true;
  throw new InternalError({
    message: `Checking the R2 object "${key}" failed.`,
    detail: `Presigned existence GET for "${key}" returned ${response.status}.`,
  });
}

/**
 * Write one R2 object to its resolved target: a local Miniflare bucket, or a remote presigned S3 PUT.
 * Non-destructive: an object that already exists at the key is left untouched (R2's analog of D1's
 * `INSERT OR IGNORE`), so a re-run never overwrites data that shares a key.
 */
async function writeR2Object(target: R2SeedTarget, item: R2SeedItem): Promise<void> {
  if (await r2ObjectExists(target, item.key)) return;

  if (target.kind === "local") {
    await target.bucket.put(item.key, item.body, {
      httpMetadata: { contentType: item.contentType },
      ...(item.metadata !== undefined ? { customMetadata: item.metadata } : {}),
    });
    return;
  }

  // Remote R2 has no in-Worker binding: presign a one-hour PUT and upload the bytes. Custom metadata
  // is not carried by the presigned S3 PUT (a v1 caveat) — the object's content type and bytes land.
  const bytes = typeof item.body === "string" ? new TextEncoder().encode(item.body) : item.body;
  const url = await target.manager.createUploadUrl(item.key, item.contentType, bytes.byteLength);
  const response = await fetch(url, { method: "PUT", headers: { "content-type": item.contentType }, body: bytes });
  if (!response.ok) {
    throw new InternalError({
      message: `Seeding R2 object "${item.key}" failed.`,
      detail: `Presigned PUT for "${item.key}" returned ${response.status}.`,
    });
  }
}

/** The default media uploader: wrap the driver's Images/Stream managers with the seed byte helpers. */
function driverUploader(driver: SeedDriver): MediaUploader {
  return {
    images: (bytes, metadata) => uploadImageBytes(driver.images(), bytes, { metadata }),
    stream: async (bytes, metadata) => ({ id: (await uploadStreamBytes(driver.stream(), bytes, { metadata })).uid }),
  };
}

/** Resolve a database's binding and merged tables, failing with an actionable error if it is undeclared. */
function databaseGroup(
  databases: MergedDatabases,
  database: string,
): { binding: string; items: Record<string, ZodType> } {
  const group = databases[database];
  if (!group) {
    throw new ValidationError({
      message: `Seed targets database "${database}", which no capability declares.`,
      action: `Declare "${database}" (binding and tables) in a capability, or fix the fixture's database name.`,
    });
  }
  return group;
}

/** Resolve a table's Zod schema from the merged databases, failing with an actionable error if absent. */
function tableSchema(items: Record<string, ZodType>, database: string, table: string): ZodType {
  const schema = items[table];
  if (!schema) {
    throw new ValidationError({
      message: `Seed targets table "${table}" in database "${database}", which no capability declares.`,
      action: `Declare "${table}" in the "${database}" database, or fix the fixture's table name.`,
    });
  }
  return schema;
}

/** Write a media item's optional D1 asset row, injecting the minted UUID as the row's `id` when unset. */
async function writeMediaRecord(
  driver: SeedDriver,
  databases: MergedDatabases,
  record: NonNullable<MediaSeedItem["record"]>,
  id: string,
): Promise<void> {
  const group = databaseGroup(databases, record.database);
  const schema = tableSchema(group.items, record.database, record.table);
  const db = createDatabase(driver.d1(group.binding), group.items);
  // Asset tables key on the media UUID: fill in `id` when the fixture row leaves it out.
  const row =
    record.row !== null && typeof record.row === "object" && !("id" in record.row)
      ? { ...(record.row as Record<string, unknown>), id }
      : record.row;
  await seedD1Group(db, { database: record.database, table: record.table, rows: [row] }, schema);
}

/** Read every media item's action from its sidecar (no upload) — the dry-run plan's media state source. */
async function resolveMediaStates(
  sets: ReturnType<typeof buildSeedPlan>["sets"],
  env: string,
  projectDir: string,
  fs: MediaFs | undefined,
): Promise<Map<MediaSeedItem, { action: SeedPlanMediaAction; id?: string }>> {
  const states = new Map<MediaSeedItem, { action: SeedPlanMediaAction; id?: string }>();
  for (const resolved of sets) {
    // Relative media paths resolve against the set's own module dir; the project root is the fallback.
    const baseDir = resolved.set.baseDir ?? projectDir;
    for (const item of resolved.set.media ?? []) {
      const result = await seedMediaItem(item, { env, baseDir, fs, dryRun: true });
      states.set(item, { action: result.action, ...(result.id !== undefined ? { id: result.id } : {}) });
    }
  }
  return states;
}

/**
 * Reject a media item the seeder cannot re-run idempotently: an `always` asset with a D1 `record`.
 * `always` mints a fresh UUID every run, so recording it would inject a new primary key each time and
 * grow the asset table without bound. A recorded asset must be `once` (stable, recorded UUID). Checked
 * before any write so a bad fixture never lands a partial run.
 */
function assertMediaRecordsSupported(sets: ReturnType<typeof buildSeedPlan>["sets"]): void {
  for (const resolved of sets) {
    for (const item of resolved.set.media ?? []) {
      if (item.mode === "always" && item.record) {
        throw new ValidationError({
          message: `Seed set "${resolved.set.name}" has an "always" media asset with a D1 record.`,
          action: 'Use mode "once" for a recorded asset, or drop `record` from the "always" asset.',
        });
      }
    }
  }
}

/** Convert a real media-seed result into its plan entry (store, mode, action, and the id when present). */
function mediaEntry(result: SeedMediaResult): SeedPlanSet["media"][number] {
  return {
    store: result.store,
    mode: result.mode,
    action: result.action,
    ...(result.id !== undefined ? { id: result.id } : {}),
  };
}

/**
 * Seed a project for one environment — compose, gate, and write. A `dryRun` composes the plan and
 * reads each media sidecar to report the action, but touches no backend and needs no credentials. A
 * real run passes the escalating-confirmation gate, opens the driver, and writes every set in order:
 * per set the D1 groups (validated on encode), KV groups (validated on put), R2 objects, and media
 * assets (uploaded once or always, with the minted UUID recorded). The env allowlist is re-asserted
 * per set at write time, so a set can never reach a disallowed environment.
 *
 * `redo` runs a full schema reset (every migration's `down`, then every `up` — {@link resetProject})
 * ahead of the write loop, gated by the exact same confirmation as any other seed. It is not a
 * per-fixture refresh: it destroys and recreates the whole schema the migration registry owns, so the
 * ordinary non-destructive writes that follow simply land fresh — no row-identity logic needed.
 */
export async function seedProject(options: SeedProjectOptions): Promise<SeedRunReport> {
  const { sets, skippedByEnv } = buildSeedPlan(options.capabilities, {
    env: options.env,
    includeExamples: options.includeExamples ?? false,
  });

  // Fail fast, before any write, on a media fixture the seeder cannot re-run idempotently.
  assertMediaRecordsSupported(sets);

  if (options.dryRun) {
    const states = await resolveMediaStates(sets, options.env, options.projectDir, options.mediaFs);
    const plan = buildDryRunPlan(
      options.env,
      sets,
      (item) => states.get(item) ?? { action: item.mode === "always" ? "reupload" : "upload" },
    );
    const reset = options.redo ? await previewReset(options.capabilities) : undefined;
    return {
      command: "seed",
      env: options.env,
      dryRun: true,
      sets: plan.sets,
      skippedByEnv,
      ...(reset ? { reset } : {}),
    };
  }

  await assertSeedConfirmed({
    env: options.env,
    yes: options.yes ?? false,
    json: options.json ?? false,
    confirmProduction: options.confirmProduction,
    productionEnvironments: options.productionEnvironments,
    prompt: options.prompt,
  });

  let reset: ResetPreviewEntry[] | undefined;
  if (options.redo) {
    // A reset destroys every row in every table the registry owns, so it carries its own, stricter gate:
    // `--yes` authorizes an additive seed, never a drop (see `assertResetConfirmed`).
    await assertResetConfirmed({
      env: options.env,
      json: options.json ?? false,
      confirmReset: options.confirmReset,
      prompt: options.promptReset,
    });

    // The numbers reported are the registry's static migration counts — identical before and after a
    // successful reset, so one preview call serves both the report and (implicitly) the operation.
    reset = await previewReset(options.capabilities);

    const audit = options.audit ?? (async () => {});
    // Recorded *before* the drop: if the reset dies partway, the intent and its authorizer are still on
    // record. `critical` off dev — this is the most destructive thing the seeder can do.
    await audit({
      action: "seed/schema_reset",
      outcome: "success",
      severity: options.env === "dev" ? "warning" : "critical",
      resourceType: "schema",
      resourceId: options.env,
      metadata: { databases: reset.map((entry) => entry.database) },
    });

    await resetProject({
      capabilities: options.capabilities,
      projectDir: options.projectDir,
      env: options.env,
      remoteD1: options.remoteD1,
    });
  }

  const driver = await openSeedDriver({
    projectDir: options.projectDir,
    env: options.env,
    remoteD1: options.remoteD1,
    remoteKv: options.remoteKv,
    remoteR2: options.remoteR2,
    images: options.images,
    stream: options.stream,
  });
  try {
    const databases = composeDatabases(options.capabilities);
    const namespaces = composeKv(options.capabilities);
    const uploader = options.mediaUploader ?? driverUploader(driver);
    const reportSets: SeedPlanSet[] = [];

    for (const resolved of sets) {
      // Safety layer 1, re-asserted at the write site: a set can never land in a disallowed env.
      assertSetAllowedForEnv(resolved.set, options.env);
      const setReport: SeedPlanSet = { name: resolved.key, d1: [], kv: [], r2: [], media: [] };

      for (const group of resolved.set.d1 ?? []) {
        const dbGroup = databaseGroup(databases, group.database);
        const schema = tableSchema(dbGroup.items, group.database, group.table);
        const db = createDatabase(driver.d1(dbGroup.binding), dbGroup.items);
        const result = await seedD1Group(db, group, schema);
        setReport.d1.push({ database: group.database, table: result.table, rows: result.rows });
      }

      for (const group of resolved.set.kv ?? []) {
        const nsGroup = namespaces[group.namespace];
        if (!nsGroup) {
          throw new ValidationError({
            message: `Seed targets KV namespace "${group.namespace}", which no capability declares.`,
            action: `Declare "${group.namespace}" in a capability, or fix the fixture's namespace name.`,
          });
        }
        const spec = nsGroup.items[group.store];
        if (!spec) {
          throw new ValidationError({
            message: `Seed targets KV store "${group.store}" in "${group.namespace}", which no capability declares.`,
            action: `Declare the "${group.store}" store, or fix the fixture's store name.`,
          });
        }
        const target = driver.kv(nsGroup.binding);
        const namespace = target.kind === "local" ? target.namespace : kvNamespaceFromManager(target.manager);
        const store = new TypedKv(namespace, spec);
        const result = await seedKvGroup(store, group, spec);
        setReport.kv.push({ namespace: group.namespace, store: result.store, entries: result.entries });
      }

      for (const item of resolved.set.r2 ?? []) {
        await writeR2Object(driver.r2(item.binding), item);
        setReport.r2.push({ binding: item.binding, key: item.key });
      }

      // Relative media paths resolve against the set's own module dir; the project root is the fallback.
      const mediaBaseDir = resolved.set.baseDir ?? options.projectDir;
      for (const item of resolved.set.media ?? []) {
        const result = await seedMediaItem(item, {
          env: options.env,
          baseDir: mediaBaseDir,
          uploader,
          fs: options.mediaFs,
        });
        if (item.record && result.id !== undefined) await writeMediaRecord(driver, databases, item.record, result.id);
        setReport.media.push(mediaEntry(result));
      }

      reportSets.push(setReport);
    }

    return {
      command: "seed",
      env: options.env,
      dryRun: false,
      sets: reportSets,
      skippedByEnv,
      ...(reset ? { reset } : {}),
    };
  } finally {
    await driver.dispose();
  }
}
